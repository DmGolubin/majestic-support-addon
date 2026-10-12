/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useRef, useState } from "@webpack/common";

import { comboLabel } from "../core/keys";
import { categoriesOf, favoritesOf, orderHits, recentOf, sections } from "../core/rank";
import { search } from "../core/search";
import { ProjectId, PROJECTS, Template } from "../core/types";
import { chatAreaRect } from "../platform";
import { addToCompose, ensureProject, insertTemplate } from "./flow";
import { nqHighlight } from "./highlight";
import { latchKey } from "./keylatch";
import { Preview } from "./Preview";
import { ProjectIcon } from "./ProjectIcon";
import { activeProject, poolFor, store, ui, useStore } from "./uiState";

/** Rows currently visible in the window — Alt+1…9 uses them while the window is open. */
export let visibleItems: Template[] = [];

type View = "all" | "fav" | "recent";
const VIEWS: { key: View; label: string; }[] = [
    { key: "all", label: "Все" },
    { key: "fav", label: "★ Избранное" },
    { key: "recent", label: "Недавние" },
];
const HOVER_MS = 500;

export function Window() {
    useStore();
    const s = ui.use();
    const { project, binding } = activeProject();
    const [query, setQuery] = useState("");
    const [view, setView] = useState<View>("all");
    const [cat, setCat] = useState<string | null>(null);
    const [sel, setSel] = useState(0);
    const [peek, setPeek] = useState(false);
    const [hover, setHover] = useState<{ t: Template; top: number; } | null>(null);
    const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

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
    const favIds = favs.map(t => t.id);
    // Alt+N labels: positional in search/fav/recent, favorites-only in the plain "all" view.
    visibleItems = !res && view === "all" ? favs : items;
    const current = items[Math.min(sel, items.length - 1)];

    useEffect(() => {
        inputRef.current?.focus();
        // Unknown server: ask right away, otherwise the list would be empty.
        if (activeProject().binding === null) void ensureProject();
    }, []);
    useEffect(() => { setSel(0); }, [query, project, view, cat]);
    useEffect(() => { if (cat && !cats.includes(cat)) setCat(null); }, [cats.join("|")]);
    useEffect(() => { listRef.current?.querySelector(".vc-stx-item.sel")?.scrollIntoView({ block: "nearest" }); }, [sel]);
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
        };
    }, []);

    // Switching the project drops the collected reply: its pieces were checked against the old one.
    const pickProject = (p: ProjectId) => { if (p !== project) ui.set({ sessionProject: p, compose: [] }); };

    const startHover = (t: Template, el: HTMLElement) => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(() => setHover({ t, top: el.getBoundingClientRect().top }), HOVER_MS);
    };
    const stopHover = () => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        setHover(null);
    };

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
            if (items.length) setSel(i => (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
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
            const i = VIEWS.findIndex(v => v.key === view);
            setView(VIEWS[(i + (e.shiftKey ? -1 : 1) + VIEWS.length) % VIEWS.length].key);
        } else if (e.ctrlKey && e.code === "KeyD" && current) {
            eat();
            if (e.repeat) return;
            store.toggleFavorite(current.id);
        }
    };

    const rect = chatAreaRect();
    const wide = store.data.previewOpen || peek;
    const width = Math.min(wide ? 820 : 400, (rect?.width ?? 900) - 8);
    const right = rect ? Math.max(8, window.innerWidth - rect.right) : 80;
    const style: React.CSSProperties = rect
        ? { right, bottom: window.innerHeight - rect.top + 8 + (s.compose.length ? 48 : 0), width }
        : { right, bottom: 80, width };

    const row = (t: Template, i: number) => {
        const favIdx = favIds.indexOf(t.id);
        const bind = store.bindFor(t.id);
        const hit = res ? hits[i] : null;
        const altLabel = res || view !== "all" ? (i < 9 ? i + 1 : -1) : (favIdx >= 0 && favIdx < 9 ? favIdx + 1 : -1);
        return (
            <div
                key={t.id}
                className={"vc-stx-item" + (i === sel ? " sel" : "")}
                onMouseEnter={e => { setSel(i); if (!wide) startHover(t, e.currentTarget); }}
                onMouseLeave={stopHover}
                onClick={() => { stopHover(); void insertTemplate(t); }}
                onContextMenu={e => { e.preventDefault(); stopHover(); ui.set({ menu: { x: e.clientX, y: e.clientY, id: t.id } }); }}
            >
                <div className="vc-stx-r">
                    {t.color && <span className="vc-stx-color" style={{ background: t.color }} />}
                    <ProjectIcon project={t.project} />
                    <span className="vc-stx-nm">{nqHighlight(t.title, res?.tokens ?? [])}</span>
                    {t.status !== "actual" && <span className="vc-stx-badge old">{t.status === "outdated" ? "устарел" : "на проверке"}</span>}
                    {bind && <span className="vc-stx-kb">{comboLabel(bind)}</span>}
                    {altLabel > 0 && <span className="vc-stx-kb">Alt {altLabel}</span>}
                </div>
                {hit?.line && <div className="vc-stx-line">{nqHighlight(hit.line, res!.tokens)}</div>}
            </div>
        );
    };

    const empty = !store.templates.length
        ? "Шаблонов нет. Импортируй конфиг в настройках плагина."
        : res ? "Ничего не найдено"
            : view === "fav" ? "В избранном пусто — Ctrl+D или ПКМ → «★ В избранное»"
                : view === "recent" ? "Ещё ничего не вставлялось"
                    : "Шаблонов нет";

    let idx = 0;
    return (
        <>
            <div className="vc-stx-win" style={style} onKeyDown={onKeyDown}>
                <div className="vc-stx-col">
                    <input
                        ref={inputRef}
                        className="vc-stx-search"
                        placeholder="Поиск: название, текст или синоним — «фпс», «снр»…"
                        value={query}
                        onChange={e => setQuery(e.currentTarget.value)}
                    />
                    <div className="vc-stx-proj">
                        {binding === "none"
                            ? (["mj", "ro"] as ProjectId[]).map(p => (
                                <button key={p} className={"vc-stx-tab" + (project === p ? " on" : "")} onClick={() => pickProject(p)}>
                                    <ProjectIcon project={p} size={14} />{PROJECTS[p].short}
                                </button>))
                            : project
                                ? <><ProjectIcon project={project} size={16} /><b>{PROJECTS[project].name}</b><span className="vc-stx-hint">по серверу</span></>
                                : <span className="vc-stx-hint">Проект сервера не определён</span>}
                    </div>
                    <div className="vc-stx-views">
                        {VIEWS.map(v => (
                            <button key={v.key} className={"vc-stx-tab" + (view === v.key ? " on" : "")} onClick={() => setView(v.key)}>{v.label}</button>
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
                    <div className="vc-stx-foot">
                        Enter вставить · Shift — текст · Shift+Enter в ответ · {store.data.previewOpen ? "← скрыть" : "→ закрепить"} текст · Tab вкладки · Ctrl+D ★ · ПКМ меню
                    </div>
                </div>
                {wide && <Preview t={current} />}
            </div>
            {hover && !wide && (
                <div className="vc-stx-tip" style={{ right: right + width + 8, top: Math.max(8, Math.min(hover.top, window.innerHeight - 320)) }}>
                    <Preview t={hover.t} compact />
                </div>
            )}
        </>
    );
}
