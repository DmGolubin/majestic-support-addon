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
});
