/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { insertTextIntoChatInputBox } from "@utils/discord";
import { showToast, useEffect, useMemo, useRef, useState } from "@webpack/common";

import {
    bumpUsage, getData, groups, isPinned, nq, rank, rememberTab, resolveTab,
    subscribe, Template, tkey, togglePin
} from "./store";

// ---------------------------------------------------------------- open state shared by button and hotkeys

let open = false;
const openListeners = new Set<() => void>();
export let shownNow: Template[] = [];

export function setOpen(v: boolean) {
    open = v;
    openListeners.forEach(fn => fn());
}
export const isOpen = () => open;

export function useOpen() {
    const [, force] = useState(0);
    useEffect(() => {
        const fn = () => force(x => x + 1);
        openListeners.add(fn);
        return () => void openListeners.delete(fn);
    }, []);
    return open;
}

function useStoreVersion() {
    const [v, setV] = useState(0);
    useEffect(() => subscribe(() => setV(x => x + 1)), []);
    return v;
}

export function insertTemplate(t: Template) {
    bumpUsage(t);
    setOpen(false);
    insertTextIntoChatInputBox(t.text);
}

/** Alt+1…9. Never falls back to another project's set when the tab is unknown. */
export function quickInsert(i: number) {
    let list = shownNow;
    if (!open) {
        const { tab } = resolveTab();
        if (tab === null) {
            showToast("Набор для этого канала не выбран. Открой окно (Ctrl+Alt+T) и выбери вкладку", "failure");
            return;
        }
        list = rank("", tab).items;
    }
    const t = list[i];
    if (!t) return;
    insertTemplate(t);
    showToast("Вставлен: " + t.title, "success");
}

// ---------------------------------------------------------------- UI

function Highlight({ text, tokens }: { text: string; tokens: string[]; }) {
    if (!tokens.length) return <>{text}</>;
    const f = nq(text);
    const marks = new Uint8Array(text.length);
    for (const tok of tokens) {
        for (let i = f.indexOf(tok); i !== -1; i = f.indexOf(tok, i + tok.length)) marks.fill(1, i, i + tok.length);
    }
    const parts: React.ReactNode[] = [];
    for (let i = 0; i < text.length;) {
        let j = i;
        while (j < text.length && marks[j] === marks[i]) j++;
        const seg = text.slice(i, j);
        parts.push(marks[i] ? <mark key={i} className="vc-st-hl">{seg}</mark> : <span key={i}>{seg}</span>);
        i = j;
    }
    return <>{parts}</>;
}

function preview(t: Template) {
    return t.text.replace(/\s+/g, " ").trim().slice(0, 140);
}

export function Picker({ anchor }: { anchor: DOMRect | null; }) {
    useStoreVersion();
    const initial = useMemo(resolveTab, []);
    const [tab, setTabState] = useState<string>(initial.tab ?? "");
    const [unknown, setUnknown] = useState(initial.tab === null);
    const [query, setQuery] = useState("");
    const [sel, setSel] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);

    const { items, tokens, layoutNote } = rank(query, tab);
    shownNow = items;
    const allGroups = groups();

    const setTab = (g: string) => {
        setTabState(g);
        setUnknown(false);
        setSel(0);
        rememberTab(initial.channelId, g);
    };

    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (rootRef.current?.contains(target) || target.closest?.(".vc-st-button")) return;
            setOpen(false);
        };
        document.addEventListener("mousedown", onDown, true);
        return () => document.removeEventListener("mousedown", onDown, true);
    }, []);

    useEffect(() => {
        listRef.current?.querySelector(".vc-st-sel")?.scrollIntoView({ block: "nearest" });
    }, [sel]);

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const n = items.length;
            if (n) setSel(s => (s + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (items[sel]) insertTemplate(items[sel]);
        } else if (e.key === "Tab" && allGroups.length) {
            e.preventDefault();
            const values = ["", ...allGroups];
            const i = Math.max(0, values.indexOf(tab));
            setTab(values[(i + (e.shiftKey ? -1 : 1) + values.length) % values.length]);
        } else if (e.ctrlKey && e.code === "KeyP") {
            e.preventDefault();
            if (items[sel]) togglePin(items[sel]);
        }
    };

    const style: React.CSSProperties = anchor
        ? { right: Math.max(8, window.innerWidth - anchor.right), bottom: window.innerHeight - anchor.top + 8 }
        : { right: 80, bottom: 80 };

    return (
        <div className="vc-st-pop" style={style} ref={rootRef} onKeyDown={onKeyDown}>
            <input
                className="vc-st-search"
                placeholder="Поиск шаблона..."
                autoFocus
                value={query}
                onChange={e => { setQuery(e.currentTarget.value); setSel(0); }}
            />
            {allGroups.length > 0 && (
                <div className="vc-st-tabs">
                    {["", ...allGroups].map(g => (
                        <div key={g || "*"} className={"vc-st-tab" + (g === tab ? " vc-st-tab-on" : "")} onClick={() => setTab(g)}>
                            {g || "Все"}
                        </div>
                    ))}
                </div>
            )}
            {unknown && <div className="vc-st-hint">Набор для этого канала не определён. Выбери вкладку — запомню для канала.</div>}
            {layoutNote && <div className="vc-st-hint">Раскладка: показаны результаты для «{layoutNote}»</div>}
            <div className="vc-st-list" ref={listRef}>
                {!items.length && <div className="vc-st-empty">Ничего не найдено</div>}
                {items.map((t, i) => {
                    const n = getData().usage[tkey(t)]?.n ?? 0;
                    const pinned = isPinned(t);
                    return (
                        <div
                            key={tkey(t)}
                            className={"vc-st-item" + (i === sel ? " vc-st-sel" : "")}
                            onMouseEnter={() => setSel(i)}
                            onClick={() => insertTemplate(t)}
                        >
                            <div className="vc-st-title">
                                <span><Highlight text={t.title} tokens={tokens} /></span>
                                {!tab && t.group && <span className="vc-st-tag">{t.group}</span>}
                                {n > 0 && <span className="vc-st-tag">×{n}</span>}
                                {i < 9 && <span className="vc-st-key">Alt+{i + 1}</span>}
                            </div>
                            <div className="vc-st-prev"><Highlight text={preview(t)} tokens={tokens} /></div>
                            <div
                                className={"vc-st-pin" + (pinned ? " vc-st-pinned" : "")}
                                title={(pinned ? "Открепить" : "Закрепить") + " (Ctrl+P)"}
                                onClick={e => { e.stopPropagation(); togglePin(t); }}
                            >
                                {pinned ? "★" : "☆"}
                            </div>
                        </div>
                    );
                })}
            </div>
            <div className="vc-st-foot">Enter вставить · Alt+1…9 быстро · Ctrl+P закрепить{allGroups.length ? " · Tab набор" : ""}</div>
        </div>
    );
}
