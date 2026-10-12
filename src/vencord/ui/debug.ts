/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Debug mode: a live state snapshot + a ring of the last plugin events. Off by default; when off,
// dlog() is one boolean check and nothing is rendered or listened to.
// Privacy: titles and ids only — never template texts, field values, the captured selection or tokens.

import { gitHash } from "@shared/vencordUserAgent";
import { useEffect, useState } from "@webpack/common";

import { projectForGuild } from "../core/guard";
import { DebugEvent, formatEvent, Ring } from "../core/ring";
import { currentChannel, currentGuildId, guildName } from "../platform";
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

let enabled = false;
const ring = new Ring(30);

/** on: the setting; win: the window's report; log: bumps on every event (re-renders the log view). */
export const debugState = createObservable<{ on: boolean; win: WinDebug | null; log: number; }>({ on: false, win: null, log: 0 });

export const debugEnabled = () => enabled;

export function setDebugEnabled(on: boolean) {
    if (on === enabled) return;
    enabled = on;
    if (!on) ring.clear();
    debugState.set({ on, win: null, log: debugState.get().log + 1 });
    if (on) dlog("debug", { on: true });
}

/**
 * Logs one event. No-op when debug is off. `coalesce`: the same key as the newest entry replaces it
 * and counts repeats (held keys, hover, typing) instead of flooding the 30-entry ring.
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

/** "Ctrl+Alt+KeyT", "Enter", "Shift+Tab" (+ " repeat"). */
export function keyDesc(e: KeyboardEvent | React.KeyboardEvent): string {
    const m = (e.ctrlKey ? "Ctrl+" : "") + (e.altKey ? "Alt+" : "") + (e.shiftKey && e.key !== "Shift" ? "Shift+" : "") + (e.metaKey ? "Meta+" : "");
    return m + (e.code || e.key) + (e.repeat ? " repeat" : "");
}

/** `input.vc-stx-sinput (в .vc-stx-win)`, `div[data-slate-editor]`, `body`. */
export function describeEl(el: Element | null): string {
    if (!el) return "null";
    const tag = el.tagName.toLowerCase();
    if (el === document.body) return "body";
    let s = tag;
    if (el.hasAttribute("data-slate-editor")) s += "[data-slate-editor]";
    const cls = Array.from(el.classList);
    const ours = cls.filter(c => c.startsWith("vc-stx-"));
    // Discord classes are hashed ("textArea__74017"): keep the readable part of the first two.
    const keyCls = ours.length ? ours : cls.slice(0, 2).map(c => c.replace(/[_-]+[\w]{4,}$/, ""));
    if (keyCls.length) s += "." + keyCls.join(".");
    const where = el.closest(".vc-stx-win, .vc-stx-dialog, .vc-stx-pop, .vc-stx-menu, .vc-stx-compose, .vc-stx-debug");
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
            `  вкладка: ${w.view} · категория: ${w.cat ?? "все"} · запрос: ${JSON.stringify(w.query)}`,
            `  выбрано: #${w.selIdx} ${tpl(w.selId)}`,
            `  под мышью: ${tpl(w.hoveredId)}`,
        ] : []),
        `inline: ${inl ? `запрос ${JSON.stringify(inl.query)} · пунктов ${inl.items.length} · sel ${inl.sel}${inl.note ? ` · note «${inl.note}»` : ""}` : "закрыт"} · accepting: ${isAccepting()}`,
        `диалог: ${dialogDesc(s.dialog)}`,
        `ответ (compose): ${s.compose.length ? s.compose.map(tpl).join(", ") : "пусто"}`,
        `меню: ${s.menu ? tpl(s.menu.id) : "нет"}`,
        `latch: ${latchedCode() ?? "нет"}`,
        `фокус: ${describeEl(document.activeElement)}`,
        `шаблонов: ${ts.length} (mj ${mj}, ro ${ro}, общих ${ts.length - mj - ro}) · избранных: ${store.data.favorites.length} · биндов: ${Object.keys(store.data.binds).length} · префикс: ${store.data.prefix}`,
    ];
}

/** Plain-text report for the clipboard: versions, live state, event log. No template texts, cookies or tokens. */
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
        `== События (${events.length}, старые сверху) ==`,
        ...events.map(formatEvent),
    ].join("\n");
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
