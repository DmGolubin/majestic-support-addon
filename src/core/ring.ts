/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const CATEGORIES = ["key", "mouse", "wheel", "focus", "layout", "insert", "dialog", "channel", "perf", "error", "state"] as const;
export type Category = typeof CATEGORIES[number];

/** The filter category of an event type. Unknown types are plugin state changes. */
export function categoryOf(type: string): Category {
    if (type === "key" || type === "latch" || type === "keydown" || type === "keyup") return "key";
    if (type === "hover" || type === "mousedown" || type === "click") return "mouse";
    if (type === "wheel") return "wheel";
    if (type === "focusin" || type === "focusout") return "focus";
    if (type === "resize" || type === "geometry") return "layout";
    if (type.startsWith("insert") || type === "inline-accept" || type === "compose-add" || type === "guard" || type === "cancel") return "insert";
    if (type.startsWith("dialog")) return "dialog";
    if (type === "channel") return "channel";
    if (type === "search" || type === "longtask" || type === "perf") return "perf";
    if (type === "error") return "error";
    return "state";
}

/** One debug event. `n` > 1 = the same coalesced event repeated n times. */
export interface DebugEvent {
    t: number;
    type: string;
    cat: Category;
    data: Record<string, unknown>;
    key?: string;
    n: number;
}

/** Fixed-size event log: the oldest entry falls out. Coalescing (same key as the newest entry) replaces it in place. */
export class Ring {
    private items: DebugEvent[] = [];
    constructor(private size: number) { }

    get cap() { return this.size; }

    /** Number of stored entries. */
    get length() { return this.items.length; }

    /** Changes the size; shrinking drops the oldest entries. */
    setCap(n: number) {
        this.size = n;
        this.trim();
    }

    push(t: number, type: string, data: Record<string, unknown>, key?: string) {
        const last = this.items[this.items.length - 1];
        const cat = categoryOf(type);
        if (key !== undefined && last?.key === key) {
            this.items[this.items.length - 1] = { t, type, cat, data, key, n: last.n + 1 };
            return;
        }
        this.items.push({ t, type, cat, data, key, n: 1 });
        this.trim();
    }

    private trim() {
        if (this.items.length > this.size) this.items.splice(0, this.items.length - this.size);
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

/** Events of one category (null = all). */
export function filterEvents(events: DebugEvent[], cat: Category | null): DebugEvent[] {
    return cat ? events.filter(e => e.cat === cat) : events;
}

/** One log line: `HH:MM:SS.mmm [cat] type k=v k=v (×n)`. Strings are quoted, long ones cut. */
export function formatEvent(e: DebugEvent, withCat = false): string {
    const parts = Object.entries(e.data)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v.length > 80 ? v.slice(0, 80) + "…" : v) : String(v)}`);
    return `${clock(e.t)}${withCat ? ` [${e.cat}]` : ""} ${e.type}${parts.length ? " " + parts.join(" ") : ""}${e.n > 1 ? ` (×${e.n})` : ""}`;
}
