import { describe, expect, it } from "vitest";
import { clock, formatEvent, Ring } from "../src/core/ring";

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
        expect(formatEvent({ t, type: "insert", data: { id: "x1", ok: true, skip: undefined }, n: 3 }))
            .toBe('09:05:07.042 insert id="x1" ok=true (×3)');
        expect(formatEvent({ t, type: "e", data: { s: "a".repeat(90) }, n: 1 })).toContain("…");
    });
});
