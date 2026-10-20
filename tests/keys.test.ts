import { describe, expect, it } from "vitest";
import { bindProblem, comboLabel, comboOf, startsPeek } from "../src/core/keys";

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

describe("startsPeek", () => {
    const k = (m: Partial<{ key: string; repeat: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; }> = {}) =>
        ({ key: "Shift", repeat: false, ctrlKey: false, altKey: false, metaKey: false, ...m });
    it("peeks with focus in the window", () => {
        expect(startsPeek(k(), true, false)).toBe(true);
    });
    it("peeks with focus lost to body while the pointer is over the window (the Task 20 bug)", () => {
        expect(startsPeek(k(), false, true)).toBe(true);
    });
    it("does not peek when neither focus nor pointer is in the window", () => {
        expect(startsPeek(k(), false, false)).toBe(false);
    });
    it("ignores repeats, other keys and system combos", () => {
        expect(startsPeek(k({ repeat: true }), true, true)).toBe(false);
        expect(startsPeek(k({ key: "Enter" }), true, true)).toBe(false);
        expect(startsPeek(k({ metaKey: true }), true, true)).toBe(false);
        expect(startsPeek(k({ ctrlKey: true }), true, true)).toBe(false);
        expect(startsPeek(k({ altKey: true }), true, true)).toBe(false);
    });
});
