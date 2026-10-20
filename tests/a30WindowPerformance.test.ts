import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as layout from "../src/core/layout";
import * as geometry from "../src/core/windowPlacement";
import * as types from "../src/core/types";
import * as rank from "../src/core/rank";
import * as search from "../src/core/search";
import * as keys from "../src/core/keys";
import { Store } from "../src/core/state";

const compile = (name: string) => ts.transpileModule(readFileSync(new URL(`../src/vencord/ui/${name}.tsx`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const code = { Window: compile("Window"), WindowPlacement: compile("WindowPlacement") };
const nodes = (n: any): any[] => Array.isArray(n) ? n.flatMap(nodes) : n?.props ? [n, ...nodes(n.props.children)] : [];
function hooks() {
    let cursor = 0, rowElements = 0;
    const slots: any[] = [], cleanups: (() => void)[] = [], effects: (() => void)[] = [];
    const same = (a: any[], b: any[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    const api = {
        React: { createElement: (type: any, props: any, ...children: any[]) => {
            if (props?.t && "sel" in props) rowElements++;
            return { type, props: { ...props, children } };
        }, memo: (fn: any) => fn },
        useState(initial: any) {
            const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
            return [slots[i], (value: any) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
        },
        useRef(initial: any) { return slots[cursor++] ??= { current: initial }; },
        useMemo(fn: any, deps: any[]) {
            const i = cursor++;
            if (!same(slots[i]?.deps, deps)) slots[i] = { deps, value: fn() };
            return slots[i].value;
        },
        useCallback(fn: any, deps: any[]) { return api.useMemo(() => fn, deps); },
        useEffect(fn: any, deps: any[]) {
            const i = cursor++;
            if (!same(slots[i], deps)) { slots[i] = deps; effects.push(() => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); }); }
        },
        useLayoutEffect() {},
    };
    return { api, render: (fn: any) => { cursor = 0; const tree = fn(); effects.splice(0).forEach(effect => effect()); return tree; }, rows: () => rowElements,
        unmount: () => cleanups.forEach(fn => fn()) };
}
function load(source: string, deps: any, globals = {}) {
    const exports: any = {};
    runInNewContext(source, { exports, ...globals, require: (id: string) => {
        if (id.endsWith(".css")) return {};
        if (!(id in deps)) throw new Error(`Missing ${id}`);
        return deps[id];
    } });
    return exports;
}
function placement() {
    const h = hooks(), frames = new Map<number, () => void>(), listeners = new Map<string, () => void>();
    let sequence = 0, position: geometry.WindowPosition | null = null;
    const set = vi.fn((value: geometry.WindowPosition | null, _persist?: boolean) => { position = value; });
    const setSize = vi.fn(), saveSize = vi.fn();
    const requestAnimationFrame = (fn: () => void) => { frames.set(++sequence, fn); return sequence; };
    const cancelAnimationFrame = (id: number) => { frames.delete(id); };
    const window = { innerWidth: 1600, innerHeight: 1000, requestAnimationFrame, cancelAnimationFrame,
        addEventListener: (name: string, fn: () => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) };
    const module = load(code.WindowPlacement, { "@webpack/common": h.api, "../core/layout": layout,
        "../core/windowPlacement": geometry, "../platform": { storage: {} } }, { window, requestAnimationFrame, cancelAnimationFrame });
    const render = () => h.render(() => module.WindowPlacementControls({
        placement: { position, set }, box: { right: 200, bottom: 100, width: 400, height: 500 },
        size: null, side: false, setSize, saveSize,
    }));
    const el = { focus() {}, setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture: vi.fn() };
    const pointer = (x: number, y = 0) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, currentTarget: el, preventDefault() {}, stopPropagation() {} });
    const grip = (edge = false) => nodes(render()).find(n => n.props.className === (edge ? "vc-stx-frame-resize edge-nw" : "vc-stx-drag-window")).props;
    return { ...h, grip, pointer, set, setSize, saveSize, frames, listeners, el,
        frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); } };
}

describe("A30 placement rendering budget and gesture safety", () => {
    it("coalesces 240 pointer samples into 60 visual updates, with only one persistent commit", () => {
        const h = placement(), grip = h.grip(); grip.onPointerDown(h.pointer(0));
        const start = performance.now();
        for (let frame = 0; frame < 60; frame++) {
            for (let sample = 0; sample < 4; sample++) grip.onPointerMove(h.pointer(frame * 4 + sample + 1));
            h.frame();
        }
        const elapsed = performance.now() - start;
        const visualUpdates = h.set.mock.calls.length;
        grip.onPointerUp(h.pointer(240));
        console.info("A30 pointer benchmark", { samples: 240, frames: 60, visualUpdates, elapsedMs: Number(elapsed.toFixed(2)) });
        expect(visualUpdates).toBe(60);
        expect(h.set.mock.calls.filter(call => call[1] !== false)).toHaveLength(1);
        expect(h.set).toHaveBeenLastCalledWith({ right: 8, bottom: 100, pinned: false });
        expect(h.frames.size).toBe(0); h.unmount();
    });

    it.each(["up", "escape", "cancel", "lost", "blur", "unmount"])("handles %s before the queued frame without late writes", action => {
        const h = placement(), grip = h.grip(true);
        grip.onPointerDown(h.pointer(0)); grip.onPointerMove(h.pointer(-75, -40));
        if (action === "up") grip.onPointerUp(h.pointer(-75, -40));
        if (action === "escape") grip.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
        if (action === "cancel") grip.onPointerCancel(h.pointer(-75));
        if (action === "lost") grip.onLostPointerCapture(h.pointer(-75));
        if (action === "blur") h.listeners.get("blur")!();
        if (action === "unmount") h.unmount();
        const updates = h.set.mock.calls.length;
        h.frame();
        expect(h.set).toHaveBeenCalledTimes(updates);
        if (action === "up") {
            expect(h.saveSize).toHaveBeenCalledExactlyOnceWith({ ...layout.DEFAULT_WINDOW_SIZE, width: 475, height: 540 });
            expect(h.setSize).toHaveBeenLastCalledWith({ ...layout.DEFAULT_WINDOW_SIZE, width: 475, height: 540 });
        } else expect(h.saveSize).not.toHaveBeenCalled();
        expect(h.el.releasePointerCapture).toHaveBeenCalledOnce();
        if (action !== "unmount") h.unmount();
    });
});

it("A30 position-only renders reuse the catalog rows, while keyboard selection still updates", () => {
    const h = hooks(), store = new Store({ get: async () => undefined, set: async () => {} });
    store.templates = Array.from({ length: 1000 }, (_, i) => ({
        id: `faq:${i}`, title: `Template ${i}`, text: "Answer", project: "mj", source: "faq", category: "Support",
        status: "actual", statusNote: null, teamUses: 0, command: null, color: null, updatedAt: null,
    } as types.Template));
    const placement = { position: null as geometry.WindowPosition | null, set: vi.fn() };
    const body = {}, ui = { useSelect: (fn: any) => fn({ compose: [], dialog: null, menu: null, channelRevision: 0 }),
        get: () => ({ management: false, menu: null }), set: vi.fn() };
    const deps = {
        "@webpack/common": h.api, "../core/keys": keys, "../core/layout": layout, "../core/rank": rank, "../core/search": search,
        "../core/text": {}, "../core/types": types, "../core/windowPlacement": geometry,
        "../platform": { chatAreaRect: () => ({ right: 1200, top: 800 }), storage: { get: async () => null } },
        "./flow": {}, "./uiState": { store, ui, useStore: () => 0, activeScope: () => "mj", listedProject: () => "mj",
            poolFor: () => store.templates, watchChatArea: () => () => {} },
        "./debug": new Proxy({}, { get: (_t, key) => key === "debugState" ? { useSelect: () => false } : () => false }),
        "./ContextMenu": {}, "./op": { windowEditor: () => null }, "./highlight": {}, "./keylatch": {},
        "./Preview": { Preview: "Preview", plural: () => "" }, "./ProjectIcon": {}, "./Select": { Select: "Select" }, "./svg": {},
        "./WindowPlacement": { useWindowPlacement: () => placement, WindowPlacementControls: "WindowPlacementControls" },
    };
    const module = load(code.Window, deps, { React: h.api.React, setTimeout, clearTimeout,
        document: { body, activeElement: body, addEventListener() {}, removeEventListener() {} },
        window: { innerWidth: 1600, innerHeight: 1000, addEventListener() {}, removeEventListener() {} } });
    h.render(module.Window);
    const initial = h.rows(), start = performance.now();
    let tree: any;
    for (let i = 0; i < 240; i++) {
        placement.position = { right: 100 + i, bottom: 100, pinned: false };
        tree = h.render(module.Window);
    }
    const built = h.rows() - initial, elapsed = performance.now() - start;
    console.info("A30 picker benchmark", { templates: 1000, renders: 240, builtRows: built, elapsedMs: Number(elapsed.toFixed(2)) });
    expect(built).toBe(0);
    nodes(tree).find(n => n.props.className === "vc-stx-win").props.onKeyDown({
        key: "ArrowDown", nativeEvent: {}, target: { closest: () => null }, preventDefault() {}, stopPropagation() {},
    });
    tree = h.render(module.Window);
    expect(nodes(tree).find(n => n.props.t && n.props.sel).props.t.id).not.toBe("faq:0");
    expect(h.rows()).toBeGreaterThan(initial); h.unmount();
});
