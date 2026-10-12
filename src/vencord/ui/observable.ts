/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useState } from "@webpack/common";

export function createObservable<T extends object>(initial: T) {
    let value = initial;
    const subs = new Set<() => void>();
    const subscribe = (fn: () => void) => {
        subs.add(fn);
        return () => void subs.delete(fn);
    };
    return {
        get: () => value,
        set(patch: Partial<T>) {
            value = { ...value, ...patch };
            subs.forEach(fn => fn());
        },
        subscribe,
        use(): T {
            const [, force] = useState(0);
            useEffect(() => subscribe(() => force(x => x + 1)), []);
            return value;
        },
    };
}
