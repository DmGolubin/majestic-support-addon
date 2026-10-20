/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "@webpack/common";

import { comboLabel, startsPeek } from "../core/keys";
import { clampTop, DEFAULT_WINDOW_SIZE, EDGE, readWindowSize, tipWidth, windowLayout, WindowSize, windowVertical } from "../core/layout";
import { categoriesOf, favoritesOf, orderHits, recentOf, sections, windowTabPool } from "../core/rank";
import { search } from "../core/search";
import { splitGreeting } from "../core/text";
import { moveWindowTab, PROJECTS, Template, WindowTab, WINDOW_TAB_LABELS } from "../core/types";
import { clampFloatingBox } from "../core/windowPlacement";
import { chatAreaRect, storage } from "../platform";
import { openMenu } from "./ContextMenu";
import { costEnd, costStart, debugEnabled, debugState, debugVerbose, dlog, keyDesc, logGeometry, noteKey, noteRender, noteSearch, noteWheel, setDebugHover, setDebugWindow } from "./debug";
import { addToCompose, insertTemplate } from "./flow";
import { nqHighlight } from "./highlight";
import { latchKey } from "./keylatch";
import { windowEditor } from "./op";
import { plural, Preview } from "./Preview";
import { ProjectIcon } from "./ProjectIcon";
import { Select } from "./Select";
import { IconClose, IconEnter, IconSearch, IconSettings, IconShift, IconStar } from "./svg";
import { activeScope, listedProject, pickTechProject, poolFor, store, ui, useStore, watchChatArea } from "./uiState";

import "./menu-refinement.css";
// Load the placement component (which imports its CSS) after the menu's base overrides.
import { useWindowPlacement, WindowPlacementControls } from "./WindowPlacement";
import "./window-placement.css";
import "./window-tabs.css";

/** Rows currently visible in the window — Alt+1…9 uses them while the window is open. */
export let visibleItems: Template[] = [];

const HOVER_MS = 500;
/** Hover tooltips stay off until this long after the last scroll event. */
const SCROLL_QUIET_MS = 150;
const NO_TOKENS: string[] = [];
const TIP_MAX_H = 320;
const SIZE_KEY = "SupportTemplates_windowSize_v1";
// Serialize completed gestures, including rapid close/reopen, so older writes cannot win.
let sizeWrite = Promise.resolve();
const saveSize = (size: WindowSize) => {
    sizeWrite = sizeWrite.then(() => storage.set(SIZE_KEY, size)).catch(e => {
        dlog("error", { where: "window.size.save", msg: String(e) });
    });
};

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
    /** The context menu is open for this row: outlined so it is clear which template the menu acts on. */
    ctx: boolean;
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

function RowImpl({ t, sel, ctx, alt, bind, icon, tokens, line, onHover, onMove, onLeave, onHide }: RowProps) {
    return (
        <div
            className={"vc-stx-it" + (sel ? " sel" : "") + (ctx ? " ctx" : "")}
            onMouseEnter={e => onHover(t, e.currentTarget)}
            onMouseMove={e => onMove(t, e)}
            onMouseLeave={onLeave}
            onClick={e => {
                if (e.button !== 0) return;
                onHide();
                void insertTemplate(t, { via: "window-click", noGreeting: e.ctrlKey });
            }}
            onContextMenu={e => { e.preventDefault(); onHide(); openMenu(t.id, e.clientX, e.clientY); }}
        >
            <div className="vc-stx-r">
                {t.color && <span className="vc-stx-color" style={{ background: t.color }} />}
                {icon && <ProjectIcon project={t.project} />}
                <span className="vc-stx-nm">{nqHighlight(t.title, tokens)}</span>
                {t.status !== "actual" && <span className={"vc-stx-badge " + t.status}>{t.status === "outdated" ? "устарел" : "на проверке"}</span>}
                {bind && <span className="vc-stx-kb">{comboLabel(bind)}</span>}
                {alt > 0 && <span className="vc-stx-kb">Alt {alt}</span>}
                <button type="button" className="vc-stx-btn vc-stx-ghost" data-stx-menu-control
                    style={{ width: 24, height: 24, padding: 0, justifyContent: "center", flexShrink: 0 }}
                    aria-label={`Действия с шаблоном «${t.title}»`} aria-haspopup="menu" aria-expanded={ctx}
                    title="Действия с шаблоном · назначить сочетание клавиш"
                    onClick={e => {
                        e.stopPropagation(); onHide();
                        const rect = e.currentTarget.getBoundingClientRect();
                        openMenu(t.id, rect.left, rect.bottom);
                    }}><span aria-hidden="true">⋯</span></button>
            </div>
            <div className="vc-stx-sn">{line ? nqHighlight(line, tokens) : snippetOf(t)}</div>
        </div>
    );
}

// React from @webpack/common is only ready after Discord loaded: build the memo on first render.
let MemoRow: React.ComponentType<RowProps> | null = null;
const getRow = () => MemoRow ??= React.memo(RowImpl);

/** The template window; its render (the component body) is a `render` cost span while debug is on. */
export function Window({ connectionNotice = "" }: { connectionNotice?: string; } = {}) {
    const t0 = costStart();
    try { return WindowView(connectionNotice); } finally { costEnd("render", t0); }
}

function WindowView(connectionNotice: string) {
    const version = useStore();
    const channelRevision = ui.useSelect(s => s.channelRevision);
    const composeLen = ui.useSelect(s => s.compose.length);
    const hasCompose = composeLen > 0;
    const dialogOpen = ui.useSelect(s => s.dialog !== null);
    const menuId = ui.useSelect(s => s.menu?.id ?? null);
    const debugOn = debugState.useSelect(s => s.on);
    if (debugVerbose()) noteRender();
    const scope = activeScope();
    /** The project the list shows: the server's, on Tech the switch's. */
    const listed = listedProject(scope);
    const [query, setQuery] = useState("");
    const [view, setView] = useState<WindowTab>("all");
    const tabOrder = store.data.windowTabOrder;
    const draggingTab = useRef<WindowTab | null>(null);
    const [dropTab, setDropTab] = useState<WindowTab | null>(null);
    const [cat, setCat] = useState<string | null>(null);
    const [sel, setSel] = useState(0);
    const [peek, setPeek] = useState(false);
    const [compactPreview, setCompactPreview] = useState(false);
    const [hover, setHover] = useState<{ t: Template; top: number; } | null>(null);
    // Anchored at the editor the window was opened from (focus moves to the search box; a side thread stays the anchor).
    const [geometry, setGeometry] = useState(() => ({ rect: chatAreaRect(windowEditor()) }));
    const { rect } = geometry;
    const [size, setSize] = useState<WindowSize | null>(null);
    const placement = useWindowPlacement();
    const sizeTouched = useRef(false);
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
        const scopedPool = poolFor(scope);
        // Favorites/recent keep the existing category choices; limit recent after category filtering.
        const projectPool = view === "fav" || view === "recent" ? scopedPool
            : windowTabPool(scopedPool, view, ctx, store.data.showPersonalInAll);
        const cats = categoriesOf(projectPool);
        const categoryCounts = new Map<string, number>();
        for (const t of projectPool) if (t.category) categoryCounts.set(t.category, (categoryCounts.get(t.category) ?? 0) + 1);
        const activeCategory = cat && cats.includes(cat) ? cat : null;
        const categoryPool = activeCategory ? projectPool.filter(t => t.category === activeCategory) : projectPool;
        const pool = windowTabPool(categoryPool, view, ctx, store.data.showPersonalInAll);
        const res = query.trim() ? search(pool, query) : null;
        const hits = res ? orderHits(res.hits, ctx, store.data.generalFirstInSearch) : [];
        const secs = !res && (view === "all" || view === "personal") ? sections(pool, ctx) : [];
        const favs = favoritesOf(pool, ctx);
        const favoriteCount = favoritesOf(activeCategory ? scopedPool.filter(t => t.category === activeCategory) : scopedPool, ctx).length;
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
        return { total: projectPool.length, cats, categoryCounts, res, secs, favs, favoriteCount, items, positional, alt, lines, tokens: res?.tokens ?? NO_TOKENS };
    }, [query, scope, listed, view, cat, version, channelRevision]);
    const { cats, res, secs, favs, items } = data;

    const shortcuts = data.positional ? items : favs;
    useLayoutEffect(() => {
        // Publish only committed rows, before keyboard input can use them. An
        // abandoned render must not replace the live window's shortcut list.
        visibleItems = shortcuts;
        return () => { if (visibleItems === shortcuts) visibleItems = []; };
    }, [shortcuts]);
    const selIdx = Math.min(sel, Math.max(0, items.length - 1));
    const current = items[selIdx];
    itemsRef.current = items;
    selIdxRef.current = selIdx;

    useEffect(() => {
        const previous = document.activeElement as HTMLElement;
        const element = winRef.current;
        inputRef.current?.focus();
        const off = watchChatArea(() => setGeometry({ rect: chatAreaRect(windowEditor()) }), windowEditor);
        logGeometry("окно открыто");
        return () => {
            off();
            logGeometry("окно закрыто");
            // Restore the opener on dismiss, but leave a new settings/dialog or
            // an editor focused by insertion in charge of its own focus.
            if (!ui.get().management && !ui.get().dialog && previous?.isConnected
                && (element?.contains(document.activeElement) || document.activeElement === document.body)) previous.focus({ preventScroll: true });
        };
    }, []);
    useEffect(() => {
        let live = true;
        void sizeWrite.then(() => storage.get(SIZE_KEY)).then(value => {
            if (live && !sizeTouched.current) setSize(readWindowSize(value));
        }).catch(e => { dlog("error", { where: "window.size.load", msg: String(e) }); });
        return () => { live = false; };
    }, []);
    useEffect(() => {
        setGeometry({ rect: chatAreaRect(windowEditor()) });
    }, [channelRevision]);
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
    }, [query, scope, listed, view, cat, channelRevision, version]);
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
        // Shift held = temporary full-text preview; released anywhere (or the app losing focus) = hide.
        // Document level, not the window's onKeyDown: a click on a non-focusable part of the window (tab
        // strip, header, scrollbar) drops focus to <body>, and then the window never saw Shift (Task 20).
        // Peek is visual only: Shift is never prevented, so Discord still gets it.
        const onShift = (e: KeyboardEvent) => {
            if ((e.target as HTMLElement)?.closest?.(".vc-stx-select, [data-stx-menu-control]")) return;
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
        const blur = hide;
        const onUp = (e: KeyboardEvent) => { if (e.key === "Shift") hide(); };
        document.addEventListener("keydown", onShift, true);
        document.addEventListener("keyup", onUp, true);
        window.addEventListener("blur", blur);
        return () => {
            document.removeEventListener("keydown", onShift, true);
            document.removeEventListener("keyup", onUp, true);
            window.removeEventListener("blur", blur);
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

    // Compact menus always start as a list, even if a wide-screen preview was previously pinned.
    const vw = window.innerWidth;
    const anchorRight = placement.position?.right ?? (rect ? vw - rect.right : 80);
    const compact = windowLayout(vw, anchorRight, false, size).mode === "compact";
    const previewOpen = compact ? compactPreview : store.data.previewOpen;
    const setPreviewOpen = (open: boolean) => compact ? setCompactPreview(open) : store.setPreviewOpen(open);
    const wide = previewOpen || peek;
    wideRef.current = wide;
    peekRef.current = peek;
    const lay = windowLayout(vw, anchorRight, wide, size);
    const { width } = lay;
    const anchorBottom = placement.position?.bottom ?? (rect ? window.innerHeight - rect.top + EDGE + (hasCompose ? 48 : 0) : 80);
    const vertical = windowVertical(window.innerHeight, anchorBottom, size?.height);
    const { right, bottom, height } = clampFloatingBox({ right: lay.right, bottom: vertical.bottom, width, height: vertical.height }, vw, window.innerHeight);
    compactRef.current = compact;
    const tipW = tipWidth(vw, right, width);
    tipRoomRef.current = !compact && tipW > 0;

    /** «← назад» in compact mode: hides the pinned preview (and a Shift peek). */
    const back = () => {
        dlog("key", { h: "window", what: "скрыть превью (назад)" });
        setPeek(false);
        setPreviewOpen(false);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME composition: its Enter/arrows are the IME's
        if (e.defaultPrevented) return;
        // Escape on the category control belongs to the filter, including repeated keydowns after it closes.
        if (e.key === "Escape" && (e.target as HTMLElement).closest(".vc-stx-select")) {
            e.preventDefault(); e.stopPropagation(); return;
        }
        // Header and preview controls own their native activation/navigation.
        if (e.key !== "Escape" && (e.target as HTMLElement).closest(".vc-stx-select, [data-stx-menu-control], button, a")) return;
        const input = inputRef.current;
        const atEnd = !!input && input.selectionStart === input.value.length;
        const atStart = !!input && input.selectionEnd === 0;
        const eat = () => { e.preventDefault(); e.stopPropagation(); };
        const log = (what: string, data: Record<string, unknown> = {}) => {
            noteKey(e, "window: " + what);
            if (debugEnabled()) dlog("key", { h: "window", key: keyDesc(e), what, ...data }, "win:" + keyDesc(e) + what);
        };
        // Shift alone (peek) is handled at document level, see onShift.
        if (e.altKey && e.key === "ArrowDown" && e.target === input) {
            const category = winRef.current?.querySelector<HTMLButtonElement>(".vc-stx-category-filter [role=combobox]");
            if (category) { eat(); category.focus(); category.click(); }
        } else if (e.key === "Escape" && ui.get().menu) {
            eat();
            log("закрыть меню");
            ui.set({ menu: null });
        } else if (e.key === "Escape") {
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
        } else if (e.key === "ArrowRight" && atEnd && !previewOpen) {
            eat();
            log("открыть превью");
            setPreviewOpen(true);
        } else if (e.key === "ArrowLeft" && (atStart || compactRef.current) && previewOpen) {
            // Compact: the preview covers the search input, so ← goes back wherever the caret is.
            eat();
            log("скрыть превью");
            setPreviewOpen(false);
        } else if (e.key === "Tab" && e.ctrlKey) {
            eat();
            log("вкладка");
            const i = tabOrder.indexOf(view);
            setView(tabOrder[(i + (e.shiftKey ? -1 : 1) + tabOrder.length) % tabOrder.length]);
        } else if (e.ctrlKey && e.code === "KeyD" && current) {
            eat();
            log("избранное", { id: current.id });
            if (e.repeat) return;
            store.toggleFavorite(current.id);
        }
    };

    /** Footer: keycaps only when the list is narrower than usual or in compact mode (full text in `title`). */
    const footKeys = compact || width < 360;
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
            ctx={t.id === menuId}
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
        ? "В библиотеке пока нет шаблонов."
        : res ? "Ничего не найдено"
            : view === "fav" ? "В избранном пусто — Ctrl+D или ПКМ, «В избранное»"
                : view === "recent" ? "Ещё ничего не вставлялось"
                    : view === "personal" ? "Личных шаблонов нет — создайте их в «Мои шаблоны и настройки»"
                    : "Шаблонов нет";
    const filtered = !!query.trim() || !!cat || view !== "all";
    const count = scope ? <span className="vc-stx-n" aria-live="polite">{filtered
        ? `${items.length} из ${data.total}`
        : `${data.total} ${plural(data.total, "шаблон", "шаблона", "шаблонов")}`}</span> : null;

    let idx = 0;
    return (
        <>
            <div
                className={"vc-stx-win" + (compact ? " compact" : "")} ref={winRef} style={style} onKeyDown={onKeyDown}
                // Filter/settings controls take focus; otherwise it stays in search, so the keys
                // keep working after a click on a row, a button (even one that unmounts on Shift release), the
                // tab strip, the header, a section title or empty space. The preview text stays selectable.
                onMouseDown={e => { if (!(e.target as HTMLElement).closest("input, textarea, select, .vc-stx-body, .vc-stx-select, [data-stx-menu-control]")) e.preventDefault(); }}
                onMouseEnter={() => { pointerIn.current = true; }}
                onMouseLeave={() => { pointerIn.current = false; }}
            >
                <WindowPlacementControls placement={placement} box={{ right, bottom, width, height }} size={size} side={!compact && wide}
                    setSize={s => { sizeTouched.current = true; setSize(s); }} saveSize={saveSize} />
                <button type="button" className="vc-stx-window-close" data-stx-menu-control
                    aria-label="Закрыть окно шаблонов" title="Закрыть окно шаблонов"
                    onClick={() => ui.set({ windowOpen: false, menu: null })}><IconClose size={16} /></button>
                {/* Side: preview LEFT of the list (the window is right-anchored, the list never moves when it opens).
                    Compact: the same pane covers the list (absolute), the list stays mounted with its scroll. */}
                {wide && <Preview t={current} onBack={compact ? back : undefined} />}
                <div className="vc-stx-col" style={{ width: compact ? "100%" : (size?.width ?? DEFAULT_WINDOW_SIZE.width) - 2 }}>
                    <div className="vc-stx-head">
                        <div className="vc-stx-search-row">
                            <label className="vc-stx-search">
                                <span className="vc-stx-sicon"><IconSearch size={15} /></span>
                                <input
                                    ref={inputRef}
                                    className="vc-stx-sinput"
                                    placeholder="Поиск: название, текст или «снр», «фпс»…"
                                    aria-label="Поиск шаблонов"
                                    aria-keyshortcuts="Alt+ArrowDown"
                                    value={query}
                                    onChange={e => setQuery(e.currentTarget.value)}
                                />
                            </label>
                            <button type="button" className="vc-stx-menu-settings" data-stx-menu-control
                                title="Мои шаблоны и настройки" aria-label="Мои шаблоны и настройки"
                                onClick={() => ui.set({ management: true, windowOpen: false, menu: null, inline: null })}><IconSettings size={17} /></button>
                        </div>
                        {connectionNotice && <p className="vc-stx-connection-notice" role="status">{connectionNotice}</p>}
                        <div className="vc-stx-proj">
                            {scope === "all"
                                // Tech: which project's templates to list (remembered). No project guard here.
                                ? <><div className="vc-stx-seg" role="radiogroup" aria-label="Проект на Tech">
                                    {(["mj", "ro"] as const).map(p => (
                                        <button
                                            key={p} type="button" data-stx-menu-control role="radio" aria-checked={listed === p}
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
                        <div className="vc-stx-tabs" role="group" aria-label="Разделы шаблонов">
                            {tabOrder.map(v => (
                                <button key={v} type="button" data-stx-menu-control aria-pressed={view === v}
                                    draggable title={`${WINDOW_TAB_LABELS[v]} · Перетащите для изменения порядка; кнопки перемещения — в настройках`}
                                    className={"vc-stx-tab" + (view === v ? " on" : "") + (dropTab === v ? " vc-stx-tab-drop" : "")}
                                    onDragStart={e => { draggingTab.current = v; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", v); stopHover(); }}
                                    onDragOver={e => { if (draggingTab.current) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropTab(v); } }}
                                    onDragLeave={() => setDropTab(null)}
                                    onDrop={e => {
                                        e.preventDefault();
                                        const from = draggingTab.current;
                                        draggingTab.current = null; setDropTab(null);
                                        if (from) store.setWindowTabOrder(moveWindowTab(store.data.windowTabOrder, from, v));
                                    }}
                                    onDragEnd={() => { draggingTab.current = null; setDropTab(null); }}
                                    onClick={() => setView(v)}>
                                    {v === "fav" ? <><IconStar size={13} />Избранное<i>{data.favoriteCount}</i></> : WINDOW_TAB_LABELS[v]}
                                </button>
                            ))}
                        </div>
                        {cats.length > 0 && (
                            <div className="vc-stx-category-filter" title="Категория · Alt + ArrowDown из поиска">
                                <Select aria-label="Категория шаблонов" value={cat ?? ""} onChange={e => setCat(e.currentTarget.value || null)}>
                                    <option value="">Все категории</option>
                                    {cats.map(c => <option key={c} value={c}>{c}</option>)}
                                </Select>
                                {cat && <button type="button" className="vc-stx-category-reset" data-stx-menu-control
                                    title="Сбросить категорию" aria-label="Сбросить категорию"
                                    onClick={() => { setCat(null); inputRef.current?.focus(); }}><IconClose size={14} /></button>}
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
                    <div className="vc-stx-foot" title={"Enter — вставить · Ctrl+клик — без приветствия · Shift+Enter — в ответ · Shift (держать) — текст · стрелки вправо / влево — открыть / скрыть текст слева · Tab — элементы управления · Ctrl+Tab — вкладки · Alt+↓ — категории · Ctrl+D — избранное · ПКМ — меню"}>
                        <span><span className="vc-stx-kb"><IconEnter size={11} /></span>{!footKeys && "вставить"}</span>
                        <span><span className="vc-stx-kb"><IconShift size={11} /><IconEnter size={11} /></span>{!footKeys && "в ответ"}</span>
                        <span><span className="vc-stx-kb">Tab</span>{!footKeys && "фокус"}</span>
                        <span><span className="vc-stx-kb">ПКМ</span>{!footKeys && "ещё"}</span>
                    </div>
                </div>
            </div>
            {hover && !compact && !wide && tipW > 0 && (
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
