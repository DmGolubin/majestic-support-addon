/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Plugin cost accounting (debug mode): wall time spent inside the plugin's own code, per category,
// as rolling 60-second sums, plus a small ring of the latest work spans to tell whether a long task
// overlapped plugin work. Pure: times are passed in (performance.now() milliseconds).

export const COST_CATS = ["keys", "inline", "render", "search", "debug"] as const;
export type CostCat = typeof COST_CATS[number];

/** Categories whose spans run inside another category's span (search runs inside the window's render). */
export const NESTED_CATS: readonly CostCat[] = ["search"];

const WINDOW_S = 60;

interface Bucket { sec: number; ms: number; n: number; }

export interface CostSum { ms: number; n: number; }

export interface Overlap {
    /** Categories with at least one span intersecting the window, in COST_CATS order. */
    cats: CostCat[];
    /** Length of the union of the intersections (nested spans are not counted twice). */
    ms: number;
}

export class CostMeter {
    /** Per category: one bucket per second of the last minute (index = second % 60). */
    private buckets = new Map<CostCat, Bucket[]>();
    private spanStart: Float64Array;
    private spanEnd: Float64Array;
    private spanCat: (CostCat | null)[];
    private next = 0;

    constructor(private spans = 256) {
        this.spanStart = new Float64Array(spans);
        this.spanEnd = new Float64Array(spans);
        this.spanCat = new Array(spans).fill(null);
        for (const c of COST_CATS) this.buckets.set(c, Array.from({ length: WINDOW_S }, () => ({ sec: -1, ms: 0, n: 0 })));
    }

    /** One finished span of plugin work. O(1). */
    record(cat: CostCat, start: number, end: number) {
        const sec = Math.floor(end / 1000);
        const b = this.buckets.get(cat)![sec % WINDOW_S];
        if (b.sec !== sec) { b.sec = sec; b.ms = 0; b.n = 0; }
        b.ms += end - start;
        b.n++;
        const i = this.next;
        this.spanStart[i] = start;
        this.spanEnd[i] = end;
        this.spanCat[i] = cat;
        this.next = (i + 1) % this.spans;
    }

    /** Sums over the last 60 seconds (the current second included). */
    sums(now: number): Record<CostCat, CostSum> {
        const nowSec = Math.floor(now / 1000);
        const out = {} as Record<CostCat, CostSum>;
        for (const c of COST_CATS) {
            let ms = 0, n = 0;
            for (const b of this.buckets.get(c)!) {
                if (b.sec > nowSec - WINDOW_S && b.sec <= nowSec) { ms += b.ms; n += b.n; }
            }
            out[c] = { ms, n };
        }
        return out;
    }

    /** Total plugin ms over the last 60 seconds, nested categories excluded (already inside their parent). */
    total(now: number): number {
        const s = this.sums(now);
        return COST_CATS.filter(c => !NESTED_CATS.includes(c)).reduce((a, c) => a + s[c].ms, 0);
    }

    /** Which recent spans intersect [start, end] (a long task's window). */
    overlap(start: number, end: number): Overlap {
        const hit = new Set<CostCat>();
        const parts: [number, number][] = [];
        for (let i = 0; i < this.spans; i++) {
            const c = this.spanCat[i];
            if (!c) continue;
            const s = Math.max(start, this.spanStart[i]), e = Math.min(end, this.spanEnd[i]);
            if (e < s) continue;
            hit.add(c);
            parts.push([s, e]);
        }
        parts.sort((a, b) => a[0] - b[0]);
        let ms = 0, curS = 0, curE = -Infinity;
        for (const [s, e] of parts) {
            if (s > curE) {
                if (curE > curS) ms += curE - curS;
                curS = s;
                curE = e;
            } else if (e > curE) curE = e;
        }
        if (curE > curS) ms += curE - curS;
        return { cats: COST_CATS.filter(c => hit.has(c)), ms };
    }

    clear() {
        for (const bs of this.buckets.values()) for (const b of bs) { b.sec = -1; b.ms = 0; b.n = 0; }
        this.spanCat.fill(null);
        this.next = 0;
    }
}

/** `longtask` log value: "yes(inline,render)" / "no". */
export const overlapLabel = (o: Overlap) => o.cats.length ? `yes(${o.cats.join(",")})` : "no";

/**
 * At most one call of `fn` per `ms`, always from a timer (never synchronously inside the caller,
 * which may be another component's render). Calls while one is pending coalesce into it, so the
 * last change is never dropped. `cancel` drops a pending call.
 */
export function throttle(ms: number, fn: () => void, now: () => number = () => Date.now()) {
    let last = -Infinity;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => { timer = null; last = now(); fn(); };
    return {
        call() {
            if (timer) return;
            timer = setTimeout(run, Math.max(0, last + ms - now()));
        },
        cancel() {
            if (timer) clearTimeout(timer);
            timer = null;
        },
    };
}
