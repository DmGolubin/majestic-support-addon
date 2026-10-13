/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "@webpack/common";

import { comboLabel, startsPeek } from "../core/keys";
import { clampTop, EDGE, tipWidth, windowLayout } from "../core/layout";
import { categoriesOf, favoritesOf, orderHits, recentOf, sections } from "../core/rank";
import { search } from "../core/search";
import { splitGreeting } from "../core/text";
import { PROJECTS, Template } from "../core/types";
import { chatAreaRect } from "../platform";
import { costEnd, costStart, debugEnabled, debugState, debugVerbose, dlog, keyDesc, logGeometry, noteKey, noteRender, noteSearch, noteWheel, setDebugHover, setDebugWindow } from "./debug";
import { addToCompose, insertTemplate } from "./flow";
import { nqHighlight } from "./highlight";
import { latchKey } from "./keylatch";
import { plural, Preview } from "./Preview";
import { ProjectIcon } from "./ProjectIcon";
import { IconEnter, IconSearch, IconShift, IconStar } from "./svg";
import { activeScope, listedProject, pickTechProject, poolFor, store, ui, useStore } from "./uiState";

/** Rows currently visible in the window — Alt+1…9 uses them while the window is open. */
export let visibleItems: Template[] = [];

type View = "all" | "fav" | "recent";
const VIEWS: View[] = ["all", "fav", "recent"];
const HOVER_MS = 500;
/** Hover tooltips stay off until this long after the last scroll event. */
const SCROLL_QUIET_MS = 150;
const NO_TOKENS: string[] = [];
const MAX_H = 500, TIP_MAX_H = 320;

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
    /** Mouse entered the row: remembers it as hovered, may start the tooltip timer. */
    onHover: (t: Template, el: HTMLElement) => void;
    /** Real mouse movement over the row: remembers it as hovered (after keyboard navigation cleared it). */
    onMove: (t: Template, e: React.MouseEvent) => void;
    /** Mouse left the row: forgets it, hides the tooltip. */
    onLeave: () => void;
    /** Hides the tooltip only (click, context menu). */
    onHide: () => void;
}

function RowImpl({ t, sel, alt, bind, icon, tokens, line, onHover, onMove, onLeave, onHide }: RowProps) {
    return (
        <div
            className={"vc-stx-it" + (sel ? " sel" : "")}
            onMouseEnter={e => onHover(t, e.currentTarget)}
            onMouseMove={e => onMove(t, e)}
            onMouseLeave={onLeave}
            onClick={() => { onHide(); void insertTemplate(t, { via: "window-click" }); }}
            onContextMenu={e => { e.preventDefault(); onHide(); ui.set({ menu: { x: e.clientX, y: e.clientY, id: t.id } }); }}
        >
            <div className="vc-stx-r">
                {t.color && <span className="vc-stx-color" style={{ background: t.color }} />}
                {icon && <ProjectIcon project={t.project} />}
                <span className="vc-stx-nm">{nqHighlight(t.title, tokens)}</span>
                {t.status !== "actual" && <span className={"vc-stx-badge " + t.status}>{t.status === "outdated" ? "устарел" : "на проверке"}</span>}
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

/** The template window; its render (the component body) is a `render` cost span while debug is on. */
export function Window() {
    const t0 = costStart();
    try { return WindowView(); } finally { costEnd("render", t0); }
}

function WindowView() {
    const version = useStore();
    const composeLen = ui.useSelect(s => s.compose.length);
    const hasCompose = composeLen > 0;
    const dialogOpen = ui.useSelect(s => s.dialog !== null);
    const debugOn = debugState.useSelect(s => s.on);
    if (debugVerbose()) noteRender();
    const scope = activeScope();
    /** The project the list shows: the server's, on Tech the switch's. */
    const listed = listedProject(scope);
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
    /** Id of the row under the mouse — a ref: hovering never re-renders (Shift peeks this row). */
    const hoveredId = useRef<string | null>(null);
    /** Mirrors `wide` for the stable hover callbacks: no tooltips while the preview shows. */
    const wideRef = useRef(false);
    /** Mirrors "the tooltip has room left of the window" for the stable hover callbacks. */
    const tipRoomRef = useRef(true);
    const peekRef = useRef(false);
    const compactRef = useRef(false);
    /** Pointer is over the window: Shift peeks even when focus fell to <body> (a click on a non-focusable part). */
    const pointerIn = useRef(false);
    /** Mirrors of the rendered list for the document-level Shift handler. */
    const itemsRef = useRef<Template[]>([]);
    const selIdxRef = useRef(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const winRef = useRef<HTMLDivElement>(null);
    const tipRef = useRef<HTMLDivElement>(null);

    const data = useMemo(() => {
        const t0 = debugEnabled() ? performance.now() : 0;
        const ctx = store.ctx();
        const projectPool = poolFor(scope);
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
        if (t0) noteSearch(t0, performance.now(), query, items.length);
        return { total: projectPool.length, cats, res, secs, favs, items, positional, alt, lines, tokens: res?.tokens ?? NO_TOKENS };
    }, [query, scope, listed, view, cat, version]);
    const { cats, res, secs, favs, items } = data;

    visibleItems = data.positional ? items : favs;
    const selIdx = Math.min(sel, Math.max(0, items.length - 1));
    const current = items[selIdx];
    itemsRef.current = items;
    selIdxRef.current = selIdx;

    useEffect(() => {
        inputRef.current?.focus();
        const onResize = () => setRect(chatAreaRect());
        window.addEventListener("resize", onResize);
        logGeometry("окно открыто");
        return () => {
            window.removeEventListener("resize", onResize);
            logGeometry("окно закрыто");
        };
    }, []);
    // The window keys (arrows, Enter, Tab) are the window's onKeyDown: they need focus inside it.
    // A dialog that closes, or a "+ в ответ" from a button, leaves focus on <body> — take it back.
    useEffect(() => {
        if (!dialogOpen && !winRef.current?.contains(document.activeElement)) inputRef.current?.focus();
    }, [dialogOpen, composeLen]);
    useEffect(() => {
        setSel(0);
        // The list changed under a still cursor: the remembered row may no longer be under it.
        hoveredId.current = null;
        setDebugHover(null);
        stopHover();
    }, [query, scope, listed, view, cat]);
    useEffect(() => { if (cat && !cats.includes(cat)) setCat(null); }, [cats.join("|")]);
    useEffect(() => {
        listRef.current?.querySelector(".vc-stx-it.sel")?.scrollIntoView({ block: "nearest" });
        if (debugEnabled()) dlog("sel", { idx: selIdx, id: current?.id, title: current?.title }, "sel");
    }, [sel]);
    // Debug panel: the window's local state after every render (only while debug is on), cleared on close.
    useEffect(() => {
        if (debugOn) setDebugWindow({ peek, view, cat, query, selIdx, selId: current?.id ?? null, hoveredId: hoveredId.current, layout: lay.mode, winW: lay.width, previewW: lay.previewW, avail: lay.avail, tipW });
    });
    useEffect(() => () => setDebugWindow(null), []);
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            const el = e.target as HTMLElement;
            if (el.closest?.(".vc-stx-win, .vc-stx-menu, .vc-stx-dialog, [data-stx=button], .vc-stx-backdrop, .vc-stx-debug")) return;
            ui.set({ windowOpen: false });
        };
        // Shift held = temporary full-text preview; released anywhere (or the app losing focus) = hide.
        // Document level, not the window's onKeyDown: a click on a non-focusable part of the window (tab
        // strip, header, scrollbar) drops focus to <body>, and then the window never saw Shift (Task 20).
        // Peek is visual only: Shift is never prevented, so Discord still gets it.
        const onShift = (e: KeyboardEvent) => {
            const focusIn = !!winRef.current?.contains(document.activeElement);
            if (!startsPeek(e, focusIn, pointerIn.current)) return;
            noteKey(e, "window: peek");
            // Peek the row under the mouse when there is one (it becomes the selection), else the keyboard one.
            const items = itemsRef.current, selIdx = selIdxRef.current;
            const hi = hoveredId.current ? items.findIndex(t => t.id === hoveredId.current) : -1;
            if (hi >= 0 && hi !== selIdx) setSel(hi);
            stopHover();
            setPeek(true);
            if (debugEnabled()) {
                const target = items[hi >= 0 ? hi : selIdx];
                dlog("peek", { on: true, from: hi >= 0 ? "мышь" : "выделение", focus: focusIn ? "окно" : "вне окна", id: target?.id, title: target?.title });
            }
        };
        const hide = () => {
            if (peekRef.current) dlog("peek", { on: false });
            setPeek(false);
        };
        const onUp = (e: KeyboardEvent) => { if (e.key === "Shift") hide(); };
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onShift, true);
        document.addEventListener("keyup", onUp, true);
        window.addEventListener("blur", hide);
        return () => {
            document.removeEventListener("mousedown", onDown, true);
            document.removeEventListener("keydown", onShift, true);
            document.removeEventListener("keyup", onUp, true);
            window.removeEventListener("blur", hide);
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
            hoveredId.current = null; // rows move under the cursor: the next real mouse event says which one
            setDebugHover(null);
            if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
            if (hoverShown.current) { hoverShown.current = false; setHover(null); }
            if (scrollTimer.current) clearTimeout(scrollTimer.current);
            scrollTimer.current = setTimeout(() => { scrolling.current = false; scrollTimer.current = null; }, SCROLL_QUIET_MS);
        };
        list.addEventListener("scroll", onScroll, { passive: true });
        return () => list.removeEventListener("scroll", onScroll);
    }, []);

    // Shift + wheel anywhere over the window scrolls the full text vertically. Chromium turns Shift+wheel
    // into a horizontal scroll (deltaX), which the preview body does not have, and the cursor is usually
    // over the list. Without Shift (or with no preview shown) the wheel stays native. No render per event.
    useEffect(() => {
        const win = winRef.current;
        if (!win) return;
        const onWheel = (e: WheelEvent) => {
            if (!e.shiftKey || e.ctrlKey || e.metaKey || !wideRef.current) return; // Ctrl+Shift+wheel = zoom
            const body = win.querySelector<HTMLElement>(":scope > .vc-stx-pre .vc-stx-body");
            if (!body) return;
            let dy = e.deltaY || e.deltaX;
            if (e.deltaMode === 1) dy *= 16; // lines
            else if (e.deltaMode === 2) dy *= body.clientHeight; // pages
            // Nothing to scroll that way (no overflow, already at the edge): leave the event native.
            const max = body.scrollHeight - body.clientHeight;
            if (max <= 0 || (dy < 0 && body.scrollTop <= 0) || (dy > 0 && body.scrollTop >= max - 1) || !dy) return;
            body.scrollTop += dy;
            e.preventDefault();
            noteWheel(body.scrollTop); // verbose debug only (a null check otherwise)
        };
        win.addEventListener("wheel", onWheel, { passive: false });
        return () => win.removeEventListener("wheel", onWheel);
    }, []);

    // Stable callbacks: memoized rows must not re-render because of new handler identities.
    const startHover = useCallback((t: Template, el: HTMLElement) => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
        if (scrolling.current) return;
        hoveredId.current = t.id;
        if (debugEnabled()) { setDebugHover(t.id); dlog("hover", { id: t.id, title: t.title }, "hover"); }
        if (wideRef.current || !tipRoomRef.current) return; // the preview is shown / no room: no tooltip
        hoverTimer.current = setTimeout(() => {
            hoverTimer.current = null;
            if (scrolling.current || wideRef.current || !tipRoomRef.current) return;
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
    const moveHover = useCallback((t: Template, e: React.MouseEvent) => {
        // Synthetic moves (scroll, layout) have no movement: only a real one marks the row as hovered.
        if (hoveredId.current === t.id || !(e.movementX || e.movementY)) return;
        hoveredId.current = t.id;
        if (debugEnabled()) { setDebugHover(t.id); dlog("hover", { id: t.id, title: t.title, by: "move" }, "hover"); }
    }, []);
    const leaveHover = useCallback(() => {
        hoveredId.current = null;
        setDebugHover(null);
        stopHover();
    }, []);

    /** «← назад» in compact mode: hides the pinned preview (and a Shift peek). */
    const back = () => {
        dlog("key", { h: "window", what: "скрыть превью (назад)" });
        setPeek(false);
        store.setPreviewOpen(false);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const input = inputRef.current;
        const atEnd = !!input && input.selectionStart === input.value.length;
        const atStart = !!input && input.selectionEnd === 0;
        const eat = () => { e.preventDefault(); e.stopPropagation(); };
        const log = (what: string, data: Record<string, unknown> = {}) => {
            noteKey(e, "window: " + what);
            if (debugEnabled()) dlog("key", { h: "window", key: keyDesc(e), what, ...data }, "win:" + keyDesc(e) + what);
        };
        // Shift alone (peek) is handled at document level, see onShift.
        if (e.key === "Escape") {
            eat();
            log(query ? "очистить запрос" : "закрыть окно");
            if (query) setQuery(""); else ui.set({ windowOpen: false });
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            eat();
            hoveredId.current = null; // the keyboard took over: Shift peeks the keyboard selection until the mouse moves
            setDebugHover(null);
            log("выделение");
            if (items.length) setSel(i => (Math.min(i, items.length - 1) + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
        } else if (e.key === "Enter" && current) {
            eat();
            log(e.shiftKey ? "в ответ" : "вставить", { id: current.id, title: current.title });
            if (e.repeat) return;
            latchKey(e.nativeEvent.code);
            if (e.shiftKey) void addToCompose(current); else void insertTemplate(current, { via: "window-enter" });
        } else if (e.key === "ArrowRight" && atEnd && !store.data.previewOpen) {
            eat();
            log("открыть превью");
            store.setPreviewOpen(true);
        } else if (e.key === "ArrowLeft" && (atStart || compactRef.current) && store.data.previewOpen) {
            // Compact: the preview covers the search input, so ← goes back wherever the caret is.
            eat();
            log("скрыть превью");
            store.setPreviewOpen(false);
        } else if (e.key === "Tab") {
            eat();
            log("вкладка");
            const i = VIEWS.indexOf(view);
            setView(VIEWS[(i + (e.shiftKey ? -1 : 1) + VIEWS.length) % VIEWS.length]);
        } else if (e.ctrlKey && e.code === "KeyD" && current) {
            eat();
            log("избранное", { id: current.id });
            if (e.repeat) return;
            store.toggleFavorite(current.id);
        }
    };

    const wide = store.data.previewOpen || peek;
    wideRef.current = wide;
    peekRef.current = peek;
    // Viewport-bound, right-anchored at the chat input's right edge (rect / innerWidth change → resize re-render).
    const vw = window.innerWidth;
    const lay = windowLayout(vw, rect ? vw - rect.right : 80, wide);
    const { width, right } = lay;
    const compact = lay.mode === "compact";
    compactRef.current = compact;
    const tipW = tipWidth(vw, right, width);
    tipRoomRef.current = tipW > 0;
    /** Footer: keycaps only when the list is narrower than usual or in compact mode (full text in `title`). */
    const footKeys = compact || width < 360;
    const bottom = rect ? window.innerHeight - rect.top + EDGE + (hasCompose ? 48 : 0) : 80;
    const height = Math.max(200, Math.min(MAX_H, window.innerHeight - bottom - EDGE));
    const style: React.CSSProperties = { right, bottom, width, height };

    // Hover tooltip: inside the window's vertical range, never over the compose bar / chat input below it.
    const winBottom = window.innerHeight - bottom, winTop = winBottom - height;
    const tipMaxH = Math.min(TIP_MAX_H, height);
    useLayoutEffect(() => {
        const h = tipRef.current?.offsetHeight ?? 0;
        if (h && h !== tipH) setTipH(h); // measured before paint: no visible jump
    }, [hover, tipMaxH, tipW]);

    const Row = getRow();
    const row = (t: Template, i: number) => (
        <Row
            key={t.id}
            t={t}
            sel={i === selIdx}
            alt={data.alt(t, i)}
            bind={store.bindFor(t.id)}
            icon={!t.project}
            tokens={data.tokens}
            line={data.lines.get(t) ?? null}
            onHover={startHover}
            onMove={moveHover}
            onLeave={leaveHover}
            onHide={stopHover}
        />
    );

    const empty = !store.templates.length
        ? "Шаблонов нет. Импортируй конфиг в настройках плагина."
        : res ? "Ничего не найдено"
            : view === "fav" ? "В избранном пусто — Ctrl+D или ПКМ, «В избранное»"
                : view === "recent" ? "Ещё ничего не вставлялось"
                    : "Шаблонов нет";
    const count = scope ? <span className="vc-stx-n">{data.total} {plural(data.total, "шаблон", "шаблона", "шаблонов")}</span> : null;

    let idx = 0;
    return (
        <>
            <div
                className={"vc-stx-win" + (compact ? " compact" : "")} ref={winRef} style={style} onKeyDown={onKeyDown}
                // Nothing in the window but text fields takes focus: it stays in the search input, so the keys
                // keep working after a click on a row, a button (even one that unmounts on Shift release), the
                // tab strip, the header, a section title or empty space. The preview text stays selectable.
                onMouseDown={e => { if (!(e.target as HTMLElement).closest("input, textarea, select, .vc-stx-body")) e.preventDefault(); }}
                onMouseEnter={() => { pointerIn.current = true; }}
                onMouseLeave={() => { pointerIn.current = false; }}
            >
                {/* Side: preview LEFT of the list (the window is right-anchored, the list never moves when it opens).
                    Compact: the same pane covers the list (absolute), the list stays mounted with its scroll. */}
                {wide && <Preview t={current} onBack={compact ? back : undefined} />}
                <div className="vc-stx-col">
                    <div className="vc-stx-head">
                        <label className="vc-stx-search">
                            <span className="vc-stx-sicon"><IconSearch size={15} /></span>
                            <input
                                ref={inputRef}
                                className="vc-stx-sinput"
                                placeholder="Поиск: название, текст или «снр», «фпс»…"
                                value={query}
                                onChange={e => setQuery(e.currentTarget.value)}
                            />
                        </label>
                        <div className="vc-stx-proj">
                            {scope === "all"
                                // Tech: which project's templates to list (remembered). No project guard here.
                                ? <><div className="vc-stx-seg" role="radiogroup" aria-label="Проект на Tech">
                                    {(["mj", "ro"] as const).map(p => (
                                        <button
                                            key={p} role="radio" aria-checked={listed === p}
                                            className={"vc-stx-segb" + (listed === p ? " on" : "")}
                                            title={"Шаблоны " + PROJECTS[p].name + " и общие"}
                                            onClick={() => pickTechProject(p)}
                                        ><ProjectIcon project={p} size={16} />{p === "mj" ? "Majestic" : PROJECTS[p].name}</button>
                                    ))}
                                </div>{count}</>
                                : scope
                                    ? <><ProjectIcon project={scope} size={18} /><b>{PROJECTS[scope].name}</b>{count}</>
                                    : <span className="vc-stx-hint">На этом сервере шаблоны выключены</span>}
                        </div>
                        <div className="vc-stx-tabs">
                            {VIEWS.map(v => (
                                <button key={v} className={"vc-stx-tab" + (view === v ? " on" : "")} onClick={() => setView(v)}>
                                    {v === "all" ? "Все" : v === "fav" ? <><IconStar size={13} />Избранное<i>{favs.length}</i></> : "Недавние"}
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
                                    <div className="vc-stx-sec">{sec.key === "fav" && <IconStar size={11} filled />}{sec.title}</div>
                                    {sec.items.map(t => row(t, idx++))}
                                </div>))}
                    </div>
                    <div className="vc-stx-foot" title={"Enter — вставить · Shift+Enter — в ответ · Shift (держать) — текст · стрелки вправо / влево — открыть / скрыть текст слева · Tab — вкладки · Ctrl+D — избранное · ПКМ — меню"}>
                        <span><span className="vc-stx-kb"><IconEnter size={11} /></span>{!footKeys && "вставить"}</span>
                        <span><span className="vc-stx-kb"><IconShift size={11} /><IconEnter size={11} /></span>{!footKeys && "в ответ"}</span>
                        <span><span className="vc-stx-kb">Tab</span>{!footKeys && "вкладки"}</span>
                        <span><span className="vc-stx-kb">ПКМ</span>{!footKeys && "ещё"}</span>
                    </div>
                </div>
            </div>
            {hover && !wide && tipW > 0 && (
                <div
                    className="vc-stx-tip" ref={tipRef}
                    style={{ right: right + width + EDGE, width: tipW, top: clampTop(hover.top, winTop, winBottom, tipH || tipMaxH), maxHeight: tipMaxH }}
                >
                    <Preview key={hover.t.id} t={hover.t} compact />{/* key: remount so the fade check runs per template */}
                </div>
            )}
        </>
    );
}
