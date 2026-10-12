import { describe, expect, it } from "vitest";
import { clampTop } from "../src/core/layout";

// Window spans y = 100…600 (500 px).
describe("clampTop", () => {
    it("keeps the row's top when the box fits", () => {
        expect(clampTop(200, 100, 600, 300)).toBe(200);
    });
    it("never lets the box go below the window's bottom edge", () => {
        expect(clampTop(520, 100, 600, 300)).toBe(300);
        expect(clampTop(520, 100, 600, 300) + 300).toBe(600);
    });
    it("never goes above the window's top", () => {
        expect(clampTop(40, 100, 600, 120)).toBe(100);
    });
    it("a box taller than the window aligns to the window's top", () => {
        expect(clampTop(450, 100, 300, 320)).toBe(100);
    });
});
