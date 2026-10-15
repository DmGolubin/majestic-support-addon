import { describe, expect, it } from "vitest";
import { fieldToken, insertToken } from "../src/core/tokenEditor";
import { fieldsOf, fill } from "../src/core/tokens";

describe("editor token insertion", () => {
    it("creates fields and lists understood by the insertion engine", () => {
        const text = fieldToken("ник", "Игрок", false) + fieldToken("сервер", "Первый\nВторой", true);
        expect(fieldsOf(text)).toEqual([{ name: "ник", def: "Игрок", options: [] }, { name: "сервер", def: "", options: ["Первый", "Второй"] }]);
        expect(fill(text, { ник: "Иван", сервер: "Второй" }, { now: new Date(), clipboard: "", selection: "", url: "", title: "" }).text).toBe("ИванВторой");
    });
    it("rejects reserved names and delimiters without damaging grammar", () => {
        for (const name of ["", "date", "time+2h", "clipboard", "a|b", "a=b", "{{x}}"])
            expect(() => fieldToken(name, "", false)).toThrow();
        expect(() => fieldToken("x", "a|b", false)).toThrow();
        expect(() => fieldToken("x", "one", true)).toThrow();
    });
    it("replaces selection and returns the caret after the new token", () => {
        expect(insertToken("ABCD", 1, 3, "{{date}}")).toEqual({ text: "A{{date}}D", caret: 9 });
        expect(insertToken("abc", 99, 99, "!")).toEqual({ text: "abc!", caret: 4 });
    });
    it("enforces the text limit for programmatic insertion too", () => {
        expect(() => insertToken("x".repeat(20000), 0, 0, "{{time}}")).toThrow();
        expect(insertToken("x".repeat(20000), 0, 8, "{{time}}").text.length).toBe(20000);
    });
});
