/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useMemo, useState } from "@webpack/common";

import { listProject, poolOf, Scope, ServerMode, serverMode } from "../core/guard";
import { Store } from "../core/state";
import { FieldSpec } from "../core/tokens";
import { ProjectId, Template } from "../core/types";
import { chatAreaEl, chatAreaRect, currentGuildId, storage } from "../platform";
import { dlog } from "./debug";
import { createObservable } from "./observable";

const errText = (e: unknown) => String((e as any)?.message ?? e);

// Storage failures go to the debug log too (the Store itself only logs them to the console).
export const store = new Store({
    get: key => storage.get(key).catch(e => { dlog("error", { where: "storage.get", key, msg: errText(e) }); throw e; }),
    set: (key, value) => storage.set(key, value).catch(e => { dlog("error", { where: "storage.set", key, msg: errText(e) }); throw e; }),
});

export type Dialog =
    | { kind: "confirm"; tone: "danger" | "warn"; label: string; title: string; body: string; ok: string; checkbox?: string; resolve(v: { ok: boolean; checked: boolean; }): void; }
    | { kind: "fields"; title: string; fields: FieldSpec[]; initial: Record<string, string>; resolve(v: Record<string, string> | null): void; }
    | { kind: "bind"; templateId: string; };

export interface InlineState { query: string; length: number; items: Template[]; sel: number; note: string; }

export interface UiState {
    management: boolean;
    windowOpen: boolean;
    dialog: Dialog | null;
    compose: string[];
    inline: InlineState | null;
    menu: { x: number; y: number; id: string; } | null;
    /** Selected message text captured when the window/trigger opened. */
}

export const ui = createObservable<UiState>({
    management: false, windowOpen: false, dialog: null, compose: [], inline: null, menu: null,
});

export type { Scope };

/** Mode of the current server (fixed table in core/guard). */
export const currentMode = (): ServerMode => serverMode(currentGuildId());

/** false on any server but Majestic / Россия Онлайн / Tech and in DMs: the plugin stays out of the way. */
export const pluginOn = () => currentMode() !== "off";

/** Templates scope of the current server; null = plugin off here. */
export function activeScope(): Scope | null {
    const m = currentMode();
    return m === "off" ? null : m;
}

/** Templates visible in a scope: the listed project's own + common; Tech lists its switch's project; none when off. */
export const poolFor = (scope: Scope | null): Template[] => poolOf(store.templates, scope, store.data.techProject);

/** The project a scope lists (Tech: the switch), null when off. */
export const listedProject = (scope: Scope | null): ProjectId | null => scope === null ? null : listProject(scope, store.data.techProject);

/**
 * Tech switch. The collected reply is always dropped (simplest rule: its pieces were picked from the
 * other list) and the inline suggestions close (the next keystroke re-checks against the new list).
 */
export function pickTechProject(p: ProjectId) {
    if (store.data.techProject === p) return;
    dlog("tech-project", { project: p, droppedCompose: ui.get().compose.length || undefined });
    store.setTechProject(p);
    ui.set({ compose: [], inline: null });
}

/** The Tech choice, re-rendering only when it changes (the chat-bar button uses it). */
export function useTechProject(): ProjectId {
    const [p, setP] = useState(store.data.techProject);
    useEffect(() => store.subscribe(() => setP(store.data.techProject)), []);
    return p;
}

/** Re-render on any Store change; returns a version number. */
export function useStore() {
    const [v, setV] = useState(0);
    useEffect(() => store.subscribe(() => setV(x => x + 1)), []);
    return v;
}

/**
 * Calls onChange (at most once per frame) when the chat box moves or resizes: window resize, and the box's own
 * size — a growing multi-line editor, a reply / attachment bar, the member list or a side thread toggling
 * change it without any window resize. Only while a surface that needs it is shown; never per hover/render.
 */
export function watchChatArea(onChange: () => void, editor: () => HTMLElement | null = () => null): () => void {
    let raf = 0;
    const fire = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; rewatch(); onChange(); }); };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fire) : null;
    let watched: Element | null = null;
    // Discord may remount the box (channel switch): follow the current one.
    const rewatch = () => {
        const el = chatAreaEl(editor() ?? undefined);
        if (el === watched) return;
        if (watched) ro?.unobserve(watched);
        watched = el;
        if (el) ro?.observe(el);
    };
    rewatch();
    window.addEventListener("resize", fire);
    // ResizeObserver misses a pure move: one rect read every 250 ms while a surface is shown.
    const box = () => {
        const b = watched?.getBoundingClientRect();
        return b ? `${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.width)}` : "";
    };
    let last = box(); // baseline now, so a move right after opening is noticed too
    const poll = setInterval(() => {
        const prev = watched;
        rewatch(); // Discord may have replaced the box
        const now = box();
        if (watched !== prev || now !== last) { last = now; fire(); }
    }, 250);
    return () => { cancelAnimationFrame(raf); clearInterval(poll); ro?.disconnect(); window.removeEventListener("resize", fire); };
}

/** Chat box rect of `editor()` (default: the focused one), read when `active` turns on and when the box moves/resizes. */
export function useChatRect(active: boolean, editor: () => HTMLElement | null = () => null): DOMRect | null {
    const [tick, setTick] = useState(0);
    useEffect(() => active ? watchChatArea(() => setTick(x => x + 1), editor) : undefined, [active]);
    return useMemo(() => active ? chatAreaRect(editor()) : null, [active, tick]);
}
