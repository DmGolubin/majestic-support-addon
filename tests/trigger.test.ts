import { describe, expect, it } from "vitest";
import { findTrigger } from "../src/core/trigger";

describe("trigger", () => {
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
        expect(findTrigger("﻿.тех", ".")).toEqual({ query: "тех", length: 4 });
    });
});
