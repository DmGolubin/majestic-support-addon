import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the real document-capture handler without loading Discord.
const source = readFileSync(new URL("../src/vencord/ui/ContextMenu.tsx", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("const key = (e: KeyboardEvent) => {"), source.indexOf("const blur =", source.indexOf("const key = (e: KeyboardEvent) => {")));
const code = ts.transpileModule(handler + "\nkey(event);", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

describe("context menu composition", () => {
    it.each([{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }])("leaves composing Enter untouched: %j", composition => {
        const event = { key: "Enter", code: "Enter", repeat: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...composition };
        const run = vi.fn();
        runInNewContext(code, { event, run });
        expect(run).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(event.stopPropagation).not.toHaveBeenCalled();
    });
    it("still executes the visible selected action for ordinary Enter", () => {
        const run = vi.fn(), latchKey = vi.fn();
        const event = { key: "Enter", code: "Enter", repeat: false, isComposing: false, keyCode: 13, preventDefault: vi.fn(), stopPropagation: vi.fn() };
        runInNewContext(code, { event, run, latchKey, ref: { current: { style: { visibility: "visible" } } }, itemsRef: { current: ["insert"] }, activeRef: { current: 0 } });
        expect(run).toHaveBeenCalledWith(0);
        expect(latchKey).toHaveBeenCalledWith("Enter");
    });
});
