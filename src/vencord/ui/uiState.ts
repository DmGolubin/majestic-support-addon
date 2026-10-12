/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useMemo, useState } from "@webpack/common";

import { DM_KEY, projectForGuild, ServerBinding } from "../core/guard";
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
    | { kind: "askProject"; resolve(v: ServerBinding | null): void; }
    | { kind: "confirm"; tone: "danger" | "warn"; label: string; title: string; body: string; ok: string; checkbox?: string; resolve(v: { ok: boolean; checked: boolean; }): void; }
    | { kind: "fields"; title: string; fields: FieldSpec[]; initial: Record<string, string>; resolve(v: Record<string, string> | null): void; }
    | { kind: "bind"; templateId: string; };

export interface InlineState { query: string; length: number; items: Template[]; sel: number; note: string; }

export interface UiState {
    windowOpen: boolean;
    dialog: Dialog | null;
    compose: string[];
    inline: InlineState | null;
    /** Project picked in the window on a server bound to "none". */
    sessionProject: ProjectId | null;
    menu: { x: number; y: number; id: string; } | null;
    /** Selected message text captured when the window/trigger opened. */
    selection: string;
}

export const ui = createObservable<UiState>({
    windowOpen: false, dialog: null, compose: [], inline: null, sessionProject: null, menu: null, selection: "",
});

export const guildKey = () => currentGuildId() ?? DM_KEY;

export function activeProject(): { project: ProjectId | null; binding: ServerBinding | null; } {
    const binding = projectForGuild(currentGuildId(), store.data.guilds);
    if (binding === "mj" || binding === "ro") return { project: binding, binding };
    if (binding === "none") return { project: ui.get().sessionProject, binding };
    return { project: null, binding: null };
}

/** Templates visible for a project: its own + common (no project). */
export const poolFor = (project: ProjectId | null) =>
    store.templates.filter(t => !t.project || t.project === project);

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
