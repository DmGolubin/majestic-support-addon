/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useRef, useState } from "@webpack/common";

/** Shallow equality for plain objects/arrays (one level, Object.is per field). */
export function shallowEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => Object.is((a as any)[k], (b as any)[k]));
}

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
        /** Re-renders on every change. Prefer useSelect. */
        use(): T {
            const [, force] = useState(0);
            const current = value;
            useEffect(() => {
                const off = subscribe(() => force(x => x + 1));
                // Loading may finish between render and the passive-effect subscription.
                if (!Object.is(current, value)) force(x => x + 1);
                return off;
            }, []);
            return current;
        },
        /** Re-renders only when the selected slice changes (by isEqual). */
        useSelect<R>(selector: (v: T) => R, isEqual: (a: R, b: R) => boolean = Object.is): R {
            const [, force] = useState(0);
            const current = selector(value);
            const last = useRef(current);
            const sel = useRef(selector);
            const eq = useRef(isEqual);
            last.current = current;
            sel.current = selector;
            eq.current = isEqual;
            useEffect(() => {
                const check = () => {
                    const next = sel.current(value);
                    if (!eq.current(last.current, next)) {
                        last.current = next;
                        force(x => x + 1);
                    }
                };
                const off = subscribe(check);
                check(); // a change between render and subscribe
                return off;
            }, []);
            return current;
        },
    };
}
