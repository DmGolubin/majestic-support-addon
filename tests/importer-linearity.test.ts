import { describe, expect, it, vi } from "vitest";
import { localId, parseRawInfo } from "../src/core/importer";

const raw = (titles: string[]) => JSON.stringify(titles.map((title, i) => ({ group: "Majestic", title, text: `body ${i}` })));

describe("duplicate import stability and work bounds", () => {
    it("preserves reserved IDs, gaps, nested suffixes and record order across reloads", () => {
        const input = raw(["Same", "Same", "Same#2", "Same", "Same#4", "Same#2", "Same#2#2", "Other", "Other"]);
        const first = parseRawInfo(input);
        expect(first.templates.map(t => t.id)).toEqual(
            ["Same", "Same#3", "Same#2", "Same#5", "Same#4", "Same#2#3", "Same#2#2", "Other", "Other#2"].map(t => localId("Majestic", t))
        );
        expect(first.templates.map(t => t.text)).toEqual(Array.from({ length: 9 }, (_, i) => `body ${i}`));
        expect(first.dupes).toBe(4);
        expect(parseRawInfo(input)).toEqual(first);
    });

    it.each([500, 2000])("bounds duplicate/collision probes for %i repeated records", count => {
        const reserved = Array.from({ length: count / 2 }, (_, i) => `Same#${i + 2}`);
        const input = raw([...Array<string>(count).fill("Same"), ...reserved]);
        const total = count + reserved.length;
        const has = Set.prototype.has;
        let probes = 0;
        // Count work rather than wall time; abort early if quadratic scanning returns.
        const spy = vi.spyOn(Set.prototype, "has").mockImplementation(function (this: Set<unknown>, value: unknown) {
            if (++probes > total * 6) throw new Error("Duplicate import exceeded linear probe budget");
            return has.call(this, value);
        });
        let result: ReturnType<typeof parseRawInfo>;
        try { result = parseRawInfo(input); } finally { spy.mockRestore(); }
        expect(result.templates).toHaveLength(total);
        expect(new Set(result.templates.map(t => t.id)).size).toBe(total);
        expect(result.dupes).toBe(count - 1);
        expect(result.templates.slice(count).map(t => t.id)).toEqual(reserved.map(t => localId("Majestic", t)));
    });
});
