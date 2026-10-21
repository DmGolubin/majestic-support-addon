import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Exercise the actual diagnostic functions without loading Vencord/Discord or a DOM.
const source = ts.createSourceFile("debug.ts", readFileSync(new URL("../src/vencord/ui/debug.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const names = ["maskKey", "keyDesc", "keyFields", "flushKey", "onVKeyUp"];
const functions = source.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && !!s.name && names.includes(s.name.text));
const js = ts.transpileModule(functions.map(f => f.getText(source)).join("\n"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

type Key = {
    key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean;
    isComposing: boolean; keyCode: number; repeat: boolean; getModifierState(name: string): boolean;
    target: { closest(selector: string): object | null };
};
const event = (patch: Partial<Key> = {}, password = false, search = false): Key => ({
    key: "x", code: "KeyX", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    isComposing: false, keyCode: 0, repeat: false, getModifierState: () => false,
    target: { closest: selector => (selector === 'input[type="password"]' ? password : selector === ".vc-stx-sinput" && search) ? {} : null },
    ...patch
});
function harness(e: Key) {
    const logs: unknown[][] = [];
    const api = runInNewContext(js + "\n({ keyFields, keyDesc, flushKey, onVKeyUp });", {
        exports: {}, pendingKey: { ev: e, h: "none" }, describeEl: () => "input",
        dlog: (...args: unknown[]) => logs.push(args)
    }) as {
        keyFields(e: Key): { masked: boolean; data: { key: string; code: string } };
        keyDesc(e: Key & { nativeEvent?: Key }): string;
        flushKey(): void; onVKeyUp(e: Key): void;
    };
    return { api, logs };
}

describe("diagnostic keyboard privacy", () => {
    it.each([
        ["plain text", event()],
        ["shifted text", event({ key: "X", shiftKey: true })],
        ["supplementary Unicode", event({ key: "\u{1F600}" })],
        ["Windows AltGr", event({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true })],
        ["AltGraph modifier", event({ key: "@", code: "KeyQ", altKey: true, getModifierState: name => name === "AltGraph" })],
        ["AltGr in search", event({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true }, false, true)],
        ["password shortcut", event({ ctrlKey: true }, true)],
        ["password navigation", event({ key: "ArrowLeft", code: "ArrowLeft" }, true)],
        ["password with search class", event({}, true, true)],
        ["composition", event({ isComposing: true, ctrlKey: true })],
        ["composition in search", event({ isComposing: true }, false, true)],
        ["legacy IME", event({ keyCode: 229, ctrlKey: true })],
        ["Process in search", event({ key: "Process" }, false, true)],
        ["dead key", event({ key: "Dead", altKey: true })],
        ["unidentified key", event({ key: "Unidentified" })]
    ] as const)("masks %s in data, summaries and coalescing keys", (_name, e) => {
        const { api, logs } = harness(e);
        expect(api.keyFields(e)).toMatchObject({ masked: true, data: { key: "симв.", code: "•" } });
        expect(api.keyDesc(e)).toBe("симв.");
        api.flushKey();
        api.onVKeyUp(e);
        expect(logs).toHaveLength(1); // Masked keyup must not reintroduce the physical key.
        expect(logs[0]).toMatchObject(["keydown", { key: "симв.", code: "•" }, "kd:typing:none"]);
        expect(JSON.stringify(logs)).not.toContain(e.code);
    });

    it("uses native composition state for React shortcut summaries", () => {
        const e = event({ ctrlKey: true });
        const { api } = harness(e);
        expect(api.keyDesc({ ...e, nativeEvent: event({ isComposing: true }) })).toBe("симв.");
    });

    it("keeps ordinary shortcuts and navigation useful", () => {
        const e = event({ key: "c", code: "KeyC", ctrlKey: true });
        const { api, logs } = harness(e);
        expect(api.keyDesc(e)).toBe("Ctrl+KeyC");
        expect(api.keyFields(e)).toMatchObject({ masked: false, data: { key: "c", code: "KeyC" } });
        api.flushKey(); api.onVKeyUp(e);
        expect(logs).toHaveLength(2);
        expect(api.keyDesc(event({ key: "ArrowDown", code: "ArrowDown" }))).toBe("ArrowDown");
    });

    it("preserves the existing plain-search diagnostics exception", () => {
        const e = event({}, false, true);
        expect(harness(e).api.keyFields(e)).toMatchObject({ masked: false, data: { key: "x", code: "KeyX" } });
    });
});
