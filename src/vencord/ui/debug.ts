/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Debug mode: a live state snapshot + a ring of the last plugin events. Off by default; when off,
// dlog() is one boolean check and nothing is rendered or listened to.
// Verbose level (a second setting, meaningful only with debug on): raw key/mouse/wheel/focus/resize
// events, geometry, perf. Its listeners exist only while it is on; off = noteKey()/noteWheel() see null.
// Privacy: titles and ids only — never template texts, field values, the captured selection or tokens.
// Typed characters are masked (chat box, dialog fields) except in the window's search; queries are cut to 40 chars.

import { gitHash } from "@shared/vencordUserAgent";
import { useEffect, useState } from "@webpack/common";

import { projectForGuild } from "../core/guard";
import { comboLabel } from "../core/keys";
import { DebugEvent, formatEvent, Ring } from "../core/ring";
import { activeEditor, chatAreaRect, currentChannel, currentGuildId, discordEnv, guildName } from "../platform";
import { isAccepting } from "./inline";
import { latchedCode } from "./keylatch";
import { createObservable, shallowEqual } from "./observable";
import { activeProject, Dialog, store, ui } from "./uiState";

/** What the open window reports about itself (its state is local to the component). */
export interface WinDebug {
    peek: boolean;
    view: string;
    cat: string | null;
    query: string;
    selIdx: number;
    selId: string | null;
    hoveredId: string | null;
}

const CAP = 30, CAP_VERBOSE = 200;
let enabled = false;
/** The «Отладка: подробно» setting; effective only while debug is on (`verbose`). */
let verboseSetting = false;
let verbose = false;
const ring = new Ring(CAP);

/** on: the setting; verbose: the effective verbose level; win: the window's report; log: bumps on every event. */
export const debugState = createObservable<{ on: boolean; verbose: boolean; win: WinDebug | null; log: number; }>({ on: false, verbose: false, win: null, log: 0 });

export const debugEnabled = () => enabled;
export const debugVerbose = () => verbose;
export const debugCap = () => ring.cap;

export function setDebugEnabled(on: boolean) {
    if (on === enabled) return;
    enabled = on;
    if (!on) ring.clear();
    debugState.set({ on, win: null, log: debugState.get().log + 1 });
    if (on) dlog("debug", { on: true, verbose: verboseSetting });
    applyVerbose();
}

export function setDebugVerbose(on: boolean) {
    verboseSetting = on;
    applyVerbose();
}

function applyVerbose() {
    const v = enabled && verboseSetting;
    if (v === verbose) return;
    verbose = v;
    ring.setCap(v ? CAP_VERBOSE : CAP);
    if (v) startVerbose(); else stopVerbose();
    debugState.set({ verbose: v, log: debugState.get().log + 1 });
    if (enabled) dlog("debug", { verbose: v });
}

/**
 * Logs one event. No-op when debug is off. `coalesce`: the same key as the newest entry replaces it
 * and counts repeats (held keys, hover, typing) instead of flooding the ring.
 */
export function dlog(type: string, data: Record<string, unknown> = {}, coalesce?: string) {
    if (!enabled) return;
    ring.push(Date.now(), type, data, coalesce);
    console.debug("[SupportTemplates]", type, data);
    debugState.set({ log: debugState.get().log + 1 });
}

/** The window publishes its local state (only while debug is on). */
export function setDebugWindow(win: WinDebug | null) {
    if (!enabled) return;
    const prev = debugState.get().win;
    if (!shallowEqual(prev, win)) debugState.set({ win });
}

/** Hover is a ref in the window (no render): it updates only this field. */
export function setDebugHover(hoveredId: string | null) {
    if (!enabled) return;
    const { win } = debugState.get();
    if (win && win.hoveredId !== hoveredId) debugState.set({ win: { ...win, hoveredId } });
}

/** Re-renders on every new event; returns the events, oldest first. */
export function useDebugLog(): DebugEvent[] {
    debugState.useSelect(s => s.log);
    return ring.list();
}

export function clearDebugLog() {
    ring.clear();
    debugState.set({ log: debugState.get().log + 1 });
}

/** A user-typed query for the panel/report, cut to 40 chars. */
const cut40 = (q: string) => q.length > 40 ? q.slice(0, 40) + "…" : q;
const q40 = (q: string) => JSON.stringify(cut40(q));

/** "Ctrl+Alt+KeyT", "Enter", "Shift+Tab" (+ " repeat"). */
export function keyDesc(e: KeyboardEvent | React.KeyboardEvent): string {
    const m = (e.ctrlKey ? "Ctrl+" : "") + (e.altKey ? "Alt+" : "") + (e.shiftKey && e.key !== "Shift" ? "Shift+" : "") + (e.metaKey ? "Meta+" : "");
    return m + (e.code || e.key) + (e.repeat ? " repeat" : "");
}

/** `input.vc-stx-sinput (в .vc-stx-win)`, `div[data-slate-editor]`, `body`. */
export function describeEl(el: Element | null): string {
    if (!el || !el.tagName) return el ? "document" : "null";
    const tag = el.tagName.toLowerCase();
    if (el === document.body) return "body";
    let s = tag;
    if (el.hasAttribute("data-slate-editor")) s += "[data-slate-editor]";
    const cls = Array.from(el.classList);
    const ours = cls.filter(c => c.startsWith("vc-stx-"));
    // Discord classes are hashed ("textArea__74017"): keep the readable part of the first two.
    const keyCls = ours.length ? ours : cls.slice(0, 2).map(c => c.replace(/[_-]+[\w]{4,}$/, ""));
    if (keyCls.length) s += "." + keyCls.join(".");
    const where = el.closest(".vc-stx-win, .vc-stx-dialog, .vc-stx-pop, .vc-stx-menu, .vc-stx-compose, .vc-stx-debug, .vc-stx-tip");
    if (where && where !== el) s += ` (в .${Array.from(where.classList).find(c => c.startsWith("vc-stx-"))})`;
    return s;
}

const tpl = (id: string | null | undefined) => {
    if (!id) return "—";
    const t = store.byId(id);
    return t ? `«${t.title}» [${id}]` : `[${id}] (нет в базе)`;
};

function dialogDesc(d: Dialog | null): string {
    if (!d) return "нет";
    switch (d.kind) {
        case "askProject": return "askProject";
        case "confirm": return `confirm (${d.tone}) «${d.label}» — «${d.title}»`;
        case "fields": return `fields «${d.title}» поля: ${d.fields.map(f => f.name).join(", ")}`;
        case "bind": return `bind ${tpl(d.templateId)}`;
    }
}

/** Live state as plain text lines. Titles and ids only. */
export function debugSnapshot(): string[] {
    const s = ui.get();
    const gid = currentGuildId();
    const ch = currentChannel();
    const binding = projectForGuild(gid, store.data.guilds);
    const ap = activeProject();
    const w = debugState.get().win;
    const inl = s.inline;
    const ts = store.templates;
    const mj = ts.filter(t => t.project === "mj").length, ro = ts.filter(t => t.project === "ro").length;
    return [
        `сервер: ${gid ?? "ЛС"}${gid ? ` «${guildName(gid)}»` : ""}`,
        `привязка projectForGuild: ${binding ?? "null (неизвестный)"} · activeProject: ${ap.project ?? "null"} · sessionProject: ${s.sessionProject ?? "null"}`,
        `канал: ${ch.id ?? "—"}${ch.name ? ` #${ch.name}` : ""}`,
        `окно: ${s.windowOpen ? "открыто" : "закрыто"} · previewOpen: ${store.data.previewOpen} · peek: ${w?.peek ?? false}`,
        ...(s.windowOpen && w ? [
            `  вкладка: ${w.view} · категория: ${w.cat ?? "все"} · запрос: ${q40(w.query)}`,
            `  выбрано: #${w.selIdx} ${tpl(w.selId)}`,
            `  под мышью: ${tpl(w.hoveredId)}`,
        ] : []),
        `inline: ${inl ? `запрос ${q40(inl.query)} · пунктов ${inl.items.length} · sel ${inl.sel}${inl.note ? ` · note «${inl.note}»` : ""}` : "закрыт"} · accepting: ${isAccepting()}`,
        `диалог: ${dialogDesc(s.dialog)}`,
        `ответ (compose): ${s.compose.length ? s.compose.map(tpl).join(", ") : "пусто"}`,
        `меню: ${s.menu ? tpl(s.menu.id) : "нет"}`,
        `latch: ${latchedCode() ?? "нет"}`,
        `фокус: ${describeEl(document.activeElement)}`,
        `шаблонов: ${ts.length} (mj ${mj}, ro ${ro}, общих ${ts.length - mj - ro}) · избранных: ${store.data.favorites.length} · биндов: ${Object.keys(store.data.binds).length} · префикс: ${store.data.prefix}`,
    ];
}

/** Settings and environment. Titles, ids and key combos only. */
export function debugSettings(): string[] {
    const d = store.data;
    const binds = Object.entries(d.binds);
    const guilds = Object.entries(d.guilds);
    const env = discordEnv();
    return [
        `уровень отладки: ${verbose ? "подробно" : "обычный"} (настройка «подробно»: ${verboseSetting ? "вкл" : "выкл"}) · журнал до ${ring.cap} событий`,
        `префикс: ${d.prefix} · previewOpen: ${d.previewOpen}`,
        `бинды (${binds.length}): ${binds.length ? binds.map(([id, c]) => `${comboLabel(c)} → ${tpl(id)}`).join(", ") : "нет"}`,
        `привязки серверов (${guilds.length}): ${guilds.length ? guilds.map(([g, b]) => `${g}${guildName(g) ? ` «${guildName(g)}»` : ""} = ${b}`).join(", ") : "нет"}`,
        `Discord: язык ${env.locale ?? (document.documentElement.lang || navigator.language)} · тема ${env.theme ?? "?"} · zoom ${env.zoom ?? "?"} · шрифт ${env.fontSize ?? "?"}`,
        `загрузка плагина: ${loadMs === null ? "?" : loadMs.toFixed(1) + " мс"}`,
    ];
}

// ---- Geometry (read on demand: panel render while verbose, report, open/close/resize events) ----

const rnd = Math.round;
const rect = (b: DOMRect | null | undefined) => b ? `x${rnd(b.x)} y${rnd(b.y)} ${rnd(b.width)}×${rnd(b.height)}` : "—";
const rectOf = (el: Element | null | undefined) => rect(el?.getBoundingClientRect());
const scrollOf = (el: Element | null | undefined) =>
    el ? ` · scrollTop ${rnd(el.scrollTop)} / scrollHeight ${el.scrollHeight} / clientHeight ${el.clientHeight}` : "";
const part = (sel: string) => document.getElementById("vc-stx-host")?.querySelector(sel) ?? null;

/** Screen, zoom and the rects of every plugin part. Forces a layout read. */
export function debugGeometry(): string[] {
    const env = discordEnv();
    const vv = window.visualViewport;
    const list = part(".vc-stx-list");
    return [
        `экран: ${screen.width}×${screen.height} · доступно ${screen.availWidth}×${screen.availHeight}`,
        `окно Discord: inner ${innerWidth}×${innerHeight} · outer ${outerWidth}×${outerHeight} · devicePixelRatio ${devicePixelRatio}`,
        `масштаб Discord: ${env.zoom ?? "?"} · шрифт ${env.fontSize ?? "?"} · font-size html ${getComputedStyle(document.documentElement).fontSize}${vv ? ` · visualViewport.scale ${vv.scale}` : ""}`,
        `поле ввода (chatAreaRect): ${rect(chatAreaRect())}`,
        `активный редактор: ${rectOf(activeEditor())}`,
        `окно шаблонов: ${rectOf(part(".vc-stx-win"))}`,
        `превью: ${rectOf(part(".vc-stx-win > .vc-stx-pre"))}${scrollOf(part(".vc-stx-win > .vc-stx-pre .vc-stx-body"))}`,
        `список: ${rectOf(list)}${scrollOf(list)}`,
        `подсказка: ${rectOf(part(".vc-stx-tip"))}`,
        `ответ (compose): ${rectOf(part(".vc-stx-compose"))}`,
        `inline: ${rectOf(part(".vc-stx-pop"))}`,
        `панель отладки: ${rectOf(part(".vc-stx-debug"))}`,
    ];
}

/** Compact geometry for a log line. */
const geomEvent = (): Record<string, unknown> => ({
    inner: `${innerWidth}×${innerHeight}`,
    dpr: devicePixelRatio,
    zoom: discordEnv().zoom ?? undefined,
    chat: rect(chatAreaRect()),
    win: rectOf(part(".vc-stx-win")),
});

/** Geometry snapshot into the log (window open/close). Verbose only; read after layout. */
export function logGeometry(what: string) {
    if (!verbose) return;
    requestAnimationFrame(() => dlog("geometry", { what, ...geomEvent() }));
}

// ---- Perf (verbose only, except the one-off plugin load time) ----

let loadMs: number | null = null;
export const setLoadTime = (ms: number) => { loadMs = ms; };

const perf = {
    searches: [] as number[],
    lastSearch: null as { ms: number; q: string; items: number; } | null,
    renders: 0,
    renderTimes: [] as number[],
    longCount: 0,
    longMax: 0,
    longLast: [] as number[],
};

function resetPerf() {
    perf.searches = [];
    perf.lastSearch = null;
    perf.renders = 0;
    perf.renderTimes = [];
    perf.longCount = 0;
    perf.longMax = 0;
    perf.longLast = [];
}

/** Search + ranking time of one list computation (the window measures it only while verbose is on). */
export function noteSearch(ms: number, query: string, items: number) {
    if (!verbose) return;
    perf.searches.push(ms);
    if (perf.searches.length > 20) perf.searches.shift();
    perf.lastSearch = { ms, q: query, items };
    // Measured inside the window's render (useMemo): the log/state update must happen outside it.
    queueMicrotask(() => dlog("search", { q: cut40(query), ms: +ms.toFixed(2), items }, "search"));
}

/** One Window render (called from its body only while verbose is on). */
export function noteRender() {
    const now = performance.now();
    perf.renders++;
    perf.renderTimes.push(now);
    while (perf.renderTimes[0] < now - 5000) perf.renderTimes.shift();
}

export function debugPerf(): string[] {
    if (!verbose) return ["включите «Отладка: подробно»"];
    const s = perf.searches;
    const now = performance.now();
    const recent = perf.renderTimes.filter(t => t >= now - 5000).length;
    const ls = perf.lastSearch;
    return [
        `поиск + ранжирование: ${ls ? `последний ${ls.ms.toFixed(2)} мс (запрос ${q40(ls.q)}, в списке ${ls.items})` : "ещё не было"}`
        + (s.length ? ` · среднее ${(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2)} мс · макс ${Math.max(...s).toFixed(2)} мс (последние ${s.length})` : ""),
        `рендеров окна: ${perf.renders} · за 5 с: ${recent} (${(recent / 5).toFixed(1)}/с)`,
        `long tasks: ${longObserver ? `${perf.longCount} · макс ${perf.longMax} мс · последние ${perf.longLast.join(", ") || "—"}` : "PerformanceObserver(longtask) недоступен"}`,
    ];
}

/** Plain-text report for the clipboard: versions, state, settings, geometry, perf, the full log. No template texts, cookies or tokens. */
export function debugReport(): string {
    const env = (window as any).GLOBAL_ENV;
    const discord = [env?.RELEASE_CHANNEL, env?.SENTRY_TAGS?.buildId].filter(Boolean).join(" ") || "неизвестно";
    const built = typeof BUILD_TIMESTAMP === "number" ? new Date(BUILD_TIMESTAMP).toLocaleString("ru-RU") : "неизвестно";
    const events = ring.list();
    return [
        "SupportTemplates · отчёт отладки",
        `Сформирован: ${new Date().toLocaleString("ru-RU")}`,
        `Сборка Vencord (вместе с плагином): ${typeof VERSION === "string" ? VERSION : "?"} ${gitHash ?? ""} · ${built}`,
        `Discord: ${discord}`,
        `UA: ${navigator.userAgent}`,
        "",
        "== Состояние ==",
        ...debugSnapshot(),
        "",
        "== Настройки и окружение ==",
        ...debugSettings(),
        "",
        "== Геометрия ==",
        ...debugGeometry(),
        "",
        "== Производительность ==",
        ...debugPerf(),
        "",
        `== События (${events.length}/${ring.cap}, старые сверху) ==`,
        ...events.map(e => formatEvent(e, true)),
    ].join("\n");
}

// ---- Verbose listeners: only while verbose is on; capture, passive, never preventDefault ----

let offVerbose: (() => void) | null = null;
let longObserver: PerformanceObserver | null = null;

/** The keydown being dispatched (verbose only): plugin handlers note who consumed it; logged after dispatch. */
let pendingKey: { ev: KeyboardEvent; h: string; } | null = null;

/** Which plugin handler consumed this keydown (latch / dialog / inline / window / hotkey / alt-n / bind). First note wins. */
export function noteKey(e: KeyboardEvent | React.KeyboardEvent, h: string) {
    const p = pendingKey;
    if (!p) return;
    const ev = "nativeEvent" in e ? e.nativeEvent : e;
    if (p.ev === ev && p.h === "none") p.h = h;
}

function keyFields(e: KeyboardEvent) {
    const target = e.target as Element | null;
    // Plain characters are the user's text (chat box, dialog fields): masked everywhere except the
    // window's search input — the query is shown anyway (cut to 40 chars).
    const search = !!target?.closest?.(".vc-stx-sinput");
    // IME composition (e.key "Process") is typed text too.
    const masked = !search && (e.isComposing || e.key === "Process" || (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey));
    const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean).join("+");
    return {
        masked,
        data: {
            key: masked ? "симв." : e.key,
            code: masked ? "•" : e.code,
            mods: mods || undefined,
            repeat: e.repeat || undefined,
            composing: e.isComposing || undefined,
            target: describeEl(target),
        } as Record<string, unknown>,
    };
}

function flushKey() {
    const p = pendingKey;
    if (!p) return;
    pendingKey = null;
    const { masked, data } = keyFields(p.ev);
    // Held keys and plain typing collapse into one counted line.
    dlog("keydown", { ...data, h: p.h }, masked ? "kd:typing:" + p.h : `kd:${p.ev.code}:${data.mods ?? ""}:${p.h}`);
}

function onVKeyDown(e: KeyboardEvent) {
    flushKey();
    pendingKey = { ev: e, h: "none" };
    setTimeout(flushKey, 0); // after the whole dispatch, including the window's React handler
}

function onVKeyUp(e: KeyboardEvent) {
    const { masked, data } = keyFields(e);
    if (masked) return; // the keydown line already says "typing"
    dlog("keyup", data);
}

let wheel: { n: number; dx: number; dy: number; mode: number; shift: boolean; el: EventTarget | null; target: string; mixed: boolean; handled: boolean; top?: number; } | null = null;
let wheelTimer: ReturnType<typeof setTimeout> | null = null;

function flushWheel() {
    if (wheelTimer) { clearTimeout(wheelTimer); wheelTimer = null; }
    const w = wheel;
    wheel = null;
    if (!w) return;
    dlog("wheel", {
        n: w.n, dx: rnd(w.dx), dy: rnd(w.dy), mode: w.mode || undefined, shift: w.shift,
        target: w.target + (w.mixed ? " (+другие)" : ""), handled: w.handled, previewTop: w.top,
    }, `wheel:${w.target}:${w.shift}:${w.handled}`);
}

/** At most one wheel line per 100 ms, deltas summed. */
function onVWheel(e: WheelEvent) {
    if (!wheel) {
        wheel = { n: 0, dx: 0, dy: 0, mode: e.deltaMode, shift: false, el: e.target, target: describeEl(e.target as Element), mixed: false, handled: false };
        wheelTimer = setTimeout(flushWheel, 100);
    } else if (e.target !== wheel.el) wheel.mixed = true;
    wheel.n++;
    wheel.dx += e.deltaX;
    wheel.dy += e.deltaY;
    if (e.shiftKey) wheel.shift = true;
}

/** The window redirected this wheel event to the preview (verbose only: no bucket otherwise). */
export function noteWheel(previewTop: number) {
    if (!wheel) return;
    wheel.handled = true;
    wheel.top = rnd(previewTop);
}

function onVMouse(e: MouseEvent) {
    const el = e.target as Element | null;
    if (!el?.closest?.(".vc-stx-root, [data-stx=button]")) return;
    dlog(e.type, { target: describeEl(el), btn: e.button || undefined, x: e.clientX, y: e.clientY });
}

function onVFocus(e: FocusEvent) {
    dlog(e.type, { target: describeEl(e.target as Element), other: e.relatedTarget ? describeEl(e.relatedTarget as Element) : undefined });
}

let resizeTimer: ReturnType<typeof setTimeout> | null = null;
function onVResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resizeTimer = null; dlog("resize", geomEvent()); }, 250);
}

function startVerbose() {
    resetPerf();
    const ac = new AbortController();
    const o: AddEventListenerOptions = { capture: true, passive: true, signal: ac.signal };
    // keydown on window (capture) runs before the plugin's document handler; the line is written after dispatch.
    window.addEventListener("keydown", onVKeyDown, o);
    document.addEventListener("keyup", onVKeyUp, o);
    document.addEventListener("wheel", onVWheel, o);
    document.addEventListener("mousedown", onVMouse, o);
    document.addEventListener("click", onVMouse, o);
    document.addEventListener("focusin", onVFocus, o);
    document.addEventListener("focusout", onVFocus, o);
    window.addEventListener("resize", onVResize, { passive: true, signal: ac.signal });
    try {
        if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
            longObserver = new PerformanceObserver(list => {
                for (const en of list.getEntries()) {
                    const ms = rnd(en.duration);
                    perf.longCount++;
                    perf.longMax = Math.max(perf.longMax, ms);
                    perf.longLast.push(ms);
                    if (perf.longLast.length > 5) perf.longLast.shift();
                    dlog("longtask", { ms }, "longtask");
                }
            });
            longObserver.observe({ type: "longtask" });
        }
    } catch (e) {
        longObserver = null;
        console.debug("[SupportTemplates] longtask observer unavailable", e);
    }
    offVerbose = () => {
        ac.abort();
        longObserver?.disconnect();
        longObserver = null;
        if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
        if (wheelTimer) { clearTimeout(wheelTimer); wheelTimer = null; }
        wheel = null;
        pendingKey = null;
    };
}

function stopVerbose() {
    offVerbose?.();
    offVerbose = null;
    resetPerf();
}

/** Bumps on focus changes and keys (only while mounted, i.e. while debug is on), at most once per frame. */
export function useFocusTick() {
    const [, setTick] = useState(0);
    useEffect(() => {
        let raf = 0;
        const bump = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setTick(x => x + 1)); };
        document.addEventListener("focusin", bump, true);
        document.addEventListener("focusout", bump, true);
        document.addEventListener("keydown", bump, true);
        document.addEventListener("keyup", bump, true);
        return () => {
            cancelAnimationFrame(raf);
            document.removeEventListener("focusin", bump, true);
            document.removeEventListener("focusout", bump, true);
            document.removeEventListener("keydown", bump, true);
            document.removeEventListener("keyup", bump, true);
        };
    }, []);
}
