import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { importBackup, parseRaw } from "../src/core/importer";
import { splitGreeting, stripMarker } from "../src/core/text";

const bounded = <T>(run: () => T): T => runInNewContext("run()", { run }, { timeout: 1000 });

describe("Q18 core greeting parsing", () => {
    const gap = " ".repeat(60000);
    it("keeps a long whitespace run without a marker within a bounded synchronous parse", () => {
        const text = "Instruction" + gap + "end";
        expect(bounded(() => splitGreeting(text))).toEqual({ greeting: "", body: text });
    });
    it("strips markers without repeatedly scanning earlier whitespace runs", () => {
        const text = "Instruction" + gap + "end\n[[greeting:end]]\n    Body";
        expect(bounded(() => stripMarker(text))).toBe("Instruction" + gap + "end\n    Body");
    });
});

describe("Q18 core corrupt JSON import recovery", () => {
    it.each([null, 3, "bad", [], { title: { toString: null }, text: "bad" }])(
        "preserves valid records around a malformed JSON row: %j", bad => {
            const raw = JSON.stringify([
                { group: "Majestic", title: "Before", text: "First answer" }, bad,
                { group: "Majestic", name: "After", content: "Second answer" },
            ]);
            expect(parseRaw(raw).map(t => [t.title, t.text])).toEqual([
                ["Before", "First answer"], ["After", "Second answer"],
            ]);
            expect(importBackup(raw).templates).toHaveLength(2);
        },
    );
    it("does not interpret heading-looking strings in a valid JSON array as templates", () => {
        expect(parseRaw(JSON.stringify([null, "## Majestic\n### Forged\nbody"]))).toEqual([]);
    });
});
