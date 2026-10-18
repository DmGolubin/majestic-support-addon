import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as keys from "../src/core/keys";
import * as layout from "../src/core/layout";
import * as rank from "../src/core/rank";
import * as search from "../src/core/search";
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
const windowCode = compile("Window.tsx"), selectCode = compile("Select.tsx");

function hooks() {
    const slots: any[] = [];
    let cursor = 0, dirty = false;
    let effects: (() => void)[] = [];
    const effect = (fn: () => void, deps?: unknown[]) => {
        const i = cursor++, old = slots[i];
        if (!deps || !old || deps.some((d, j) => !Object.is(d, old[j]))) effects.push(fn);
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

function windowHarness(width = 800, pinned = true) {
    const h = hooks(), listeners: Record<string, Function> = {};
    const state = { compose: [], dialog: null, menu: null, windowOpen: true, management: false };
    const pool = [template("alpha", "Account"), template("beta", "Account"), template("gamma", "Game"), template("general", null)];
    const ui = { get: () => state, useSelect: (fn: any) => fn(state), set: vi.fn(patch => Object.assign(state, patch)) };
    const store = {
        templates: pool, data: { previewOpen: pinned }, ctx: () => ({ favorites: ["alpha"], recent: ["gamma"], usage: {} }),
        bindFor: () => undefined, toggleFavorite: vi.fn(),
        setPreviewOpen: vi.fn(open => { store.data.previewOpen = open; }),
    };
    const insertTemplate = vi.fn(), addToCompose = vi.fn();
    const document: any = {
        activeElement: null, addEventListener: (name: string, fn: Function) => { listeners[name] = fn; }, removeEventListener: vi.fn(),
    };
    const input: any = { value: "", selectionStart: 0, selectionEnd: 0, closest: () => null, focus: vi.fn(() => { document.activeElement = input; }) };
    const categoryButton = { focus: vi.fn(), click: vi.fn() };
    const win = { contains: () => true, querySelector: (s: string) => s.includes("combobox") ? categoryButton : null, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const list = { querySelector: () => null, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const debug = Object.fromEntries([
        "costEnd", "costStart", "debugEnabled", "debugVerbose", "dlog", "keyDesc", "logGeometry", "noteKey",
        "noteRender", "noteSearch", "noteWheel", "setDebugHover", "setDebugWindow",
    ].map(n => [n, () => false]));
    const exports = load(windowCode, {
        "@webpack/common": h.api, "../core/keys": keys, "../core/layout": layout, "../core/rank": rank,
        "../core/search": search, "../core/types": { PROJECTS }, "../core/text": {},
        "../platform": { chatAreaRect: () => ({ right: width - 240, top: 650 }) },
        "./ContextMenu": {}, "./debug": { ...debug, debugState: { useSelect: () => false } },
        "./flow": { insertTemplate, addToCompose }, "./highlight": {}, "./keylatch": { latchKey: vi.fn() },
        "./op": { windowEditor: () => null }, "./Preview": { Preview: "Preview", plural: () => "шаблонов" },
        "./ProjectIcon": { ProjectIcon: "ProjectIcon" }, "./Select": { Select: "Select" },
        "./svg": { IconSettings: "IconSettings" }, "./menu-refinement.css": {},
        "./uiState": { store, ui, useStore: () => 0, activeScope: () => "mj", listedProject: () => "mj", poolFor: () => pool, watchChatArea: () => () => {} },
    }, { document, window: { innerWidth: width, innerHeight: 800, addEventListener: vi.fn(), removeEventListener: vi.fn() } });
    const render = () => h.render(exports.Window, tree => {
        for (const node of nodes(tree)) {
            if (node.props.ref) node.props.ref.current = node.type === "input" ? input : node.props.className?.includes("vc-stx-win") ? win : list;
        }
    });
    return { render, state, store, ui, pool, input, listeners, categoryButton, insertTemplate, addToCompose };
}
function selectHarness(props: any, bounds = { top: 100, bottom: 600 }, buttonRect = { top: 500, bottom: 530 }) {
    const h = hooks(), focus = vi.fn(), scroll = vi.fn();
    const exports = load(selectCode, { "@webpack/common": h.api, "./svg": { IconChevron: "IconChevron" } }, {
        crypto: { randomUUID: () => "test" }, innerHeight: 800,
    });
    let tree: VNode;
    const render = () => tree = h.render(() => exports.Select(props), tree => {
        for (const n of nodes(tree)) if (n.props.ref) n.props.ref.current = n.props.role === "combobox"
            ? { focus, getBoundingClientRect: () => buttonRect }
            : n.props.role === "listbox" ? { children: nodes(n).filter(o => o.props.role === "option").map(() => ({ scrollIntoView: scroll })) }
                : { closest: () => ({ getBoundingClientRect: () => bounds }), contains: (target: any) => target === dropdown };
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
        expect(nodes(select).filter(n => n.type === "option").map(text)).toEqual(["Все категории · 4", "Account · 2", "Game · 1"]);
        expect(byClass(tree, "vc-stx-chips")).toBeUndefined();
        select.props.onChange({ currentTarget: { value: "Account" } });
        tree = h.render();
        expect(text(byClass(tree, "vc-stx-filter-count"))).toBe("2");
        byClass(tree, "vc-stx-sinput").props.onChange({ currentTarget: { value: "beta" } });
        tree = h.render();
        expect(text(byClass(tree, "vc-stx-filter-count"))).toBe("1");
        byClass(tree, "vc-stx-category-reset").props.onClick();
        tree = h.render();
        expect(nodes(tree).find(n => n.type === "Select")!.props.value).toBe("");
        expect(byClass(tree, "vc-stx-sinput").props.value).toBe("beta");
        expect(h.input.focus).toHaveBeenCalled();
        byClass(tree, "vc-stx-sinput").props.onChange({ currentTarget: { value: "" } });
        expect(text(byClass(h.render(), "vc-stx-filter-count"))).toBe("4");
    });

    it("drops a category that disappears from the catalog", () => {
        const h = windowHarness();
        nodes(h.render()).find(n => n.type === "Select")!.props.onChange({ currentTarget: { value: "Game" } });
        h.render();
        h.pool.splice(2, 1);
        const tree = h.render();
        expect(nodes(tree).find(n => n.type === "Select")!.props.value).toBe("");
        expect(text(byClass(tree, "vc-stx-filter-count"))).toBe("3");
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
        expect(text(byClass(h.render(), "vc-stx-filter-count"))).toBe("1");
        const settings = byClass(byClass(tree, "vc-stx-search-row"), "vc-stx-menu-settings");
        expect(settings.props["aria-label"]).toBe("Мои шаблоны и настройки");
        expect(text(settings)).toBe("");
        expect(byClass(tree, "vc-stx-manage-link")).toBeUndefined();
        parent.props.onKeyDown(key("Enter", control));
        expect(h.insertTemplate).not.toHaveBeenCalled();
        settings.props.onClick();
        expect(h.state).toMatchObject({ management: true, windowOpen: false });
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

describe("Select keyboard visibility", () => {
    const options = Array.from({ length: 30 }, (_, i) => ({ type: "option", props: { value: String(i), children: `Category ${i}` } }));
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
