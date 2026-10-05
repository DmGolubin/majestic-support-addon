import { describe, expect, it } from "vitest";
import { hard, soft, splitGreeting, stripMarker, titleKey, tokenize } from "../src/core/text";

describe("text", () => {
    it("soft keeps length, folds ё and nbsp", () => {
        expect(soft("Ёлка\u00A0X")).toBe("елка x");
        expect(soft("Ёлка\u00A0X").length).toBe(6);
    });
    it("hard drops {placeholders} and squeezes spaces", () => {
        expect(hard("  Привет {user name}  мир ")).toBe("привет мир");
        expect(tokenize("Server  NOT")).toEqual(["server", "not"]);
    });
    it("titleKey ignores punctuation and case", () => {
        expect(titleKey("Проблемы с соединением / Server not responding"))
            .toBe(titleKey("проблемы\u00A0 с соединением — server not responding!"));
    });
    it("splitGreeting uses panel marker", () => {
        const r = splitGreeting("**Привет!**\n[[greeting:end]]\nТело");
        expect(r).toEqual({ greeting: "**Привет!**", body: "Тело" });
    });
    it("splitGreeting falls back to first greeting paragraph", () => {
        const r = splitGreeting("**Приветствую! Благодарим Вас.**\n\n*Убедитесь…*\n\n1. Шаг");
        expect(r.greeting).toBe("**Приветствую! Благодарим Вас.**");
        expect(r.body).toBe("*Убедитесь…*\n\n1. Шаг");
    });
    it("splitGreeting leaves text without greeting", () => {
        expect(splitGreeting("Просто текст\n\nещё")).toEqual({ greeting: "", body: "Просто текст\n\nещё" });
    });
    it("stripMarker removes marker line like panel", () => {
        expect(stripMarker("A\n[[greeting:end]]\nB")).toBe("A\nB");
    });
});
