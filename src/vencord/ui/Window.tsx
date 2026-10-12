/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "@webpack/common";

import { comboLabel } from "../core/keys";
import { clampTop } from "../core/layout";
import { categoriesOf, favoritesOf, orderHits, recentOf, sections } from "../core/rank";
import { search } from "../core/search";
import { splitGreeting } from "../core/text";
import { ProjectId, PROJECTS, Template } from "../core/types";
import { chatAreaRect } from "../platform";
import { addToCompose, ensureProject, insertTemplate } from "./flow";
import { nqHighlight } from "./highlight";
import { latchKey } from "./keylatch";
import { plural, Preview } from "./Preview";
import { ProjectIcon } from "./ProjectIcon";
import { activeProject, poolFor, store, ui, useStore } from "./uiState";

/** Rows currently visible in the window — Alt+1…9 uses them while the window is open. */
export let visibleItems: Template[] = [];

type View = "all" | "fav" | "recent";
const VIEWS: View[] = ["all", "fav", "recent"];
const HOVER_MS = 500;
/** Hover tooltips stay off until this long after the last scroll event. */
const SCROLL_QUIET_MS = 150;
const NO_TOKENS: string[] = [];
const MAX_H = 500, EDGE = 8, TIP_MAX_H = 320;

/** First meaningful body line after the greeting, markdown chars stripped — the row's muted snippet. */
const snippets = new WeakMap<Template, string>();
function snippetOf(t: Template) {
    let s = snippets.get(t);
    if (s === undefined) {
        s = "";
        for (const line of splitGreeting(t.text).body.split("\n")) {
            const clean = line.replace(/[*_`>#~]/g, "").replace(/\s+/g, " ").trim();
            if (/[\p{L}\p{N}]/u.test(clean)) { s = clean; break; }
        }
        snippets.set(t, s);
    }
    return s;
}

interface RowProps {
    t: Template;
    sel: boolean;
    /** Alt+N label, 0 = none. */
    alt: number;
    bind: string | undefined;
    icon: boolean;
    tokens: string[];
    line: string | null;
    onHover: ((t: Template, el: HTMLElement) => void) | null;
    onLeave: () => void;
}

function RowImpl({ t, sel, alt, bind, icon, tokens, line, onHover, onLeave }: RowProps) {
    return (
        <div
            className={"vc-stx-it" + (sel ? " sel" : "")}
            onMouseEnter={onHover ? e => onHover(t, e.currentTarget) : undefined}
            onMouseLeave={onLeave}
            onClick={() => { onLeave(); void insertTemplate(t); }}
            onContextMenu={e => { e.preventDefault(); onLeave(); ui.set({ menu: { x: e.clientX, y: e.clientY, id: t.id } }); }}
        >
            <div className="vc-stx-r">
                {t.color && <span className="vc-stx-color" style={{ background: t.color }} />}
                {icon && <ProjectIcon project={t.project} />}
                <span className="vc-stx-nm">{nqHighlight(t.title, tokens)}</span>
                {t.status !== "actual" && <span className="vc-stx-badge old">{t.status === "outdated" ? "устарел" : "на проверке"}</span>}
                {bind && <span className="vc-stx-kb">{comboLabel(bind)}</span>}
                {alt > 0 && <span className="vc-stx-kb">Alt {alt}</span>}
            </div>
            <div className="vc-stx-sn">{line ? nqHighlight(line, tokens) : snippetOf(t)}</div>
        </div>
    );
}

// React from @webpack/common is only ready after Discord loaded: build the memo on first render.
let MemoRow: React.ComponentType<RowProps> | null = null;
const getRow = () => MemoRow ??= React.memo(RowImpl);

export function Window() {
    const version = useStore();
    const composeLen = ui.useSelect(s => s.compose.length);
    const hasCompose = composeLen > 0;
    const dialogOpen = ui.useSelect(s => s.dialog !== null);
    ui.useSelect(s => s.sessionProject); // activeProject() reads it
    const { project, binding } = activeProject();
    const [query, setQuery] = useState("");
    const [view, setView] = useState<View>("all");
    const [cat, setCat] = useState<string | null>(null);
    const [sel, setSel] = useState(0);
    const [peek, setPeek] = useState(false);
    const [hover, setHover] = useState<{ t: Template; top: number; } | null>(null);
    const [rect, setRect] = useState<DOMRect | null>(chatAreaRect);
    const [tipH, setTipH] = useState(0);
    const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scrolling = useRef(false);
    const hoverShown = useRef(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const winRef = useRef<HTMLDivElement>(null);
    const tipRef = useRef<HTMLDivElement>(null);

    const data = useMemo(() => {
        const ctx = store.ctx();
        const projectPool = poolFor(project);
        const cats = categoriesOf(projectPool);
        const pool = cat ? projectPool.filter(t => t.category === cat) : projectPool;
        const res = query.trim() ? search(pool, query) : null;
        const hits = res ? orderHits(res.hits, ctx) : [];
        const secs = !res && view === "all" ? sections(pool, ctx) : [];
        const favs = favoritesOf(pool, ctx);
        const items: Template[] = res
            ? hits.map(h => h.t)
            : view === "fav" ? favs
                : view === "recent" ? recentOf(pool, ctx, 10)
                    : secs.flatMap(x => x.items);
        // Alt+N labels: positional in search/fav/recent, favorites-only in the plain "all" view.
        const positional = !!res || view !== "all";
        const alt = (t: Template, i: number) => {
            const n = positional ? i : favs.indexOf(t);
            return n >= 0 && n < 9 ? n + 1 : 0;
        };
        const lines = new Map(hits.map(h => [h.t, h.line]));
        return { total: projectPool.length, cats, res, secs, favs, items, positional, alt, lines, tokens: res?.tokens ?? NO_TOKENS };
    }, [query, project, view, cat, version]);
    const { cats, res, secs, favs, items } = data;

    visibleItems = data.positional ? items : favs;
    const selIdx = Math.min(sel, Math.max(0, items.length - 1));
    const current = items[selIdx];

    useEffect(() => {
        inputRef.current?.focus();
        // Unknown server: ask right away, otherwise the list would be empty.
        if (activeProject().binding === null) void ensureProject();
        const onResize = () => setRect(chatAreaRect());
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);
    // All window keys (↑↓, Enter, Shift-peek) are the window's onKeyDown: they need focus inside it.
    // A dialog that closes, or a "+ в ответ" from a button, leaves focus on <body> — take it back.
    useEffect(() => {
        if (!dialogOpen && !winRef.current?.contains(document.activeElement)) inputRef.current?.focus();
    }, [dialogOpen, composeLen]);
    useEffect(() => { setSel(0); }, [query, project, view, cat]);
    useEffect(() => { if (cat && !cats.includes(cat)) setCat(null); }, [cats.join("|")]);
    useEffect(() => { listRef.current?.querySelector(".vc-stx-it.sel")?.scrollIntoView({ block: "nearest" }); }, [sel]);
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            const el = e.target as HTMLElement;
            if (el.closest?.(".vc-stx-win, .vc-stx-menu, .vc-stx-dialog, [data-stx=button], .vc-stx-backdrop")) return;
            ui.set({ windowOpen: false });
        };
        // Shift held = temporary full-text preview; released anywhere = hide.
        const onUp = (e: KeyboardEvent) => { if (e.key === "Shift") setPeek(false); };
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keyup", onUp, true);
        return () => {
            document.removeEventListener("mousedown", onDown, true);
            document.removeEventListener("keyup", onUp, true);
            if (hoverTimer.current) clearTimeout(hoverTimer.current);
            if (scrollTimer.current) clearTimeout(scrollTimer.current);
        };
    }, []);

    // Scrolling moves rows under a still cursor: their mouseenter must not start tooltips (scroll lag).
    // Refs only — no React render per scroll event; at most one setHover(null) when a tooltip is up.
    useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        const onScroll = () => {
            scrolling.current = true;
            if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
            if (hoverShown.current) { hoverShown.current = false; setHover(null); }
            if (scrollTimer.current) clearTimeout(scrollTimer.current);
            scrollTimer.current = setTimeout(() => { scrolling.current = false; scrollTimer.current = null; }, SCROLL_QUIET_MS);
        };
        list.addEventListener("scroll", onScroll, { passive: true });
        return () => list.removeEventListener("scroll", onScroll);
    }, []);

    // Switching the project drops the collected reply: its pieces were checked against the old one.
    const pickProject = (p: ProjectId) => { if (p !== project) ui.set({ sessionProject: p, compose: [] }); };

    // Stable callbacks: memoized rows must not re-render because of new handler identities.
    const startHover = useCallback((t: Template, el: HTMLElement) => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
        if (scrolling.current) return;
        hoverTimer.current = setTimeout(() => {
            hoverTimer.current = null;
            if (scrolling.current) return;
            hoverShown.current = true;
            setHover({ t, top: el.getBoundingClientRect().top });
        }, HOVER_MS);
    }, []);
    const stopHover = useCallback(() => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
        if (!hoverShown.current) return; // no tooltip: nothing to hide, no re-render
        hoverShown.current = false;
        setHover(null);
    }, []);

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const input = inputRef.current;
        const atEnd = !!input && input.selectionStart === input.value.length;
        const atStart = !!input && input.selectionEnd === 0;
        const eat = () => { e.preventDefault(); e.stopPropagation(); };
        if (e.key === "Shift") {
            if (!e.repeat) setPeek(true);
        } else if (e.key === "Escape") {
            eat();
            if (query) setQuery(""); else ui.set({ windowOpen: false });
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            eat();
            if (items.length) setSel(i => (Math.min(i, items.length - 1) + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
        } else if (e.key === "Enter" && current) {
            eat();
            if (e.repeat) return;
            latchKey(e.nativeEvent.code);
            if (e.shiftKey) void addToCompose(current); else void insertTemplate(current);
        } else if (e.key === "ArrowRight" && atEnd && !store.data.previewOpen) {
            eat();
            store.setPreviewOpen(true);
        } else if (e.key === "ArrowLeft" && atStart && store.data.previewOpen) {
            eat();
            store.setPreviewOpen(false);
        } else if (e.key === "Tab") {
            eat();
            const i = VIEWS.indexOf(view);
            setView(VIEWS[(i + (e.shiftKey ? -1 : 1) + VIEWS.length) % VIEWS.length]);
        } else if (e.ctrlKey && e.code === "KeyD" && current) {
            eat();
            if (e.repeat) return;
            store.toggleFavorite(current.id);
        }
    };

    const wide = store.data.previewOpen || peek;
    const avail = (rect?.width ?? 900) - 16;
    const width = Math.max(0, Math.min(wide ? 820 : 360, avail));
    const right = rect ? Math.max(EDGE, window.innerWidth - rect.right) : 80;
    const bottom = rect ? window.innerHeight - rect.top + EDGE + (hasCompose ? 48 : 0) : 80;
    const height = Math.max(200, Math.min(MAX_H, window.innerHeight - bottom - EDGE));
    const style: React.CSSProperties = { right, bottom, width, height };

    // Hover tooltip: inside the window's vertical range, never over the compose bar / chat input below it.
    const winBottom = window.innerHeight - bottom, winTop = winBottom - height;
    const tipMaxH = Math.min(TIP_MAX_H, height);
    useLayoutEffect(() => {
        const h = tipRef.current?.offsetHeight ?? 0;
        if (h && h !== tipH) setTipH(h); // measured before paint: no visible jump
    }, [hover, tipMaxH]);

    const Row = getRow();
    const onHover = wide ? null : startHover;
    const row = (t: Template, i: number) => (
        <Row
            key={t.id}
            t={t}
            sel={i === selIdx}
            alt={data.alt(t, i)}
            bind={store.bindFor(t.id)}
            icon={binding === "none" || !t.project}
            tokens={data.tokens}
            line={data.lines.get(t) ?? null}
            onHover={onHover}
            onLeave={stopHover}
        />
    );

    const empty = !store.templates.length
        ? "Шаблонов нет. Импортируй конфиг в настройках плагина."
        : res ? "Ничего не найдено"
            : view === "fav" ? "В избранном пусто — Ctrl+D или ПКМ → «★ В избранное»"
                : view === "recent" ? "Ещё ничего не вставлялось"
                    : "Шаблонов нет";
    const count = project ? <span className="vc-stx-n">{data.total} {plural(data.total, "шаблон", "шаблона", "шаблонов")}</span> : null;

    let idx = 0;
    return (
        <>
            <div
                className="vc-stx-win" ref={winRef} style={style} onKeyDown={onKeyDown}
                // Rows and buttons never take focus: it stays in the search input, so the keys keep working
                // even when the clicked element unmounts (a Preview button once Shift is released).
                onMouseDown={e => { if ((e.target as HTMLElement).closest("button, .vc-stx-it")) e.preventDefault(); }}
            >
                {/* Preview LEFT of the list: the window is right-anchored, so the list never moves when it opens. */}
                {wide && <Preview t={current} />}
                <div className="vc-stx-col">
                    <div className="vc-stx-head">
                        <label className="vc-stx-search">
                            <span className="vc-stx-sicon">⌕</span>
                            <input
                                ref={inputRef}
                                className="vc-stx-sinput"
                                placeholder="Поиск: название, текст или «снр», «фпс»…"
                                value={query}
                                onChange={e => setQuery(e.currentTarget.value)}
                            />
                        </label>
                        <div className="vc-stx-proj">
                            {binding === "none"
                                ? <>{(["mj", "ro"] as ProjectId[]).map(p => (
                                    <button key={p} className={"vc-stx-pbtn" + (project === p ? " on" : "")} onClick={() => pickProject(p)}>
                                        <ProjectIcon project={p} size={14} />{PROJECTS[p].short}
                                    </button>))}{count}</>
                                : project
                                    ? <><ProjectIcon project={project} size={18} /><b>{PROJECTS[project].name}</b>{count}</>
                                    : <span className="vc-stx-hint">Проект сервера не определён</span>}
                        </div>
                        <div className="vc-stx-tabs">
                            {VIEWS.map(v => (
                                <button key={v} className={"vc-stx-tab" + (view === v ? " on" : "")} onClick={() => setView(v)}>
                                    {v === "all" ? "Все" : v === "fav" ? <>★ Избранное<i>{favs.length}</i></> : "Недавние"}
                                </button>
                            ))}
                        </div>
                        {cats.length >= 2 && (
                            <div className="vc-stx-chips">
                                {cats.map(c => (
                                    <button key={c} className={"vc-stx-chipf" + (cat === c ? " on" : "")} onClick={() => setCat(cat === c ? null : c)}>{c}</button>
                                ))}
                            </div>
                        )}
                        {res?.layout && <div className="vc-stx-hint">Раскладка: показаны результаты для «{res.layout}»</div>}
                        {res?.fuzzy && <div className="vc-stx-hint">Точных совпадений нет — похожие</div>}
                    </div>
                    <div className="vc-stx-list" ref={listRef}>
                        {!items.length && <div className="vc-stx-empty">{empty}</div>}
                        {res || view !== "all"
                            ? items.map((t, i) => row(t, i))
                            : secs.map(sec => (
                                <div key={sec.key}>
                                    <div className="vc-stx-sec">{sec.title}</div>
                                    {sec.items.map(t => row(t, idx++))}
                                </div>))}
                    </div>
                    <div className="vc-stx-foot" title={"Enter — вставить · Shift+Enter — в ответ · Shift (держать) — текст · → / ← — открыть / скрыть текст слева · Tab — вкладки · Ctrl+D — избранное · ПКМ — меню"}>
                        <span><span className="vc-stx-kb">↵</span>вставить</span>
                        <span><span className="vc-stx-kb">⇧↵</span>в ответ</span>
                        <span><span className="vc-stx-kb">Tab</span>вкладки</span>
                        <span><span className="vc-stx-kb">ПКМ</span>ещё</span>
                    </div>
                </div>
            </div>
            {hover && !wide && (
                <div
                    className="vc-stx-tip" ref={tipRef}
                    style={{ right: right + width + EDGE, top: clampTop(hover.top, winTop, winBottom, tipH || tipMaxH), maxHeight: tipMaxH }}
                >
                    <Preview key={hover.t.id} t={hover.t} compact />{/* key: remount so the fade check runs per template */}
                </div>
            )}
        </>
    );
}
