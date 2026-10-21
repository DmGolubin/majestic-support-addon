/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cleanBindModes, isValidBind } from "./keys";
import { Persisted, StorageLike, STORE_KEY } from "./state";
import { validPrefix } from "./trigger";
import { readWindowTabOrder, WINDOW_TABS } from "./types";

type Preferences = Pick<Persisted, "favorites" | "recent" | "usage" | "binds" | "prefix" | "previewOpen" | "techProject">
    & Partial<Pick<Persisted, "bindModes" | "showPersonalInAll" | "generalFirstInSearch" | "windowTabOrder">> & { v: 1; };

const MAX_REFS = 1000;
const MAX_USAGE = 10000;
const MAX_SCAN = 10000;
const MAX_COUNT = 1_000_000_000;
const MAX_TIMESTAMP = 8_640_000_000_000_000; // ECMAScript's maximum valid date, still a safe integer.
const MAX_BIND_LENGTH = 64;
const writes = new WeakMap<StorageLike, Map<string, Promise<void>>>();

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Only own data properties: inherited values, accessors and prototype keys never become preferences.
function own(value: unknown, key: string): unknown {
    if (!record(value)) return undefined;
    return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function validId(value: unknown): value is string {
    // Match the IDs produced by parseSnapshot in panelCatalog, including its positive 1–20 digit IDs.
    return typeof value === "string" && value.length <= 38 && value.trim() === value
        && /^(?:faq:(?:majestic|russia-online):|personal:panel:)[1-9]\d{0,19}$/.test(value);
}

function refs(value: unknown, limit: number): string[] {
    const result = new Set<string>();
    if (Array.isArray(value)) {
        for (let i = 0; i < Math.min(value.length, MAX_SCAN) && result.size < limit; i++) {
            const id: unknown = Object.getOwnPropertyDescriptor(value, String(i))?.value;
            if (validId(id)) result.add(id);
        }
    }
    return [...result];
}

function* entries(value: unknown): Generator<[string, unknown]> {
    if (!record(value)) return;
    let scanned = 0;
    for (const key in value) {
        if (++scanned > MAX_SCAN) break;
        if (validId(key)) yield [key, own(value, key)];
    }
}

function integer(value: unknown, min: number, max: number): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Project into fresh, bounded values; never inspect or clone catalog/secret fields. */
function normalize(value: unknown): Preferences {
    const result: Preferences = {
        v: 1, favorites: refs(own(value, "favorites"), MAX_REFS), recent: refs(own(value, "recent"), 20),
        usage: {}, binds: {}, prefix: ";", previewOpen: false, techProject: "mj",
    };
    let usageCount = 0;
    for (const [id, usage] of entries(own(value, "usage"))) {
        const n = own(usage, "n"), last = own(usage, "last");
        if (integer(n, 1, MAX_COUNT) && integer(last, 0, MAX_TIMESTAMP)) {
            result.usage[id] = { n, last };
            if (++usageCount >= MAX_USAGE) break;
        }
    }
    const used = new Set<string>();
    for (const [id, combo] of entries(own(value, "binds"))) {
        if (typeof combo === "string" && combo.length <= MAX_BIND_LENGTH && combo.trim() === combo && isValidBind(combo) && !used.has(combo)) {
            result.binds[id] = combo;
            used.add(combo);
        }
        if (used.size >= MAX_REFS) break;
    }
    // Follow the accepted, bounded bindings; ordinary/legacy modes need no extra stored field.
    const bindModes = cleanBindModes(own(value, "bindModes"), result.binds);
    if (Object.keys(bindModes).length) result.bindModes = bindModes;
    const prefix = own(value, "prefix"), preview = own(value, "previewOpen"), project = own(value, "techProject");
    if (validPrefix(prefix) && prefix.length === 1) result.prefix = prefix;
    if (typeof preview === "boolean") result.previewOpen = preview;
    if (project === "mj" || project === "ro") result.techProject = project;
    // Store only deviations from defaults, preserving the compact legacy projection.
    if (own(value, "showPersonalInAll") === true) result.showPersonalInAll = true;
    if (own(value, "generalFirstInSearch") === false) result.generalFirstInSearch = false;
    const tabs = own(value, "windowTabOrder");
    if (Array.isArray(tabs)) {
        const order = readWindowTabOrder(tabs);
        if (order.some((tab, index) => tab !== WINDOW_TABS[index])) result.windowTabOrder = order;
    }
    return result;
}

/** Account preferences only. The controller must restore these after a verified catalog snapshot. */
export function createPanelPreferencesStorage(storage: StorageLike, accountId: string): StorageLike {
    if (typeof accountId !== "string" || accountId.trim() !== accountId || !/^[1-9]\d{16,19}$/.test(accountId)) {
        throw new Error("Invalid panel preferences account ID");
    }
    const accountKey = "SupportTemplates_panel_preferences_v1_" + accountId;
    let pending = writes.get(storage);
    if (!pending) writes.set(storage, pending = new Map());
    const queue = pending;
    const checkKey = (key: string) => {
        if (key !== STORE_KEY) throw new Error("Unsupported panel preferences key");
    };
    return {
        async get(key) {
            checkKey(key);
            await queue.get(accountId);
            const saved = await storage.get(accountKey);
            if (saved === undefined) return undefined;
            return normalize(own(saved, "v") === 1 ? saved : undefined);
        },
        async set(key, value) {
            checkKey(key);
            // Store passes Persisted (v2); only this projection (v1) reaches the underlying storage.
            // Normalize synchronously at invocation, before waiting for any previous write.
            const snapshot = normalize(value);
            const next = (queue.get(accountId) ?? Promise.resolve()).catch(() => {}).then(() => storage.set(accountKey, snapshot));
            queue.set(accountId, next);
            const settled = () => { if (queue.get(accountId) === next) queue.delete(accountId); };
            void next.then(settled, settled);
            return next;
        },
    };
}
