import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { joinPieces } from "../src/core/compose";
import { splitGreeting } from "../src/core/text";

// Actual components and latch. The host fixture models native button activation followed
// by an Enter repeat in the newly focused chat; it does not send to Discord or any API.
const codes = Object.fromEntries(["Preview.tsx", "ComposeBar.tsx", "keylatch.ts"].map(name => [name,
    ts.transpileModule(readFileSync(new URL(`../src/vencord/ui/${name}`, import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
    }).outputText,
]));
type Node = { type: unknown; props: Record<string, any>; };
const text = (node: any): string => Array.isArray(node) ? node.map(text).join("")
    : node == null || typeof node === "boolean" ? "" : typeof node === "object" ? text(node.props?.children) : String(node);
const pathTo = (node: any, label: string, path: Node[] = []): Node[] | undefined => {
    if (Array.isArray(node)) return node.map(n => pathTo(n, label, path)).find(Boolean);
    if (!node || typeof node !== "object") return;
    const next = [...path, node];
    return node.type === "button" && text(node).trim() === label ? next : pathTo(node.props.children, label, next);
};

function harness() {
    const debug = { costStart: () => 0, costEnd() {}, dlog() {}, noteKey() {} };
    const effects: (() => any)[] = [];
    const hooks = {
        useMemo: (fn: () => any) => fn(), useRef: (current: any) => ({ current }),
        useState: (initial: any) => [typeof initial === "function" ? initial() : initial, vi.fn()],
        useEffect: (effect: () => any) => effects.push(effect),
    };
    const React = { createElement: (type: unknown, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };
    const template = { id: "q18-ui", title: "Answer", text: "Hello\n[[greeting:end]]\nBody", project: null, status: "actual", source: "local" };
    let state = { compose: [template.id] };
    let focus = "button", draft = "";
    const insert = vi.fn((value: string) => { focus = "chat"; draft += value; return true; });
    const deps: Record<string, any> = {
        "@webpack/common": hooks, "./debug": debug,
        "../core/compose": { joinPieces }, "../core/text": { splitGreeting }, "../core/types": {},
        "../platform": { insertText: insert, toast: vi.fn() },
        "./ProjectIcon": {}, "./svg": {}, "./markdown": {},
        "./op": { composeEditor: () => null, composeTargetNow: () => ({}), resetComposeTarget() {} },
        "./flow": {
            insertTemplate: async (_t: any, opts: any) => insert(opts?.noGreeting ? "Body" : "Hello\nBody"),
            addToCompose() {}, confirmedForeign: new Set(),
            fillFields: async (_title: string, value: string) => value,
            snapNow: () => ({ scope: "all" }), stillCurrent: () => true, focusTarget() {},
        },
        "./uiState": {
            store: { data: { usage: {} }, setVersion: 1, byId: () => template, isFavorite: () => false, markUsed() {}, subscribe: () => () => {} },
            ui: { get: () => state, set: (patch: any) => { state = { ...state, ...patch }; }, useSelect: (fn: any) => fn(state), subscribe: () => () => {} },
            useStore() {}, useChatRect: () => ({ left: 0, top: 600, width: 600 }), libraryIsFresh: () => true,
        },
    };
    const evaluate = (name: string) => {
        const exports: any = {};
        runInNewContext(codes[name], { exports, React, window: { innerHeight: 800 }, require: (id: string) => {
            if (!(id in deps)) throw new Error("Unexpected import " + id);
            return deps[id];
        } });
        return exports;
    };
    const latch = evaluate("keylatch.ts"); deps["./keylatch"] = latch;
    const preview = evaluate("Preview.tsx").Preview({ t: template });
    const compose = evaluate("ComposeBar.tsx").ComposeBar();
    effects.forEach(fn => fn());
    return { preview, compose, latch, insert, focus: () => focus, draft: () => draft };
}

const event = (key: string, code: string, extra: Record<string, unknown> = {}) => {
    const e: any = { key, code, keyCode: key === "Enter" ? 13 : 32, isComposing: false, repeat: false, defaultPrevented: false, ...extra };
    e.nativeEvent = e;
    e.preventDefault = () => { e.defaultPrevented = true; };
    e.stopPropagation = vi.fn();
    return e;
};

describe("Q18 UI native insertion button safety", () => {
    it.each([
        ["preview", "Вставить", "Enter"], ["preview", "Без приветствия", "Enter"],
        ["compose", "Вставить всё", "Enter"], ["preview", "Вставить", "NumpadEnter"],
    ])("%s / %s latches %s before focus returns to chat", async (surface, label, code) => {
        const h = harness(), path = pathTo(surface === "preview" ? h.preview : h.compose, label)!;
        expect(path).toBeDefined();
        const press = event("Enter", code);
        path.forEach(node => node.props.onKeyDownCapture?.(press));
        [...path].reverse().forEach(node => node.props.onKeyDown?.(press));
        expect(press.defaultPrevented).toBe(false); // Native activation remains available.
        await path.at(-1)!.props.onClick();
        expect(h.insert).toHaveBeenCalledTimes(1);
        expect(h.focus()).toBe("chat");
        expect(h.draft()).not.toBe("");
        const send = vi.fn();
        const repeat = event("Enter", code, { repeat: true });
        if (!h.latch.swallowLatched(repeat)) send(h.draft());
        expect(send, "held Enter must not reach the host's send handler").not.toHaveBeenCalled();
        expect(repeat.defaultPrevented).toBe(true);
        expect(h.latch.swallowLatched(event("Enter", code))).toBe(false); // A later fresh press is the user's.
    });

    it.each([{ isComposing: true }, { keyCode: 229 }])("does not latch IME activation: %j", composition => {
        const h = harness();
        for (const [tree, label] of [[h.preview, "Вставить"], [h.compose, "Вставить всё"]] as const) {
            const path = pathTo(tree, label)!;
            const e = event("Enter", "Enter", composition);
            path.forEach(node => node.props.onKeyDownCapture?.(e));
            [...path].reverse().forEach(node => node.props.onKeyDown?.(e));
            expect(h.latch.latchedCode()).toBeNull();
        }
    });
});
