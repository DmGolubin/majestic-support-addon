import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as keys from "../src/core/keys";
import * as layout from "../src/core/layout";
import * as rank from "../src/core/rank";
import * as search from "../src/core/search";
import * as windowPlacement from "../src/core/windowPlacement";
import * as types from "../src/core/types";
import { PROJECTS, Template } from "../src/core/types";

// Run the actual components/handlers using the repo's VM harness pattern; no Discord or DOM install.
type VNode = { type: any; props: Record<string, any>; };
const nodes = (n: any): VNode[] => Array.isArray(n) ? n.flatMap(nodes)
    : n && typeof n === "object" && n.props ? [n, ...nodes(n.props.children)] : [];
const text = (n: any): string => Array.isArray(n) ? n.map(text).join("")
    : n && typeof n === "object" ? text(n.props.children) : n == null || typeof n === "boolean" ? "" : String(n);
const byClass = (tree: any, name: string) => nodes(tree).find(n => n.props.className?.split(" ").includes(name))!;
const compile = (file: string) => ts.transpileModule(readFileSync(new URL(`../src/vencord/ui/${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const windowCode = compile("Window.tsx"), selectCode = compile("Select.tsx"), placementCode = compile("WindowPlacement.tsx");

function hooks() {
    const slots: any[] = [];
    let cursor = 0, dirty = false;
    let effects: (() => void)[] = [];
    const cleanups = new Map<number, any>();
    const effect = (fn: () => void, deps?: unknown[]) => {
        const i = cursor++, old = slots[i];
        if (!deps || !old || deps.some((d, j) => !Object.is(d, old[j]))) effects.push(() => { cleanups.get(i)?.(); cleanups.set(i, fn()); });
        slots[i] = deps;
    };
    const React = {
        createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
        memo: (fn: any) => fn,
        Children: { toArray: (children: any[]) => children.flat(Infinity) },
        isValidElement: (n: any) => !!n?.props,
    };
    return {
        api: {
            React,
            useState(initial: any) {
                const i = cursor++;
                if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
                return [slots[i], (value: any) => {
                    const next = typeof value === "function" ? value(slots[i]) : value;
                    if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; }
                }];
            },
            useRef: (initial: any) => slots[cursor++] ??= { current: initial },
            useMemo: (fn: any) => fn(), useCallback: (fn: any) => fn,
            useEffect: effect, useLayoutEffect: effect,
        },
        render(fn: () => VNode, attach: (tree: VNode) => void = () => {}) {
            let tree: VNode;
            let attempts = 0;
            do {
                if (++attempts > 10) throw new Error("Render did not settle");
                cursor = 0; dirty = false; effects = [];
                tree = fn(); attach(tree); effects.forEach(fn => fn());
            } while (dirty);
            return tree!;
        },
        unmount() { cleanups.forEach(fn => fn?.()); cleanups.clear(); },
    };
}
function load(code: string, dependencies: Record<string, any>, globals: Record<string, any> = {}) {
    const exports: any = {};
    runInNewContext(code, { exports, ...globals, require: (id: string) => {
        if (!(id in dependencies)) throw new Error(`Unexpected import: ${id}`);
        return dependencies[id];
    } });
    return exports;
}
const key = (key: string, target: any = { closest: () => null }, patch: Record<string, any> = {}) => ({
    key, code: key, target, nativeEvent: { code: key }, repeat: false, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...patch,
});
const control = { closest: (s: string) => s.includes("data-stx-menu-control") ? {} : null };
const dropdown = { closest: (s: string) => s.includes("vc-stx-select") ? {} : null };
const template = (id: string, category: string | null): Template => ({
    id, category, title: id, text: `Answer ${id}`, project: "mj", status: "actual", statusNote: null,
    teamUses: 0, command: null, color: null, updatedAt: null, source: "faq",
});

function windowHarness(width = 800, pinned = true, storage = { get: vi.fn(async () => undefined as unknown), set: vi.fn(async (_key: string, _value: unknown) => {}) }) {
    const h = hooks(), frame = hooks(), listeners: Record<string, Function> = {}, windowListeners: Record<string, Function> = {};
    const state = { compose: [], dialog: null, menu: null, windowOpen: true, management: false };
    const pool = [template("alpha", "Account"), template("beta", "Account"), template("gamma", "Game"), template("general", null)];
    const ui = { get: () => state, useSelect: (fn: any) => fn(state), set: vi.fn(patch => Object.assign(state, patch)) };
    const store = {
        templates: pool, data: { previewOpen: pinned, showPersonalInAll: true, generalFirstInSearch: false, windowTabOrder: [...types.WINDOW_TABS] }, ctx: () => ({ favorites: ["alpha"], recent: ["gamma"], usage: {} }),
        bindFor: () => undefined, toggleFavorite: vi.fn(),
        setPreviewOpen: vi.fn(open => { store.data.previewOpen = open; }),
    };
    const insertTemplate = vi.fn(), addToCompose = vi.fn();
    const document: any = {
        activeElement: null, addEventListener: (name: string, fn: Function) => { listeners[name] = fn; },
        removeEventListener: vi.fn((name: string) => { delete listeners[name]; }),
    };
    const input: any = { value: "", selectionStart: 0, selectionEnd: 0, closest: () => null, focus: vi.fn(() => { document.activeElement = input; }) };
    const categoryButton = { focus: vi.fn(), click: vi.fn() };
    const win = { contains: (target: any) => [input, control, dropdown].includes(target), querySelector: (s: string) => s.includes("combobox") ? categoryButton : null, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const list = { querySelector: () => null, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const debug = Object.fromEntries([
        "costEnd", "costStart", "debugEnabled", "debugVerbose", "dlog", "keyDesc", "logGeometry", "noteKey",
        "noteRender", "noteSearch", "noteWheel", "setDebugHover", "setDebugWindow",
    ].map(n => [n, () => false]));
    const windowHandlers = new Map<string, Set<Function>>();
    const viewport = { innerWidth: width, innerHeight: 800,
        addEventListener: (name: string, fn: Function) => {
            if (!windowHandlers.has(name)) windowHandlers.set(name, new Set());
            windowHandlers.get(name)!.add(fn);
            windowListeners[name] = (...args: any[]) => windowHandlers.get(name)?.forEach(handler => handler(...args));
        },
        removeEventListener: vi.fn((name: string, fn: Function) => {
            windowHandlers.get(name)?.delete(fn);
            if (!windowHandlers.get(name)?.size) { windowHandlers.delete(name); delete windowListeners[name]; }
        }) };
    let geometryChange = () => {};
    const placementDeps = { "../core/layout": layout, "../core/windowPlacement": windowPlacement, "../platform": { storage }, "./window-placement.css": {} };
    const placementHooks = load(placementCode, { ...placementDeps, "@webpack/common": h.api }, { window: viewport });
    const placementControls = load(placementCode, { ...placementDeps, "@webpack/common": frame.api }, { window: viewport });
    const exports = load(windowCode, {
        "@webpack/common": h.api, "../core/keys": keys, "../core/layout": layout, "../core/rank": rank,
        "../core/search": search, "../core/types": types, "../core/text": {}, "../core/windowPlacement": windowPlacement,
        "./WindowPlacement": { useWindowPlacement: placementHooks.useWindowPlacement, WindowPlacementControls: placementControls.WindowPlacementControls },
        "./window-placement.css": {}, "./window-tabs.css": {},
        "../platform": { storage, chatAreaRect: () => ({ right: viewport.innerWidth - 240, top: viewport.innerHeight - 150 }) },
        "./ContextMenu": {}, "./debug": { ...debug, debugState: { useSelect: () => false } },
        "./flow": { insertTemplate, addToCompose }, "./highlight": {}, "./keylatch": { latchKey: vi.fn() },
        "./op": { windowEditor: () => null }, "./Preview": { Preview: "Preview", plural: () => "шаблонов" },
        "./ProjectIcon": { ProjectIcon: "ProjectIcon" }, "./Select": { Select: "Select" },
        "./svg": { IconSettings: "IconSettings" }, "./menu-refinement.css": {},
        "./uiState": { store, ui, useStore: () => 0, activeScope: () => "mj", listedProject: () => "mj", poolFor: () => pool, watchChatArea: (fn: () => void) => { geometryChange = fn; return () => {}; } },
    }, { document, window: viewport });
    const render = () => h.render(exports.Window, tree => {
        const controls = nodes(tree).find(n => n.type === placementControls.WindowPlacementControls);
        if (controls) {
            const rendered = frame.render(() => placementControls.WindowPlacementControls(controls.props));
            controls.type = rendered.type; controls.props = rendered.props;
        }
        for (const node of nodes(tree)) {
            if (node.props.ref) node.props.ref.current = node.type === "input" ? input : node.props.className?.includes("vc-stx-win") ? win : list;
        }
    });
    let captured: number | null = null;
    const grip = { focus: vi.fn(), setPointerCapture: vi.fn((id: number) => { captured = id; }),
        hasPointerCapture: (id: number) => captured === id, releasePointerCapture: vi.fn(() => { captured = null; }) };
    const pointer = (clientX: number, clientY: number, pointerId = 1) => ({ currentTarget: grip, pointerId, button: 0, clientX, clientY, preventDefault() {}, stopPropagation() {} });
    return { render, state, store, ui, pool, input, listeners, categoryButton, insertTemplate, addToCompose,
        document, viewport, windowListeners, storage, grip, pointer, unmount: () => { frame.unmount(); h.unmount(); },
        resizeViewport(w: number, height: number) { viewport.innerWidth = w; viewport.innerHeight = height; geometryChange(); return render(); } };
}
function selectHarness(props: any, bounds = { top: 100, bottom: 600 }, buttonRect = { top: 500, bottom: 530 },
    ancestors: { top: number; bottom: number; overflowY: string; clientTop?: number; clientHeight?: number; }[] = [], viewportHeight = 800) {
    const h = hooks(), focus = vi.fn(), scroll = vi.fn();
    const container = { getBoundingClientRect: () => bounds, overflowY: "visible", parentElement: null };
    const parentElement = ancestors.reduceRight<any>((parent, ancestor) => ({
        ...ancestor, getBoundingClientRect: () => ancestor, parentElement: parent,
        clientTop: ancestor.clientTop ?? 0, clientHeight: ancestor.clientHeight ?? ancestor.bottom - ancestor.top,
    }), container);
    const exports = load(selectCode, { "@webpack/common": h.api, "./svg": { IconChevron: "IconChevron" } }, {
        crypto: { randomUUID: () => "test" }, innerHeight: viewportHeight,
        getComputedStyle: (element: any) => ({ overflowY: element.overflowY }),
    });
    let tree: VNode;
    const render = () => tree = h.render(() => exports.Select(props), tree => {
        for (const n of nodes(tree)) if (n.props.ref) n.props.ref.current = n.props.role === "combobox"
            ? { focus, getBoundingClientRect: () => buttonRect }
            : n.props.role === "listbox" ? { children: nodes(n).filter(o => o.props.role === "option").map(() => ({ scrollIntoView: scroll })) }
                : { closest: () => container, parentElement, contains: (target: any) => target === dropdown };
    });
    const button = () => nodes(tree).find(n => n.props.role === "combobox")!;
    const press = (name: string, patch = {}) => { const e = key(name, dropdown, patch); button().props.onKeyDown(e); render(); return e; };
    render();
    return { render, press, button, scroll, focus, tree: () => tree };
}

describe("template menu refinement", () => {
    it("counts scoped categories, filters results and resets to all including uncategorized templates", () => {
        const h = windowHarness();
        let tree = h.render();
        const select = nodes(tree).find(n => n.type === "Select")!;
        expect(nodes(select).filter(n => n.type === "option").map(text)).toEqual(["Все категории", "Account", "Game"]);
        expect(byClass(tree, "vc-stx-chips")).toBeUndefined();
        select.props.onChange({ currentTarget: { value: "Account" } });
        tree = h.render();
        expect(text(byClass(tree, "vc-stx-n"))).toBe("2 из 4");
        byClass(tree, "vc-stx-sinput").props.onChange({ currentTarget: { value: "beta" } });
        tree = h.render();
        expect(text(byClass(tree, "vc-stx-n"))).toBe("1 из 4");
        byClass(tree, "vc-stx-category-reset").props.onClick();
        tree = h.render();
        expect(nodes(tree).find(n => n.type === "Select")!.props.value).toBe("");
        expect(byClass(tree, "vc-stx-sinput").props.value).toBe("beta");
        expect(h.input.focus).toHaveBeenCalled();
        byClass(tree, "vc-stx-sinput").props.onChange({ currentTarget: { value: "" } });
        expect(text(byClass(h.render(), "vc-stx-n"))).toBe("4 шаблонов"); // plural is stubbed in this harness
    });

    it("drops a category that disappears from the catalog", () => {
        const h = windowHarness();
        nodes(h.render()).find(n => n.type === "Select")!.props.onChange({ currentTarget: { value: "Game" } });
        h.render();
        h.pool.splice(2, 1);
        const tree = h.render();
        expect(nodes(tree).find(n => n.type === "Select")!.props.value).toBe("");
        expect(text(byClass(tree, "vc-stx-n"))).toBe("3 шаблонов");
    });

    it("opens/selects/cancels categories without inserting or closing Window, including held keys", () => {
        const h = windowHarness(), tree = h.render(), parent = byClass(tree, "vc-stx-win");
        const s = selectHarness(nodes(tree).find(n => n.type === "Select")!.props);
        const press = (name: string, patch = {}) => {
            const e = s.press(name, patch);
            if (!e.stopped) parent.props.onKeyDown(e);
            return e;
        };
        expect(press("Enter").defaultPrevented).toBe(true);
        expect(s.button().props["aria-expanded"]).toBe(true);
        press("ArrowDown"); press("Enter"); press("Enter", { repeat: true });
        expect(nodes(h.render()).find(n => n.type === "Select")!.props.value).toBe("Account");
        expect(s.button().props["aria-expanded"]).toBe(false);
        press(" "); press("Escape"); press("Escape", { repeat: true });
        expect(h.state.windowOpen).toBe(true);
        expect(h.insertTemplate).not.toHaveBeenCalled();
        expect(h.addToCompose).not.toHaveBeenCalled();
        expect(s.focus).toHaveBeenCalled();
    });

    it("offers native Tab access, Alt+Down categories, and an icon-only settings action beside search", () => {
        const h = windowHarness(), tree = h.render(), parent = byClass(tree, "vc-stx-win");
        const tab = key("Tab", h.input);
        parent.props.onKeyDown(tab);
        expect(tab.defaultPrevented).toBe(false);
        parent.props.onKeyDown(key("ArrowDown", h.input, { altKey: true }));
        expect(h.categoryButton.focus).toHaveBeenCalledOnce();
        expect(h.categoryButton.click).toHaveBeenCalledOnce();
        parent.props.onKeyDown(key("Tab", h.input, { ctrlKey: true }));
        // The new personal tab is between All and Favorites.
        byClass(h.render(), "vc-stx-win").props.onKeyDown(key("Tab", h.input, { ctrlKey: true }));
        expect(text(byClass(h.render(), "vc-stx-n"))).toBe("1 из 4");
        const settings = byClass(byClass(tree, "vc-stx-search-row"), "vc-stx-menu-settings");
        expect(settings.props["aria-label"]).toBe("Мои шаблоны и настройки");
        expect(text(settings)).toBe("");
        expect(byClass(tree, "vc-stx-manage-link")).toBeUndefined();
        parent.props.onKeyDown(key("Enter", control));
        expect(h.insertTemplate).not.toHaveBeenCalled();
        settings.props.onClick();
        expect(h.state).toMatchObject({ management: true, windowOpen: false });
    });

    it.each(["button", "a"])("leaves focused preview %s activation to its own handler", tag => {
        const h = windowHarness(), parent = byClass(h.render(), "vc-stx-win");
        const target = { closest: (selector: string) => selector.split(",").map(s => s.trim()).includes(tag) ? {} : null };
        for (const name of ["Enter", " ", "ArrowDown", "ArrowLeft"]) {
            const event = key(name, target);
            parent.props.onKeyDown(event);
            expect(event.defaultPrevented).toBe(false);
        }
        expect(h.insertTemplate).not.toHaveBeenCalled();
        expect(h.addToCompose).not.toHaveBeenCalled();
    });

    it("retains search Enter/Shift+Enter and Escape while ignoring composition", () => {
        const h = windowHarness(), parent = byClass(h.render(), "vc-stx-win");
        parent.props.onKeyDown(key("Enter", h.input, { nativeEvent: { isComposing: true } }));
        expect(h.insertTemplate).not.toHaveBeenCalled();
        parent.props.onKeyDown(key("Enter", h.input));
        parent.props.onKeyDown(key("Enter", h.input, { shiftKey: true }));
        expect(h.insertTemplate).toHaveBeenCalledOnce();
        expect(h.addToCompose).toHaveBeenCalledOnce();
        parent.props.onKeyDown(key("Escape", h.input));
        expect(h.state.windowOpen).toBe(false);
    });

    it("starts at 800px in the list, preserves Shift peek and local preview/back without changing the wide preference", () => {
        const h = windowHarness(800, true);
        let tree = h.render();
        const box = byClass(tree, "vc-stx-win");
        expect(box.props.className).toContain("compact");
        expect(box.props.style.width).toBe(400);
        expect(box.props.style.right + box.props.style.width).toBeLessThanOrEqual(800 - layout.EDGE);
        expect(nodes(tree).some(n => n.type === "Preview")).toBe(false);
        h.listeners.keydown(key("Shift", dropdown));
        expect(nodes(h.render()).some(n => n.type === "Preview")).toBe(false);
        h.listeners.keydown(key("Shift", h.input));
        expect(nodes(h.render()).some(n => n.type === "Preview")).toBe(true);
        h.listeners.keyup(key("Shift", h.input));
        expect(nodes(h.render()).some(n => n.type === "Preview")).toBe(false);
        box.props.onKeyDown(key("ArrowRight", h.input));
        tree = h.render();
        expect(byClass(tree, "vc-stx-win").props.style).toEqual(box.props.style);
        nodes(tree).find(n => n.type === "Preview")!.props.onBack();
        expect(nodes(h.render()).some(n => n.type === "Preview")).toBe(false);
        expect(h.store.setPreviewOpen).not.toHaveBeenCalled();
        expect(h.store.data.previewOpen).toBe(true);
        expect(nodes(windowHarness(1400, true).render()).some(n => n.type === "Preview")).toBe(true);
    });
});

const flushStorage = () => new Promise<void>(resolve => setImmediate(resolve));
describe("persistent nonmodal picker", () => {
    it("keeps chat selection/focus and native chat keys while explicit close still works", () => {
        const h = windowHarness(); h.render();
        const chat = { closest: () => null };
        h.document.activeElement = chat;
        h.listeners.mousedown?.({ target: chat });
        h.listeners.keydown(key("Shift", chat));
        expect(h.state.windowOpen).toBe(true);
        expect(h.document.activeElement).toBe(chat);
        expect(nodes(h.render()).some(n => n.type === "Preview")).toBe(false);
        byClass(h.render(), "vc-stx-window-close").props.onClick();
        expect(h.state).toMatchObject({ windowOpen: false, menu: null });
        h.unmount();
    });
    it("resizes larger and smaller, persists only completed gestures, and restores on reopen", async () => {
        const h = windowHarness(1600, false);
        let tree = h.render(); await flushStorage();
        byClass(tree, "edge-nw").props.onPointerDown(h.pointer(600, 200));
        byClass(tree, "edge-nw").props.onPointerMove(h.pointer(460, 100));
        tree = h.render();
        expect(byClass(tree, "vc-stx-win").props.style).toMatchObject({ width: 500, height: 600 });
        expect(h.storage.set).not.toHaveBeenCalled();
        byClass(tree, "edge-nw").props.onPointerUp(h.pointer(460, 100));
        await flushStorage();
        const saved = h.storage.set.mock.calls.find(([key]) => key === "SupportTemplates_windowSize_v1")![1];
        expect(saved).toEqual({ width: 500, height: 600, previewWidth: 460 });
        expect(h.grip.releasePointerCapture).toHaveBeenCalledWith(1);
        h.unmount();
        const reopened = windowHarness(1600, false, { get: vi.fn(async () => saved), set: vi.fn(async () => {}) });
        reopened.render(); await flushStorage(); tree = reopened.render();
        expect(byClass(tree, "vc-stx-win").props.style).toMatchObject({ width: 500, height: 600 });
        byClass(tree, "edge-nw").props.onPointerDown(reopened.pointer(400, 100));
        byClass(tree, "edge-nw").props.onPointerMove(reopened.pointer(500, 200));
        tree = reopened.render();
        expect(byClass(tree, "vc-stx-win").props.style).toMatchObject({ width: 400, height: 500 });
        byClass(tree, "edge-nw").props.onPointerUp(reopened.pointer(500, 200));
        await flushStorage();
        expect(reopened.storage.set).toHaveBeenCalledWith("SupportTemplates_windowSize_v1", { width: 400, height: 500, previewWidth: 460 });
        reopened.unmount();
    });
    it.each(["escape", "cancel", "lostcapture", "blur", "unmount"])("cancels a drag on %s and cleans up capture/listeners without a write", async reason => {
        const h = windowHarness(1600, false), tree = h.render(), before = byClass(tree, "vc-stx-win").props.style;
        const grip = byClass(tree, "edge-nw");
        grip.props.onPointerDown(h.pointer(600, 200)); grip.props.onPointerMove(h.pointer(500, 100)); h.render();
        if (reason === "escape") byClass(h.render(), "edge-nw").props.onKeyDown(key("Escape", control));
        if (reason === "cancel") grip.props.onPointerCancel(h.pointer(500, 100));
        if (reason === "lostcapture") grip.props.onLostPointerCapture(h.pointer(500, 100));
        if (reason === "blur") h.windowListeners.blur();
        if (reason === "unmount") h.unmount();
        else { expect(byClass(h.render(), "vc-stx-win").props.style).toEqual(before); expect(h.state.windowOpen).toBe(true); h.unmount(); }
        await flushStorage();
        expect(h.storage.set).not.toHaveBeenCalled();
        expect(h.grip.releasePointerCapture).toHaveBeenCalledOnce();
        expect(Object.keys(h.listeners)).toEqual([]); expect(Object.keys(h.windowListeners)).toEqual([]);
    });
    it("does not persist keyboard movements inside a cancelled pointer gesture", async () => {
        const h = windowHarness(1600, false), tree = h.render();
        const before = byClass(tree, "vc-stx-win").props.style;
        const grip = byClass(tree, "edge-nw");
        grip.props.onPointerDown(h.pointer(600, 200));
        grip.props.onPointerMove(h.pointer(500, 100));
        byClass(h.render(), "edge-nw").props.onKeyDown(key("ArrowLeft", control));
        byClass(h.render(), "edge-nw").props.onKeyDown(key("Escape", control));
        expect(byClass(h.render(), "vc-stx-win").props.style).toEqual(before);
        await flushStorage();
        expect(h.storage.set).not.toHaveBeenCalled();
        h.unmount();
    });
    it("does not treat a click/foreign pointer as a resize or overwrite preferences when the viewport shrinks", async () => {
        const saved = { width: 500, height: 600, previewWidth: 600 };
        const h = windowHarness(1600, false, { get: vi.fn(async () => saved), set: vi.fn(async () => {}) });
        h.render(); await flushStorage();
        const grip = byClass(h.render(), "edge-nw");
        grip.props.onPointerDown(h.pointer(500, 100)); grip.props.onPointerMove(h.pointer(100, 0, 2));
        grip.props.onPointerUp(h.pointer(500, 100));
        let style = byClass(h.resizeViewport(280, 220), "vc-stx-win").props.style;
        expect(style.width + style.right).toBeLessThanOrEqual(272);
        expect(style.height + style.bottom).toBeLessThanOrEqual(212);
        style = byClass(h.resizeViewport(1600, 800), "vc-stx-win").props.style;
        expect(style).toMatchObject({ width: 500, height: 600 });
        expect(h.storage.set).not.toHaveBeenCalled(); h.unmount();
    });
    it("resizes a Shift preview without changing its pin or list width, with native keyboard resizing", async () => {
        const h = windowHarness(1800, false);
        h.render(); h.listeners.keydown(key("Shift", h.input));
        let tree = h.render();
        const event = key("ArrowLeft", control);
        byClass(tree, "edge-nw").props.onKeyDown(event); tree = h.render();
        expect(event.defaultPrevented).toBe(true);
        expect(byClass(tree, "vc-stx-win").props.style.width).toBe(840);
        expect(byClass(tree, "vc-stx-col").props.style.width).toBe(358);
        h.listeners.keyup(key("Shift", h.input)); tree = h.render();
        expect(byClass(tree, "vc-stx-win").props.style.width).toBe(360);
        expect(h.store.setPreviewOpen).not.toHaveBeenCalled();
        await flushStorage();
        expect(h.storage.set).toHaveBeenCalledWith("SupportTemplates_windowSize_v1", { width: 360, height: 500, previewWidth: 480 });
        h.unmount();
    });
    it("ignores a late load after user resizing and tolerates storage failure", async () => {
        let resolve!: (value: unknown) => void;
        const storage = { get: vi.fn(() => new Promise<unknown>(r => { resolve = r; })), set: vi.fn(async () => { throw Error("disk unavailable"); }) };
        const h = windowHarness(1600, false, storage);
        h.render(); await flushStorage();
        byClass(h.render(), "edge-nw").props.onKeyDown(key("ArrowLeft", control));
        resolve({ width: 650, height: 900, previewWidth: 700 }); await flushStorage();
        expect(byClass(h.render(), "vc-stx-win").props.style.width).toBe(380);
        expect(h.state.windowOpen).toBe(true); h.unmount();
    });
});

describe("Select keyboard visibility", () => {
    const options = Array.from({ length: 30 }, (_, i) => ({ type: "option", props: { value: String(i), children: `Category ${i}` } }));
    it("fits the folder popup inside the nested editor scrollport on open and End/Home", () => {
        const h = selectHarness({ value: "0", onChange: vi.fn(), children: options.slice(0, 12), "aria-label": "Folder" },
            { top: 100, bottom: 500 }, { top: 320, bottom: 350 },
            [{ top: 217.3, bottom: 435, overflowY: "auto", clientTop: 2, clientHeight: 210.7 }], 550);
        h.button().props.onClick(); h.render();
        for (const name of [null, "End", "Home"]) {
            if (name) h.press(name);
            const height = nodes(h.tree()).find(n => n.props.role === "listbox")!.props.style.maxHeight;
            expect(h.tree().props.className).toContain("vc-stx-select-up");
            expect(height).toBeCloseTo(92.7);
            expect(320 - 4 - height).toBeGreaterThanOrEqual(219.3);
        }
        expect(h.button().props["aria-activedescendant"]).toBe("stx-select-test-0");
    });
    it.each(["auto", "scroll", "hidden", "clip"])("intersects outer %s clipping with the nearest scrollport", overflowY => {
        const h = selectHarness({ value: "0", onChange: vi.fn(), children: options, "aria-label": "Folder" },
            { top: 100, bottom: 700 }, { top: 240, bottom: 270 }, [
                { top: 120, bottom: 600, overflowY: "auto" },
                { top: 200, bottom: 420, overflowY, clientTop: 2, clientHeight: 210 },
            ]);
        h.press("Enter");
        expect(h.tree().props.className).not.toContain("vc-stx-select-up");
        expect(nodes(h.tree()).find(n => n.props.role === "listbox")!.props.style.maxHeight).toBe(134);
    });
    it("ignores the visible editor body in short windows and uses the settings scroller", () => {
        const h = selectHarness({ value: "0", onChange: vi.fn(), children: options, "aria-label": "Folder" },
            { top: 100, bottom: 500 }, { top: 320, bottom: 350 }, [
                { top: 300, bottom: 360, overflowY: "visible" },
                { top: 100, bottom: 500, overflowY: "auto", clientTop: 2, clientHeight: 396 },
            ], 540);
        h.press("Enter");
        expect(h.tree().props.className).toContain("vc-stx-select-up");
        expect(nodes(h.tree()).find(n => n.props.role === "listbox")!.props.style.maxHeight).toBe(200);
    });
    it("retains main-menu bounds and the viewport limit without a nested scroller", () => {
        const h = selectHarness({ value: "0", onChange: vi.fn(), children: options, "aria-label": "Category" },
            { top: 100, bottom: 700 }, { top: 150, bottom: 180 }, [], 320);
        h.press("Enter");
        expect(h.tree().props.className).not.toContain("vc-stx-select-up");
        expect(nodes(h.tree()).find(n => n.props.role === "listbox")!.props.style.maxHeight).toBe(132);
    });
    it("keeps Home/End and wrapped arrow navigation visible and bounds the popup to its container", () => {
        const onChange = vi.fn();
        const h = selectHarness({ value: "0", onChange, children: options, "aria-label": "Category" }, { top: 400, bottom: 600 });
        h.press("Enter"); h.press("End");
        expect(h.button().props["aria-activedescendant"]).toBe("stx-select-test-29");
        expect(h.tree().props.className).toContain("vc-stx-select-up");
        expect(nodes(h.tree()).find(n => n.props.role === "listbox")!.props.style.maxHeight).toBe(92);
        expect(h.scroll).toHaveBeenCalledWith({ block: "nearest" });
        h.press("ArrowDown");
        expect(h.button().props["aria-activedescendant"]).toBe("stx-select-test-0");
        h.press("ArrowUp"); h.press("Home"); h.press(" ");
        expect(onChange).toHaveBeenCalledWith({ currentTarget: { value: "0" } });
        expect(h.button().props["aria-expanded"]).toBe(false);
        h.press("Enter");
        expect(h.press("Tab").defaultPrevented).toBe(false);
        expect(h.button().props["aria-expanded"]).toBe(false);
    });
    it("ignores IME Enter and closes on blur outside the control", () => {
        const h = selectHarness({ value: "0", onChange: vi.fn(), children: options, "aria-label": "Category" });
        h.press("Enter", { nativeEvent: { isComposing: true } });
        expect(h.button().props["aria-expanded"]).toBe(false);
        h.press("Enter");
        h.tree().props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
        h.render();
        expect(h.button().props["aria-expanded"]).toBe(false);
    });
});
