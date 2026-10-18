import { describe, expect, it } from "vitest";
import { joinPieces } from "../src/core/compose";

describe("compose", () => {
    it("keeps greeting only in the first piece", () => {
        const a = "**Приветствую!**\n\nПервый";
        const b = "**Приветствую!**\n\nВторой";
        expect(joinPieces([a, b])).toBe("**Приветствую!**\n\nПервый\n\nВторой");
    });
    it("strips panel markers", () => {
        expect(joinPieces(["Привет\n[[greeting:end]]\nA", "Привет\n[[greeting:end]]\nB"])).toBe("Привет\nA\n\nB");
    });
    it("preserves instructions mentioning greetings in later pieces", () => {
        const instruction = "Отключите приветствие в настройках.\n\n**Перезапустите игру.**";
        expect(joinPieces(["Первый ответ.", instruction])).toBe(`Первый ответ.\n\n${instruction}`);
    });
    it("preserves the first inline boundary and removes only the explicit greeting in later pieces", () => {
        expect(joinPieces(["Здравствуйте![[greeting:end]]\n**Первый**", "Вступление.[[greeting:end]]\n**Второй**"]))
            .toBe("Здравствуйте!\n**Первый**\n\n**Второй**");
    });
});
