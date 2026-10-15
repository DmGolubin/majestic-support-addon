/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Store } from "./state";

/** A stable facade: components stay subscribed while demo storage is isolated from real storage. */
export function routeStore(initial: Store) {
    let active = initial;
    const subscribers = new Set<() => void>();
    const notify = () => subscribers.forEach(fn => fn());
    let off = active.subscribe(notify);
    const store = new Proxy(initial, {
        get(_target, key) {
            if (key === "subscribe") return (fn: () => void) => { subscribers.add(fn); return () => void subscribers.delete(fn); };
            const value = Reflect.get(active, key);
            return typeof value === "function" ? value.bind(active) : value;
        },
        set(_target, key, value) { return Reflect.set(active, key, value); },
    });
    return { store, select(next: Store) { if (active === next) return; off(); active = next; off = active.subscribe(notify); notify(); } };
}
