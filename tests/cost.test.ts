import { afterEach, describe, expect, it, vi } from "vitest";
import { CostMeter, overlapLabel, significant, throttle } from "../src/core/cost";

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
        expect(overlapLabel(o, 50)).toBe("yes(inline,render,search)");
        expect(overlapLabel(m.overlap(400, 450), 50)).toBe("no");
    });
    it("tiny overlaps are minor: under 5 ms and under 10 % of the long task", () => {
        const m = new CostMeter();
        m.record("render", 100, 100.4); // 0.4 ms inside a 200 ms task
        const o = m.overlap(0, 200);
        expect(significant(o, 200)).toBe(false);
        expect(overlapLabel(o, 200)).toBe("minor(render)");
        expect(significant(o, 3)).toBe(true); // 0.4 ms of a 3 ms window is over 10 %
        m.record("keys", 120, 126); // 6 ms
        expect(overlapLabel(m.overlap(0, 200), 200)).toBe("yes(keys,render)");
    });
    it("window length: shorter right after clear, capped at 60 s", () => {
        const m = new CostMeter();
        m.clear(10_000);
        expect(m.windowMs(25_000)).toBe(15_000);
        expect(m.windowMs(200_000)).toBe(60_000);
        expect(m.windowMs(5_000)).toBe(0);
    });
    it("span ring holds 1024 spans by default", () => {
        const m = new CostMeter();
        for (let i = 0; i < 1024; i++) m.record(i === 0 ? "keys" : "render", i, i + 0.5);
        expect(m.overlap(0, 0.4).cats).toEqual(["keys"]);
        m.record("render", 2000, 2001);
        expect(m.overlap(0, 0.4).cats).toEqual([]);
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
