import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as keys from "../src/core/keys";
import * as layout from "../src/core/layout";
import * as rank from "../src/core/rank";
import * as search from "../src/core/search";
import { Store } from "../src/core/state";
import * as text from "../src/core/text";
import * as types from "../src/core/types";

const compile = (file: string) => ts.transpileModule(readFileSync(new URL(`../src/vencord/ui/${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const opCode = compile("op.ts"), windowCode = compile("Window.tsx"), observableCode = compile("observable.ts");
function evaluate(code: string, dependencies: Record<string, any>, globals = {}) {
    const exports: any = {};
    runInNewContext(code, { exports, ...globals, require: (id: string) => {
        if (!(id in dependencies)) throw Error(`Unexpected import: ${id}`);
        return dependencies[id];
    } });
    return exports;
}

function targetHarness() {
    const { createObservable } = evaluate(observableCode, { "@webpack/common": {} });
    const ui = createObservable({ windowOpen: false, compose: [], dialog: null, menu: null });
    const subscriptions = new Set<() => void>();
    const subscribe = ui.subscribe;
    ui.subscribe = (fn: () => void) => {
        subscriptions.add(fn);
        const off = subscribe(fn);
        return () => { subscriptions.delete(fn); off(); };
    };
    const first = { isConnected: true, textContent: "first draft" };
    const second = { isConnected: true, textContent: "second draft" };
    const context = { focused: first, selection: "selected chat message" };
    const op = evaluate(opCode, { "../platform": { activeEditor: () => context.focused }, "./uiState": { ui } }, {
        window: { getSelection: () => context.selection },
    });
    return { ui, op, first, second, context, subscriptions };
}

describe("editor target retention", () => {
    it("drops the closed picker's detached editor while a captured pending insert still owns its target", async () => {
        const h = targetHarness();
        h.op.captureWindowTarget(h.first);
        h.ui.set({ windowOpen: true });
        const pendingTarget = h.op.targetNow();
        h.ui.set({ windowOpen: false });
        h.first.isConnected = false;
        h.context.focused = h.second;
        await Promise.resolve(); // An insert may still be awaiting fields/clipboard.
        expect(h.op.windowEditor()).toBeNull();
        expect(h.subscriptions.size).toBe(0);
        expect(pendingTarget.editor).toBe(h.first);
        expect(pendingTarget.selection).toBe("selected chat message");
        expect(h.op.targetNow().editor).toBe(h.second);
    });

    it("keeps the picker open and its original editor while the user selects chat text or opens a dialog", () => {
        const h = targetHarness();
        h.op.captureWindowTarget(h.first);
        h.ui.set({ windowOpen: true });
        h.context.focused = h.second;
        h.context.selection = "a different chat selection";
        h.ui.set({ menu: { id: "template" }, dialog: { kind: "fields" } });
        expect(h.ui.get().windowOpen).toBe(true);
        expect(h.op.windowEditor()).toBe(h.first);
        expect(h.op.targetNow().selection).toBe("selected chat message");
        expect(h.subscriptions.size).toBe(1);
        h.op.clearTargets();
        expect(h.subscriptions.size).toBe(0);
    });

    it("keeps compose's target after closing the picker, then releases it when the last piece is removed", () => {
        const h = targetHarness();
        h.op.captureWindowTarget(h.first);
        h.ui.set({ windowOpen: true });
        h.op.rememberComposeTarget();
        h.ui.set({ compose: ["one", "two"] });
        const pendingCompose = h.op.composeTargetNow();
        h.ui.set({ windowOpen: false });
        expect(h.op.windowEditor()).toBeNull();
        expect(h.op.composeEditor()).toBe(h.first);
        h.ui.set({ compose: ["two"] });
        expect(h.op.composeEditor()).toBe(h.first);
        h.first.isConnected = false;
        h.ui.set({ compose: [] });
        expect(h.op.composeEditor()).toBeNull();
        expect(pendingCompose.editor).toBe(h.first);
        expect(h.subscriptions.size).toBe(0);
    });

    it("clearing compose preserves an open picker; replacement/reopen never revives old targets", () => {
        const h = targetHarness();
        for (let cycle = 0; cycle < 20; cycle++) {
            h.op.captureWindowTarget(h.first);
            h.ui.set({ windowOpen: true });
            h.op.rememberComposeTarget();
            h.ui.set({ compose: ["one"] });
            h.ui.set({ compose: [] });
            expect(h.op.composeEditor()).toBeNull();
            expect(h.op.windowEditor()).toBe(h.first);
            h.op.rememberComposeTarget();
            h.ui.set({ compose: ["one"] });
            h.op.resetComposeTarget();
            expect(h.op.windowEditor()).toBe(h.first);
            expect(h.op.composeEditor()).toBeNull();
            expect(h.subscriptions.size).toBe(1);
            h.op.clearTargets(); h.op.clearTargets();
            expect(h.subscriptions.size).toBe(0);
            h.ui.set({ windowOpen: false, compose: [] });
            h.op.captureWindowTarget(h.second);
            h.ui.set({ windowOpen: true });
            expect(h.op.targetNow().editor).toBe(h.second);
            h.ui.set({ windowOpen: false });
            expect(h.op.windowEditor()).toBeNull();
            expect(h.subscriptions.size).toBe(0);
        }
    });
});

// Execute the entire Window with controlled render/commit phases. Uncommitted
// renders and old cleanup ordering can be tested without relying on React timing.
async function windowHarness() {
    const store = new Store({ get: async () => undefined, set: async () => {} });
    const first = await store.savePersonal({ title: "First fixture", text: "Alpha answer", project: "mj", command: null, color: null, folderId: null });
    const second = await store.savePersonal({ title: "Second fixture", text: "Beta answer", project: "mj", command: null, color: null, folderId: null });
    store.toggleFavorite(first);
    const insert = vi.fn(), compose = vi.fn();
    const slots: any[] = [];
    const cleanups = new Map<number, () => void>();
    let cursor = 0, pending: (() => void)[] = [];
    let state: any = { windowOpen: true, compose: [], dialog: null, menu: null };
    const common = {
        React: { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }), memo: (fn: any) => fn },
        useState: (initial: any) => {
            const i = cursor++;
            if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
            return [slots[i], (value: any) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
        },
        useRef: (initial: any) => { const i = cursor++; return slots[i] ??= { current: initial }; },
        useCallback: (fn: any) => fn,
        useMemo: (fn: any) => fn(),
        useEffect: () => {}, // Passive DOM/geometry effects are covered by runtime tests.
        useLayoutEffect: (setup: () => (() => void) | undefined) => {
            const i = cursor++;
            pending.push(() => {
                cleanups.get(i)?.();
                const cleanup = setup();
                if (cleanup) cleanups.set(i, cleanup); else cleanups.delete(i);
            });
        },
    };
    const debug = new Proxy({ debugState: { useSelect: () => false } }, { get: (object: any, key) => object[key] ?? (() => false) });
    const module = evaluate(windowCode, {
        "@webpack/common": common, "../core/keys": keys, "../core/layout": layout, "../core/rank": rank,
        "../core/search": search, "../core/text": text, "../core/types": types,
        "../platform": { chatAreaRect: () => null, storage: { get: async () => undefined } },
        "./ContextMenu": {}, "./debug": debug, "./flow": { insertTemplate: insert, addToCompose: compose },
        "./highlight": {}, "./keylatch": { latchKey: vi.fn() }, "./op": { windowEditor: () => null },
        "./Preview": { plural: (n: number) => String(n) }, "./ProjectIcon": {}, "./Select": {}, "./svg": {},
        "./uiState": { store, ui: { get: () => state, set: (patch: any) => { state = { ...state, ...patch }; }, useSelect: (fn: any) => fn(state) },
            useStore: () => 0, activeScope: () => "mj", listedProject: () => "mj", poolFor: () => store.templates },
        "./menu-refinement.css": {},
    }, { window: { innerWidth: 1400, innerHeight: 900 }, performance, clearTimeout });
    const render = () => { cursor = 0; pending = []; return module.Window(); };
    const commit = () => { for (const fn of pending.splice(0)) fn(); };
    const unmount = () => { for (const fn of cleanups.values()) fn(); cleanups.clear(); pending = []; slots.length = 0; };
    return { module, store, first, second, insert, compose, render, commit, unmount };
}
function find(node: any, predicate: (node: any) => boolean): any {
    if (!node || typeof node !== "object") return;
    if (predicate(node)) return node;
    for (const child of (node.props?.children ?? []).flat(Infinity)) {
        const result = find(child, predicate);
        if (result) return result;
    }
}
const keyEvent = (key: string, shiftKey = false) => ({ key, shiftKey, code: key, nativeEvent: { code: key },
    target: { closest: () => null }, preventDefault: vi.fn(), stopPropagation: vi.fn() });

describe("window shortcut catalog retention", () => {
    it("publishes committed favorites/search results and releases the catalog on unmount or stop", async () => {
        const h = await windowHarness();
        let tree = h.render();
        expect(h.module.visibleItems).toEqual([]);
        h.commit();
        expect(h.module.visibleItems.map((t: any) => t.id)).toEqual([h.first]);
        find(tree, n => n.type === "input").props.onChange({ currentTarget: { value: "fixture" } });
        tree = h.render();
        expect(h.module.visibleItems.map((t: any) => t.id)).toEqual([h.first]);
        h.commit();
        expect(h.module.visibleItems).toHaveLength(2);
        h.unmount();
        expect(h.module.visibleItems).toEqual([]);
        h.render(); h.commit();
        expect(h.module.visibleItems.map((t: any) => t.id)).toEqual([h.first]);
        h.unmount();
        expect(h.module.visibleItems).toEqual([]);
    });

    it("an abandoned search render cannot change Alt+N, and arrows/Enter still select the current row", async () => {
        const h = await windowHarness();
        let tree = h.render(); h.commit();
        const published = h.module.visibleItems;
        find(tree, n => n.type === "input").props.onChange({ currentTarget: { value: "Second fixture" } });
        h.render(); // Abandoned before commit.
        expect(h.module.visibleItems).toBe(published);
        h.unmount();
        tree = h.render(); h.commit();
        const win = () => find(tree, n => n.props?.className?.startsWith("vc-stx-win"));
        win().props.onKeyDown(keyEvent("ArrowDown"));
        tree = h.render(); h.commit();
        win().props.onKeyDown(keyEvent("Enter"));
        expect(h.insert).toHaveBeenCalledExactlyOnceWith(h.store.byId(h.second), { via: "window-enter" });
        win().props.onKeyDown(keyEvent("Enter", true));
        expect(h.compose).toHaveBeenCalledExactlyOnceWith(h.store.byId(h.second));
        h.unmount();
        expect(h.module.visibleItems).toEqual([]);
    });
});
