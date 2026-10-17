/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Debug mode: a live state snapshot + a ring of the last plugin events. Off by default; when off,
// dlog() is one boolean check and nothing is rendered or listened to.
// Verbose level (a second setting, meaningful only with debug on): raw key/mouse/wheel/focus/resize
// events, geometry, search/render details. Its listeners exist only while it is on; off = noteKey()/noteWheel() see null.
// Privacy: titles and ids only — never template texts, field values, the captured selection or tokens.
// Typed characters are masked outside search; password, composition and AltGr keys are always masked.
// Cost accounting (debug on, any level): costStart()/costEnd() around the plugin's own work — one boolean
// check when debug is off, two performance.now() calls when on. Long tasks are matched against these spans.

import { gitHash } from "@shared/vencordUserAgent";
import { useEffect, useState } from "@webpack/common";

import { PLUGIN_BUILD, PLUGIN_VERSION } from "../buildInfo";
import { COST_CATS, CostCat, CostMeter, NESTED_CATS, overlapLabel, significant, throttle } from "../core/cost";
import { comboLabel } from "../core/keys";
import { DebugEvent, formatEvent, Ring } from "../core/ring";
import { activeEditor, chatAreaRect, currentChannel, currentGuildId, discordEnv, guildName } from "../platform";
import { isAccepting } from "./inline";
import { latchedCode } from "./keylatch";
import { createObservable, shallowEqual } from "./observable";
import { currentMode, Dialog, store, ui } from "./uiState";

/** What the open window reports about itself (its state is local to the component). */
export interface WinDebug {
    peek: boolean;
    view: string;
    cat: string | null;
    query: string;
    selIdx: number;
    selId: string | null;
    hoveredId: string | null;
    /** Window layout (core/layout windowLayout): side = preview left of the list, compact = over it. */
    layout: "side" | "compact";
    winW: number;
    previewW: number;
    avail: number;
    /** Hover tooltip width, 0 = no room left of the window. */
    tipW: number;
}

const CAP = 30, CAP_VERBOSE = 200;
let enabled = false;
/** The «Отладка: подробно» setting; effective only while debug is on (`verbose`). */
let verboseSetting = false;
let verbose = false;
const ring = new Ring(CAP);
const meter = new CostMeter();

/** performance.now() when debug is on, else 0 (= not measured). The start of a measured span. */
export function costStart(): number {
    return enabled ? performance.now() : 0;
}

/** The end of a span started by costStart(); a no-op for 0. */
export function costEnd(cat: CostCat, t0: number) {
    if (t0) meter.record(cat, t0, performance.now());
}

/** Wraps a listener/callback as a measured `debug` span (verbose listeners, timers, the long task observer). */
function dspan<A extends unknown[]>(fn: (...a: A) => void): (...a: A) => void {
    return (...a: A) => {
        const t0 = costStart();
        try { fn(...a); } finally { costEnd("debug", t0); }
    };
}

/** on: the setting; verbose: the effective verbose level; win: the window's report; log: bumps on every event. */
export const debugState = createObservable<{ on: boolean; verbose: boolean; win: WinDebug | null; log: number; }>({ on: false, verbose: false, win: null, log: 0 });

export const debugEnabled = () => enabled;
export const debugVerbose = () => verbose;
export const debugCap = () => ring.cap;

export function setDebugEnabled(on: boolean) {
    if (on === enabled) return;
    enabled = on;
    if (!on) ring.clear();
    meter.clear(performance.now());
    resetLong();
    if (on) startLongTasks(); else stopLongTasks();
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

/** The events, oldest first (a copy). */
export const debugEvents = (): DebugEvent[] => ring.list();
export const debugCount = () => ring.length;

export function clearDebugLog() {
    ring.clear();
    debugState.set({ log: debugState.get().log + 1 });
}

/** A user-typed query for the panel/report, cut to 40 chars. */
const cut40 = (q: string) => q.length > 40 ? q.slice(0, 40) + "…" : q;
const q40 = (q: string) => JSON.stringify(cut40(q));

/** "Ctrl+Alt+KeyT", "Enter", "Shift+Tab" (+ " repeat"). */
export function keyDesc(e: KeyboardEvent | React.KeyboardEvent): string {
    if (maskKey(e)) return "симв." + (e.repeat ? " repeat" : "");
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
    const mode = currentMode();
    const w = debugState.get().win;
    const inl = s.inline;
    const ts = store.templates;
    const mj = ts.filter(t => t.project === "mj").length, ro = ts.filter(t => t.project === "ro").length;
    return [
        `сервер: ${gid ?? "ЛС"}${gid ? ` «${guildName(gid)}»` : ""}`,
        `режим сервера: ${mode}${mode === "off" ? " (плагин выключен: кнопки нет, клавиши не перехватываются)" : mode === "all" ? ` (Tech: переключатель -> ${store.data.techProject}, без проверки проекта)` : ""}`,
        `канал: ${ch.id ?? "—"}${ch.name ? ` #${ch.name}` : ""}`,
        `окно: ${s.windowOpen ? "открыто" : "закрыто"} · previewOpen: ${store.data.previewOpen} · peek: ${w?.peek ?? false}`,
        ...(s.windowOpen && w ? [
            `  вкладка: ${w.view} · категория: ${w.cat ?? "все"} · запрос: ${q40(w.query)}`,
            `  выбрано: #${w.selIdx} ${tpl(w.selId)}`,
            `  раскладка: ${w.layout} · окно ${w.winW} · превью ${w.previewW || "скрыто"} · доступно ${w.avail} · подсказка ${w.tipW || "нет места"}`,
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
    const legacy = Object.keys(d.guilds).length;
    const env = discordEnv();
    return [
        `уровень отладки: ${verbose ? "подробно" : "обычный"} (настройка «подробно»: ${verboseSetting ? "вкл" : "выкл"}) · журнал до ${ring.cap} событий`,
        `префикс: ${d.prefix} · previewOpen: ${d.previewOpen}`,
        `бинды (${binds.length}): ${binds.length ? binds.map(([id, c]) => `${comboLabel(c)} -> ${tpl(id)}`).join(", ") : "нет"}`,
        `серверы: Majestic -> mj, Россия Онлайн -> ro, Tech -> all, остальные и ЛС -> off${legacy ? ` · старых ответов «чей сервер» в данных: ${legacy} (не используются)` : ""}`,
        `Discord: язык ${env.locale ?? (document.documentElement.lang || navigator.language)} · тема ${env.theme ?? "?"} · zoom ${env.zoom ?? "?"} · шрифт ${env.fontSize ?? "?"}`,
        ...loadLines(),
    ];
}

// ---- Geometry (read on demand: the panel's open Geometry section at most once a second and on
// window open/close/resize, the report) — never during a render ----

const rnd = Math.round;
const rect = (b: DOMRect | null | undefined) => b ? `x${rnd(b.x)} y${rnd(b.y)} ${rnd(b.width)}×${rnd(b.height)}` : "—";
const rectOf = (el: Element | null | undefined) => rect(el?.getBoundingClientRect());
const scrollOf = (el: Element | null | undefined) =>
    el ? ` · scrollTop ${rnd(el.scrollTop)} / scrollHeight ${el.scrollHeight} / clientHeight ${el.clientHeight}` : "";
const part = (sel: string) => document.getElementById("vc-stx-host")?.querySelector(sel) ?? null;

const geomSubs = new Set<() => void>();
/** Window open/close and resize: the panel re-measures its open Geometry section. */
export function onGeometryEvent(fn: () => void) {
    geomSubs.add(fn);
    return () => void geomSubs.delete(fn);
}
const geomEventNow = () => geomSubs.forEach(fn => fn());

/** Screen, zoom and the rects of every plugin part. Forces a layout read. */
export function debugGeometry(): string[] {
    const t0 = costStart();
    try { return geometryLines(); } finally { costEnd("debug", t0); }
}

function geometryLines(): string[] {
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
    layout: debugState.get().win?.layout,
});

/** Geometry snapshot into the log (window open/close). Verbose only; read after layout. */
export function logGeometry(what: string) {
    if (!enabled) return;
    geomEventNow();
    if (!verbose) return;
    requestAnimationFrame(() => dlog("geometry", { what, ...geomEvent() }));
}

// ---- Perf: plugin cost and long tasks (debug on, any level); search details and window renders (verbose) ----

/** Plugin start: the whole start() (awaits included), the await of store.load, the synchronous rest; readyAt = performance.now(). */
export interface LoadTimes { total: number; storeLoad: number; mount: number; readyAt: number; }
let load: LoadTimes | null = null;
export const setLoadTime = (t: LoadTimes) => { load = t; };

function loadLines(): string[] {
    if (!load) return ["загрузка плагина: ?"];
    const f = (ms: number) => ms.toFixed(1) + " мс";
    return [
        `загрузка плагина: start() -> готово ${f(load.total)} (ожидание store.load ${f(load.storeLoad)} — включает работу Discord в это время; монтирование и подписки ${f(load.mount)})`,
        `  от запуска страницы (performance.timeOrigin) до готовности плагина: ${f(load.readyAt)} — это загрузка Discord и Vencord, не только плагина`,
    ];
}

const perf = {
    searches: [] as number[],
    lastSearch: null as { ms: number; q: string; items: number; } | null,
    renders: 0,
    renderTimes: [] as number[],
};

const long = { count: 0, max: 0, ms: 0, withPlugin: 0, pluginMs: 0, last: [] as string[] };

function resetPerf() {
    perf.searches = [];
    perf.lastSearch = null;
    perf.renders = 0;
    perf.renderTimes = [];
}

function resetLong() {
    long.count = long.max = long.ms = long.withPlugin = long.pluginMs = 0;
    long.last = [];
}

/** Search + ranking of one list computation [t0, t1] (the window measures it while debug is on). */
export function noteSearch(t0: number, t1: number, query: string, items: number) {
    if (!enabled) return;
    meter.record("search", t0, t1);
    if (!verbose) return;
    const ms = t1 - t0;
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

let longObserver: PerformanceObserver | null = null;
let longSupported = true;

function onLongTasks(list: PerformanceObserverEntryList) {
    for (const en of list.getEntries()) {
        const ms = rnd(en.duration);
        const o = meter.overlap(en.startTime, en.startTime + en.duration);
        const plugin = overlapLabel(o, en.duration);
        const sig = significant(o, en.duration);
        long.count++;
        long.max = Math.max(long.max, ms);
        long.ms += en.duration;
        long.pluginMs += o.ms; // the share stays honest: tiny overlaps are still plugin time
        if (sig) long.withPlugin++;
        long.last.push(o.cats.length ? `${ms} (${o.cats.join(",")} ${o.ms.toFixed(1)} мс${sig ? "" : ", мелочь"})` : `${ms} (—)`);
        if (long.last.length > 5) long.last.shift();
        // Normal level: only the long tasks the plugin noticeably took part in; verbose: all of them.
        if (sig || verbose) dlog("longtask", { ms, plugin, pluginMs: o.cats.length ? +o.ms.toFixed(1) : undefined }, "longtask:" + plugin);
    }
}

function startLongTasks() {
    if (longObserver) return;
    try {
        if (!PerformanceObserver.supportedEntryTypes?.includes("longtask")) { longSupported = false; return; }
        longObserver = new PerformanceObserver(dspan(onLongTasks));
        longObserver.observe({ type: "longtask" });
    } catch (e) {
        longObserver = null;
        longSupported = false;
        console.debug("[SupportTemplates] longtask observer unavailable", e);
    }
}

function stopLongTasks() {
    longObserver?.disconnect();
    longObserver = null;
}

const pct = (part: number, whole: number) => whole > 0 ? (part / whole * 100).toFixed(part / whole < 0.1 ? 1 : 0) + "%" : "—";

export function debugPerf(): string[] {
    const now = performance.now();
    const sums = meter.sums(now);
    const total = meter.total(now);
    const calls = COST_CATS.filter(c => !NESTED_CATS.includes(c)).reduce((a, c) => a + sums[c].n, 0);
    const win = meter.windowMs(now);
    const span = win >= 59_500 ? "60 с" : `${Math.round(win / 1000)} с (с включения отладки)`;
    const note: Partial<Record<CostCat, string>> = {
        render: " (тела компонентов окна; React commit, layout, paint и GPU сюда не входят)",
        search: " (входит в render)",
    };
    const out = [
        `плагин за последние ${span}: ${total.toFixed(1)} мс (${pct(total, win)} времени) · вызовов ${calls}`,
        ...COST_CATS.map(c => `  ${c}: ${sums[c].ms.toFixed(1)} мс · вызовов ${sums[c].n}${note[c] ?? ""}`),
        !longSupported ? "long tasks: PerformanceObserver(longtask) недоступен"
            : `long tasks: ${long.count} · заметно с плагином (>=5 мс или >=10 %) ${long.withPlugin} · доля плагина в их времени ${pct(long.pluginMs, long.ms)} · макс ${long.max} мс`,
        `  последние: ${long.last.join(", ") || "—"}`,
    ];
    if (!verbose) return [...out, "поиск и рендеры окна подробно: включите «Отладка: подробно»"];
    const s = perf.searches;
    const recent = perf.renderTimes.filter(t => t >= now - 5000).length;
    const ls = perf.lastSearch;
    return [
        ...out,
        `поиск + ранжирование: ${ls ? `последний ${ls.ms.toFixed(2)} мс (запрос ${q40(ls.q)}, в списке ${ls.items})` : "ещё не было"}`
        + (s.length ? ` · среднее ${(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2)} мс · макс ${Math.max(...s).toFixed(2)} мс (последние ${s.length})` : ""),
        `рендеров окна: ${perf.renders} · за 5 с: ${recent} (${(recent / 5).toFixed(1)}/с)`,
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
        `Плагин: ${PLUGIN_VERSION} · ${PLUGIN_BUILD}`,
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

/** The keydown being dispatched (verbose only): plugin handlers note who consumed it; logged after dispatch. */
let pendingKey: { ev: KeyboardEvent; h: string; } | null = null;

/** Which plugin handler consumed this keydown (latch / dialog / inline / window / hotkey / alt-n / bind). First note wins. */
export function noteKey(e: KeyboardEvent | React.KeyboardEvent, h: string) {
    const p = pendingKey;
    if (!p) return;
    const ev = "nativeEvent" in e ? e.nativeEvent : e;
    if (p.ev === ev && p.h === "none") p.h = h;
}

function maskKey(e: KeyboardEvent | React.KeyboardEvent): boolean {
    const target = e.target as Element | null;
    const native = "nativeEvent" in e ? e.nativeEvent : e;
    // These checks take precedence over search and shortcut diagnostics.
    if (target?.closest?.('input[type="password"]') || native.isComposing || native.keyCode === 229
        || ["Process", "Dead", "Unidentified"].includes(e.key)) return true;
    const printable = [...e.key].length === 1; // Includes supplementary Unicode characters.
    // Windows may report AltGr as Ctrl+Alt even without the AltGraph modifier flag.
    const altGraph = e.getModifierState?.("AltGraph") || (e.ctrlKey && e.altKey);
    if (printable && altGraph) return true;
    const search = !!target?.closest?.(".vc-stx-sinput");
    return !search && printable && !e.ctrlKey && !e.altKey && !e.metaKey;
}

function keyFields(e: KeyboardEvent) {
    const target = e.target as Element | null;
    const masked = maskKey(e);
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

const flushKeyTimer = dspan(flushKey);

function onVKeyDown(e: KeyboardEvent) {
    flushKey();
    pendingKey = { ev: e, h: "none" };
    setTimeout(flushKeyTimer, 0); // after the whole dispatch, including the window's React handler
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

const flushWheelTimer = dspan(flushWheel);

/** At most one wheel line per 100 ms, deltas summed. */
function onVWheel(e: WheelEvent) {
    if (!wheel) {
        wheel = { n: 0, dx: 0, dy: 0, mode: e.deltaMode, shift: false, el: e.target, target: describeEl(e.target as Element), mixed: false, handled: false };
        wheelTimer = setTimeout(flushWheelTimer, 100);
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
    resizeTimer = setTimeout(dspan(() => { resizeTimer = null; geomEventNow(); dlog("resize", geomEvent()); }), 250);
}

function startVerbose() {
    resetPerf();
    const ac = new AbortController();
    const o: AddEventListenerOptions = { capture: true, passive: true, signal: ac.signal };
    // keydown on window (capture) runs before the plugin's document handler; the line is written after dispatch.
    // Every listener is a measured `debug` span.
    window.addEventListener("keydown", dspan(onVKeyDown), o);
    document.addEventListener("keyup", dspan(onVKeyUp), o);
    document.addEventListener("wheel", dspan(onVWheel), o);
    const mouse = dspan(onVMouse), focus = dspan(onVFocus);
    document.addEventListener("mousedown", mouse, o);
    document.addEventListener("click", mouse, o);
    document.addEventListener("focusin", focus, o);
    document.addEventListener("focusout", focus, o);
    window.addEventListener("resize", dspan(onVResize), { passive: true, signal: ac.signal });
    offVerbose = () => {
        ac.abort();
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

/**
 * The debug panel's re-render clock: at most one render per 250 ms (trailing render guaranteed).
 * Collapsed (`open` false): only debug state/new events bump it (the header counter); open: also
 * UI and store state, focus and keys.
 */
export function usePanelTick(open: boolean) {
    const [, setTick] = useState(0);
    useEffect(() => {
        const t = throttle(250, () => setTick(x => x + 1));
        const bump = () => t.call();
        const offs = [debugState.subscribe(bump)];
        const evs = ["focusin", "focusout", "keydown", "keyup"];
        if (open) {
            offs.push(ui.subscribe(bump), store.subscribe(bump));
            for (const ev of evs) document.addEventListener(ev, bump, true);
        }
        return () => {
            t.cancel();
            offs.forEach(off => off());
            if (open) for (const ev of evs) document.removeEventListener(ev, bump, true);
        };
    }, [open]);
}
