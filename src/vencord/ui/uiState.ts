/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useMemo, useState } from "@webpack/common";

import { ServerMode, serverMode } from "../core/guard";
import { Store } from "../core/state";
import { FieldSpec } from "../core/tokens";
import { ProjectId, Template } from "../core/types";
import { chatAreaRect, currentGuildId, storage } from "../platform";
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
    windowOpen: boolean;
    dialog: Dialog | null;
    compose: string[];
    inline: InlineState | null;
    menu: { x: number; y: number; id: string; } | null;
    /** Selected message text captured when the window/trigger opened. */
    selection: string;
}

export const ui = createObservable<UiState>({
    windowOpen: false, dialog: null, compose: [], inline: null, menu: null, selection: "",
});

/** Which templates a server gets: one project (+ common) or all of them (Tech). */
export type Scope = ProjectId | "all";

/** Mode of the current server (fixed table in core/guard). */
export const currentMode = (): ServerMode => serverMode(currentGuildId());

/** false on any server but Majestic / Россия Онлайн / Tech and in DMs: the plugin stays out of the way. */
export const pluginOn = () => currentMode() !== "off";

/** Templates scope of the current server; null = plugin off here. */
export function activeScope(): Scope | null {
    const m = currentMode();
    return m === "off" ? null : m;
}

/** Templates visible in a scope: a project's own + common (no project); all of them on Tech; none when off. */
export const poolFor = (scope: Scope | null): Template[] =>
    scope === null ? [] : scope === "all" ? store.templates : store.templates.filter(t => !t.project || t.project === scope);

/** Re-render on any Store change; returns a version number. */
export function useStore() {
    const [v, setV] = useState(0);
    useEffect(() => store.subscribe(() => setV(x => x + 1)), []);
    return v;
}

/** Chat box rect, read when `active` turns on and on window resize — not on every render. */
export function useChatRect(active: boolean): DOMRect | null {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        if (!active) return;
        const onResize = () => setTick(x => x + 1);
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, [active]);
    return useMemo(() => active ? chatAreaRect() : null, [active, tick]);
}
