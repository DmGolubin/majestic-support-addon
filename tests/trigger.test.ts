import { describe, expect, it } from "vitest";
import { findTrigger, validPrefix } from "../src/core/trigger";

describe("trigger", () => {
    it("accepts custom punctuation and escapes regex characters", () => {
        for (const prefix of ["$", "^", "-", "?", "+"]) {
            expect(validPrefix(prefix)).toBe(true);
            expect(findTrigger(`${prefix}help`, prefix)).toEqual({ query: "help", length: 5 });
        }
        for (const prefix of ["/", "@", " ", "a", ";;", "["]) expect(validPrefix(prefix)).toBe(false);
    });
    it("finds ;word at line start or after space", () => {
        expect(findTrigger(";снр", ";")).toEqual({ query: "снр", length: 4 });
        expect(findTrigger("текст ;лог", ";")).toEqual({ query: "лог", length: 4 });
    });
    it("ignores mid-word, bare prefix and spaces after", () => {
        expect(findTrigger("abc;снр", ";")).toBeNull();
        expect(findTrigger(";", ";")).toBeNull();
        expect(findTrigger(";снр ", ";")).toBeNull();
    });
    it("ignores Slate zero-width chars and supports other prefixes", () => {
        expect(findTrigger("\uFEFF.тех", ".")).toEqual({ query: "тех", length: 4 });
    });
});
