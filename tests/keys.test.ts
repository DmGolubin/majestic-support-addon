import { describe, expect, it } from "vitest";
import { bindProblem, comboLabel, comboOf } from "../src/core/keys";

const ev = (code: string, m: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; }> = {}) =>
    ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...m });

describe("keys", () => {
    it("builds layout-independent combos", () => {
        expect(comboOf(ev("KeyF", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+KeyF");
        expect(comboOf(ev("ShiftLeft", { shiftKey: true }))).toBeNull();
    });
    it("rejects reserved and modifier-less combos", () => {
        expect(bindProblem("Ctrl+KeyC")).not.toBe("");
        expect(bindProblem("Ctrl+Alt+KeyT")).not.toBe("");
        expect(bindProblem("Alt+Digit3")).not.toBe("");
        expect(bindProblem("KeyF")).not.toBe("");
        expect(bindProblem("Shift+KeyF")).not.toBe("");
        expect(bindProblem("F8")).toBe("");
        expect(bindProblem("Ctrl+Alt+KeyF")).toBe("");
    });
    it("labels combos", () => {
        expect(comboLabel("Ctrl+Alt+KeyF")).toBe("Ctrl+Alt+F");
        expect(comboLabel("Alt+Digit1")).toBe("Alt+1");
    });
});
