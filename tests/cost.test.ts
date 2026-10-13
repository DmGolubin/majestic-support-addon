import { afterEach, describe, expect, it, vi } from "vitest";
import { CostMeter, overlapLabel, throttle } from "../src/core/cost";

describe("cost meter", () => {
    it("sums per category over the last 60 seconds", () => {
        const m = new CostMeter();
        m.record("keys", 1000, 1002);
        m.record("keys", 2000, 2001.5);
        m.record("render", 3000, 3010);
        const s = m.sums(5000);
        expect(s.keys).toEqual({ ms: 3.5, n: 2 });
        expect(s.render).toEqual({ ms: 10, n: 1 });
        expect(s.inline).toEqual({ ms: 0, n: 0 });
    });
    it("drops seconds older than the window, also when a bucket is reused", () => {
        const m = new CostMeter();
        m.record("inline", 1000, 1004); // second 1
        expect(m.sums(60_500).inline.n).toBe(1); // second 60: 1 > 0 → still inside
        expect(m.sums(61_000).inline.n).toBe(0); // second 61: out
        m.record("inline", 61_000, 61_001); // second 61 reuses bucket 1
        expect(m.sums(61_500).inline).toEqual({ ms: 1, n: 1 });
    });
    it("total excludes nested search (inside render)", () => {
        const m = new CostMeter();
        m.record("render", 100, 110);
        m.record("search", 102, 106);
        m.record("keys", 200, 201);
        expect(m.total(1000)).toBe(11);
    });
    it("overlap: categories and union length inside the long task window", () => {
        const m = new CostMeter();
        m.record("render", 100, 110);
        m.record("search", 102, 106); // nested: not counted twice
        m.record("inline", 150, 160); // half inside
        m.record("keys", 300, 301); // outside
        const o = m.overlap(105, 155);
        expect(o.cats).toEqual(["inline", "render", "search"]);
        expect(o.ms).toBe(5 + 5);
        expect(overlapLabel(o)).toBe("yes(inline,render,search)");
        expect(overlapLabel(m.overlap(400, 450))).toBe("no");
    });
    it("span ring keeps only the latest spans; clear empties", () => {
        const m = new CostMeter(2);
        m.record("keys", 0, 1);
        m.record("render", 10, 11);
        m.record("inline", 20, 21);
        expect(m.overlap(0, 100).cats).toEqual(["inline", "render"]);
        m.clear();
        expect(m.overlap(0, 100).cats).toEqual([]);
        expect(m.sums(50).inline.n).toBe(0);
    });
});

describe("throttle", () => {
    afterEach(() => { vi.useRealTimers(); });
    it("runs at most once per period, never synchronously, trailing call guaranteed", () => {
        vi.useFakeTimers();
        const fn = vi.fn();
        const t = throttle(250, fn);
        t.call();
        expect(fn).toHaveBeenCalledTimes(0); // deferred
        vi.advanceTimersByTime(0);
        expect(fn).toHaveBeenCalledTimes(1);
        for (let i = 0; i < 10; i++) { t.call(); vi.advanceTimersByTime(20); } // 200 ms of bursts
        expect(fn).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(50);
        expect(fn).toHaveBeenCalledTimes(2); // trailing, 250 ms after the first
        vi.advanceTimersByTime(1000);
        expect(fn).toHaveBeenCalledTimes(2);
        t.call();
        t.cancel();
        vi.advanceTimersByTime(1000);
        expect(fn).toHaveBeenCalledTimes(2);
    });
});
