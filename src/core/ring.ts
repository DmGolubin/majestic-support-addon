/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** One debug event. `n` > 1 = the same coalesced event repeated n times. */
export interface DebugEvent {
    t: number;
    type: string;
    data: Record<string, unknown>;
    key?: string;
    n: number;
}

/** Fixed-size event log: the oldest entry falls out. Coalescing (same key as the newest entry) replaces it in place. */
export class Ring {
    private items: DebugEvent[] = [];
    constructor(readonly cap: number) { }

    push(t: number, type: string, data: Record<string, unknown>, key?: string) {
        const last = this.items[this.items.length - 1];
        if (key !== undefined && last?.key === key) {
            this.items[this.items.length - 1] = { t, type, data, key, n: last.n + 1 };
            return;
        }
        this.items.push({ t, type, data, key, n: 1 });
        if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
    }

    /** Oldest first; a copy, safe to keep. */
    list(): DebugEvent[] {
        return this.items.slice();
    }

    clear() {
        this.items = [];
    }
}

/** Local HH:MM:SS.mmm. */
export function clock(ms: number): string {
    const d = new Date(ms);
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** One log line: `HH:MM:SS.mmm type k=v k=v (×n)`. Strings are quoted, long ones cut. */
export function formatEvent(e: DebugEvent): string {
    const parts = Object.entries(e.data)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v.length > 80 ? v.slice(0, 80) + "…" : v) : String(v)}`);
    return `${clock(e.t)} ${e.type}${parts.length ? " " + parts.join(" ") : ""}${e.n > 1 ? ` (×${e.n})` : ""}`;
}
