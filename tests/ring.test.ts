import { describe, expect, it } from "vitest";
import { CATEGORIES, categoryOf, clock, filterEvents, formatEvent, Ring } from "../src/core/ring";

describe("debug ring", () => {
    it("keeps only the last cap events, oldest first", () => {
        const r = new Ring(3);
        for (let i = 1; i <= 5; i++) r.push(i, "e", { i });
        expect(r.list().map(e => e.data.i)).toEqual([3, 4, 5]);
    });
    it("coalesces consecutive events with the same key", () => {
        const r = new Ring(30);
        r.push(1, "key", { k: "a" }, "swallow:Enter");
        r.push(2, "key", { k: "a" }, "swallow:Enter");
        r.push(3, "insert", {});
        r.push(4, "key", { k: "b" }, "swallow:Enter");
        const l = r.list();
        expect(l.map(e => [e.t, e.n])).toEqual([[2, 2], [3, 1], [4, 1]]);
    });
    it("events without a key never coalesce; clear empties", () => {
        const r = new Ring(30);
        r.push(1, "a", {});
        r.push(2, "a", {});
        expect(r.list()).toHaveLength(2);
        r.clear();
        expect(r.list()).toEqual([]);
    });
    it("list is a copy", () => {
        const r = new Ring(2);
        r.push(1, "a", {});
        const l = r.list();
        r.push(2, "b", {});
        expect(l).toHaveLength(1);
    });
    it("formats a line with clock, fields and repeat count", () => {
        const t = new Date(2026, 9, 12, 9, 5, 7, 42).getTime();
        expect(clock(t)).toBe("09:05:07.042");
        expect(formatEvent({ t, type: "insert", cat: "insert", data: { id: "x1", ok: true, skip: undefined }, n: 3 }))
            .toBe('09:05:07.042 insert id="x1" ok=true (×3)');
        expect(formatEvent({ t, type: "e", cat: "state", data: { s: "a".repeat(90) }, n: 1 })).toContain("…");
    });
    it("prints the category on request", () => {
        const t = new Date(2026, 9, 12, 9, 5, 7, 42).getTime();
        expect(formatEvent({ t, type: "wheel", cat: "wheel", data: { dy: 3 }, n: 1 }, true)).toBe("09:05:07.042 [wheel] wheel dy=3");
    });
    it("maps event types to categories", () => {
        const cases: [string, string][] = [
            ["key", "key"], ["keydown", "key"], ["keyup", "key"], ["latch", "key"],
            ["hover", "mouse"], ["mousedown", "mouse"], ["click", "mouse"], ["wheel", "wheel"],
            ["focusin", "focus"], ["focusout", "focus"], ["resize", "layout"], ["geometry", "layout"],
            ["insert", "insert"], ["insert-start", "insert"], ["inline-accept", "insert"], ["compose-add", "insert"], ["guard", "insert"], ["cancel", "insert"],
            ["dialog-open", "dialog"], ["dialog-close", "dialog"], ["dialog-supersede", "dialog"],
            ["channel", "channel"], ["search", "perf"], ["longtask", "perf"], ["error", "error"],
            ["peek", "state"], ["sel", "state"], ["inline", "state"], ["debug", "state"], ["whatever", "state"],
        ];
        for (const [type, cat] of cases) expect([type, categoryOf(type)]).toEqual([type, cat]);
        expect(CATEGORIES).toHaveLength(11);
    });
    it("stores the category and filters by it", () => {
        const r = new Ring(30);
        r.push(1, "keydown", {});
        r.push(2, "wheel", {});
        r.push(3, "keyup", {});
        expect(r.list().map(e => e.cat)).toEqual(["key", "wheel", "key"]);
        expect(filterEvents(r.list(), "key").map(e => e.t)).toEqual([1, 3]);
        expect(filterEvents(r.list(), null)).toHaveLength(3);
    });
    it("resizes: shrinking drops the oldest, growing keeps everything", () => {
        const r = new Ring(30);
        for (let i = 1; i <= 40; i++) r.push(i, "e", { i });
        expect(r.list()).toHaveLength(30);
        r.setCap(200);
        expect(r.cap).toBe(200);
        for (let i = 41; i <= 250; i++) r.push(i, "e", { i });
        expect(r.list()).toHaveLength(200);
        expect(r.list()[0].data.i).toBe(51);
        r.setCap(30);
        expect(r.list().map(e => e.data.i)).toEqual(Array.from({ length: 30 }, (_, k) => 221 + k));
    });
});
