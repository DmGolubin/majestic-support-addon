import { describe, expect, it } from "vitest";
import { decide } from "../src/core/guard";
import { parseRaw } from "../src/core/importer";
import { isValidBind } from "../src/core/keys";
import { Store } from "../src/core/state";
import { findTrigger, validPrefix } from "../src/core/trigger";

describe("Q18 core project mirror identity", () => {
    it("does not silently substitute unrelated punctuation-only titles across projects", () => {
        const [original, unrelated] = parseRaw("## Россия Онлайн\n### 🔑\nAccount instructions\n## Majestic\n### ⚠️\nConnection instructions");
        expect(decide(original, "mj", [original, unrelated])).toEqual({ kind: "foreign", t: original });
    });
});

describe("Q18 core trigger and binding boundaries", () => {
    it.each([";he\uFEFFlp", ";help\uFEFF", ";\uFEFFhelp", "\uFEFF;he\uFEFFlp\uFEFF"])(
        "selects the entire source trigger, including internal Slate zero-width characters: %j", source => {
            const before = "Draft " + source;
            const trigger = findTrigger(before, ";")!;
            expect(trigger.query).toBe("help");
            expect(before.slice(0, -trigger.length)).toBe("Draft " + (source.startsWith("\uFEFF") ? "\uFEFF" : ""));
            expect(before.slice(-trigger.length).replace(/\uFEFF/g, "")).toBe(";help");
        },
    );
    it.each([";\n", "!\n", ".\n"])("rejects newline-terminated prefixes: %j", prefix => {
        expect(validPrefix(prefix)).toBe(false);
        const store = new Store({ get: async () => undefined, set: async () => {} });
        expect(() => store.setPrefix(prefix)).toThrow();
    });
    it("rejects newline-terminated function-key bindings that can never match a keyboard event", () => {
        expect(isValidBind("F5\n")).toBe(false);
        expect(isValidBind("Ctrl+F5\n")).toBe(false);
        expect(isValidBind("F5")).toBe(true);
    });
});
