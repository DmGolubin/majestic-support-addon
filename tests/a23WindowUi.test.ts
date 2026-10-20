import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as keys from "../src/core/keys";
import * as layout from "../src/core/layout";
import * as rank from "../src/core/rank";
import * as search from "../src/core/search";
import { Store } from "../src/core/state";
import * as textCore from "../src/core/text";
import * as types from "../src/core/types";
import * as windowPlacement from "../src/core/windowPlacement";

type Node = { type: any; props: Record<string, any>; };
const nodes = (node: any): Node[] => Array.isArray(node) ? node.flatMap(nodes)
    : !node || typeof node !== "object" ? [] : [node, ...nodes(node.props?.children)];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join("")
    : node == null || typeof node === "boolean" ? "" : typeof node === "object" ? text(node.props?.children) : String(node);
const codes = Object.fromEntries(["Window", "Settings"].map(name => [name,
    ts.transpileModule(readFileSync(new URL(`../src/vencord/ui/${name}.tsx`, import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
    }).outputText]));
const template = (id: string, extra: Partial<types.Template> = {}): types.Template => ({
    id, project: "mj", title: "Ошибка входа", text: "Здравствуйте!\n[[greeting:end]]\nОтвет",
    category: "Вход", status: "actual", statusNote: null, teamUses: 0, command: null,
    color: null, updatedAt: null, source: "faq", ...extra,
});

// Evaluate the actual TSX and handlers with persistent hooks. Host IO is unavailable;
// search/ranking/store logic are real. Effects run after render, as in React.
function harness(component: "Window" | "Settings" = "Window") {
    const store = new Store({ get: async () => undefined, set: async () => {} });
    store.templates = [template("faq:1"), template("personal:2", { source: "personal" }),
        template("faq:3", { project: "ro", category: "Другое", title: "Ошибка запуска" })];
    store.data.favorites = ["personal:2", "faq:1"];
    store.data.recent = ["personal:2", "faq:1"];
    let version = 0, scope: "mj" | "ro" = "mj", phase = "ready", channelRevision = 0;
    store.subscribe(() => version++);
    let cursor = 0, dirty = false;
    const slots: any[] = [], pending: (() => void)[] = [];
    const same = (a?: unknown[], b?: unknown[]) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
    const effect = (setup: () => any, deps?: unknown[]) => {
        const i = cursor++, previous = slots[i];
        if (same(previous?.deps, deps)) return;
        slots[i] = { deps };
        pending.push(() => { previous?.cleanup?.(); slots[i].cleanup = setup(); });
    };
    const React = {
        createElement: (type: unknown, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
        memo: (fn: any) => fn,
    };
    const hooks = {
        React,
        useState(initial: any) {
            const i = cursor++;
            if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
            return [slots[i], (value: any) => {
                const next = typeof value === "function" ? value(slots[i]) : value;
                if (!Object.is(slots[i], next)) { slots[i] = next; dirty = true; }
            }];
        },
        useRef(initial: any) { const i = cursor++; return slots[i] ??= { current: initial }; },
        useEffect: effect, useLayoutEffect: effect,
        useMemo(fn: () => any, deps: unknown[]) {
            const i = cursor++;
            if (!same(slots[i]?.deps, deps)) slots[i] = { deps, value: fn() };
            return slots[i].value;
        },
        useCallback: (fn: any, _deps: any) => fn,
    };
    const insertTemplate = vi.fn(), placement = { position: null as windowPlacement.WindowPosition | null, set: vi.fn() };
    const ui = { useSelect: (select: any) => select({ compose: [], dialog: null, menu: null, channelRevision }),
        get: () => ({ management: false, dialog: null, menu: null }), set: vi.fn() };
    const deps: Record<string, any> = {
        "@webpack/common": hooks, "../core/keys": keys, "../core/layout": layout,
        "../core/rank": rank, "../core/search": search, "../core/text": textCore,
        "../core/types": types, "../core/windowPlacement": windowPlacement,
        "../core/trigger": { validPrefix: () => true },
        "../platform": { chatAreaRect: () => ({ top: 600, right: 1100 }), storage: { get: async () => null, set: async () => {} } },
        "./flow": { insertTemplate, addToCompose: vi.fn() },
        "./uiState": { store, ui, useStore: () => version, activeScope: () => scope, listedProject: () => scope,
            poolFor: () => store.templates.filter(t => t.project === scope || t.project === null),
            watchChatArea: () => () => {}, pickTechProject: vi.fn() },
        "./debug": new Proxy({}, { get: (_obj, key) => key === "debugState" ? { useSelect: () => false }
            : key === "costStart" ? () => 0 : () => false }),
        "./ContextMenu": { openMenu: vi.fn() }, "./op": { windowEditor: () => null },
        "./highlight": { nqHighlight: (s: string) => s }, "./keylatch": { latchKey: vi.fn() },
        "./Preview": { Preview: "Preview", plural: () => "шаблонов" }, "./ProjectIcon": { ProjectIcon: "ProjectIcon" },
        "./Select": { Select: "Select" }, "./svg": new Proxy({}, { get: (_obj, key) => String(key) }),
        "./WindowPlacement": { useWindowPlacement: () => placement, WindowPlacementControls: "WindowPlacementControls" },
        "./panel": { panel: { use: () => ({ phase }) } },
        "./PanelPersonalLibrary": { PanelPersonalLibrary: "PanelPersonalLibrary", discardPanelDraft() {} },
    };
    for (const name of ["DiagnosticControls", "PanelConnection", "TicketSettings", "LocalStorageNotice", "BuildIdentity"])
        deps["./" + name] = { [name]: name };
    const body = {};
    const exports: any = {};
    runInNewContext(codes[component], {
        exports, React, setTimeout, clearTimeout,
        document: { body, activeElement: body, addEventListener() {}, removeEventListener() {} },
        window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
        require: (id: string) => {
            if (id.endsWith(".css")) return {};
            if (!(id in deps)) throw new Error("Unexpected dependency " + id);
            return deps[id];
        },
    });
    const render = (): Node => {
        let tree!: Node, turns = 0;
        do {
            dirty = false; cursor = 0; tree = exports[component]();
            pending.splice(0).forEach(fn => fn());
            if (++turns > 10) throw new Error("Unstable render");
        } while (dirty);
        return tree;
    };
    return { render, store, insertTemplate, placement, exports,
        switchChannel: (next: "mj" | "ro") => { scope = next; channelRevision++; },
        setPhase: (next: string) => { phase = next; } };
}

const tab = (tree: Node, label: string) => nodes(tree).find(n => n.type === "button" && n.props.draggable && text(n).startsWith(label))!;
const rows = (tree: Node) => nodes(tree).filter(n => n.props.t && typeof n.type === "function");
const button = (tree: Node, label: string) => nodes(tree).find(n => n.type === "button" && text(n) === label)!;
const key = (name: string, extra: any = {}) => ({
    key: name, nativeEvent: {}, target: { closest: () => null }, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra,
});

describe("A23 actual Window and Settings controls", () => {
    it("shows personal in Мои and favorites/recent while excluding it from Все by default", () => {
        const h = harness();
        let tree = h.render();
        expect(rows(tree).map(n => n.props.t.id)).toEqual(["faq:1"]);
        tab(tree, "Мои").props.onClick(); tree = h.render();
        expect(rows(tree).map(n => n.props.t.id)).toEqual(["personal:2"]);
        expect(h.exports.visibleItems.map((t: types.Template) => t.id)).toEqual(["personal:2"]);
        for (const label of ["Избранное", "Недавние"]) {
            tab(tree, label).props.onClick(); tree = h.render();
            expect(rows(tree).map(n => n.props.t.id)).toEqual(["personal:2", "faq:1"]);
        }
        tab(tree, "Все").props.onClick(); h.store.setShowPersonalInAll(true); tree = h.render();
        expect(rows(tree).map(n => n.props.t.id)).toEqual(["personal:2", "faq:1"]);
    });

    it("searches inside the selected tab and restores global relevance when grouping is disabled", () => {
        const h = harness(); h.store.setShowPersonalInAll(true);
        h.store.data.favorites = ["personal:2"];
        let tree = h.render();
        nodes(tree).find(n => n.type === "input")!.props.onChange({ currentTarget: { value: "ошибка" } });
        tree = h.render();
        expect(rows(tree).map(n => n.props.t.id)).toEqual(["faq:1", "personal:2"]);
        h.store.setGeneralFirstInSearch(false); tree = h.render();
        expect(rows(tree).map(n => n.props.t.id)).toEqual(["personal:2", "faq:1"]);
        tab(tree, "Мои").props.onClick(); tree = h.render();
        expect(rows(tree).map(n => n.props.t.id)).toEqual(["personal:2"]);
    });

    it("reorders by drag, ignores external drops, and cycles tabs in saved order", () => {
        const h = harness(); let tree = h.render();
        const event = { dataTransfer: { setData: vi.fn(), effectAllowed: "", dropEffect: "" }, preventDefault: vi.fn() };
        tab(tree, "Недавние").props.onDragStart(event);
        tab(tree, "Все").props.onDragOver(event);
        tab(tree, "Все").props.onDrop(event);
        tree = h.render();
        expect(h.store.data.windowTabOrder).toEqual(["recent", "all", "personal", "fav"]);
        expect(nodes(tree).filter(n => n.props.draggable).map(n => text(n).replace(/\d+$/, ""))).toEqual(["Недавние", "Все", "Мои", "Избранное"]);
        tab(tree, "Избранное").props.onDrop(event);
        expect(h.store.data.windowTabOrder).toEqual(["recent", "all", "personal", "fav"]);
        const root = nodes(tree).find(n => n.props.className === "vc-stx-win")!;
        root.props.onKeyDown(key("Tab", { ctrlKey: true, shiftKey: true }));
        tree = h.render();
        expect(tab(tree, "Недавние").props["aria-pressed"]).toBe(true);
    });

    it("Ctrl+left click passes noGreeting through the existing insert API and ignores non-left click", () => {
        const h = harness(), tree = h.render(), component = rows(tree)[0];
        const row = component.type(component.props);
        row.props.onClick({ button: 0, ctrlKey: true });
        expect(h.insertTemplate).toHaveBeenLastCalledWith(component.props.t, { via: "window-click", noGreeting: true });
        row.props.onClick({ button: 0, ctrlKey: false });
        expect(h.insertTemplate).toHaveBeenLastCalledWith(component.props.t, { via: "window-click", noGreeting: false });
        row.props.onClick({ button: 1, ctrlKey: true });
        expect(h.insertTemplate).toHaveBeenCalledTimes(2);
    });

    it("refreshes mounted rows and published shortcuts when channel scope changes and drops invalid category", () => {
        const h = harness(); let tree = h.render();
        nodes(tree).find(n => n.type === "Select")!.props.onChange({ currentTarget: { value: "Вход" } });
        h.render(); h.switchChannel("ro"); tree = h.render();
        expect(rows(tree).map(n => n.props.t.id)).toEqual(["faq:3"]);
        expect(nodes(tree).find(n => n.type === "Select")!.props.value).toBe("");
        expect(h.exports.visibleItems).toEqual([]); // no favorite from previous project remains published
    });

    it("keeps the existing recent-category behavior by applying the ten-item limit after category filtering", () => {
        const h = harness();
        h.store.templates = Array.from({ length: 12 }, (_, i) => template(`faq:${i}`, { category: i < 10 ? "Вход" : "Другое" }));
        h.store.data.recent = h.store.templates.map(t => t.id);
        let tree = h.render();
        tab(tree, "Недавние").props.onClick(); tree = h.render();
        expect(rows(tree)).toHaveLength(10);
        nodes(tree).find(n => n.type === "Select")!.props.onChange({ currentTarget: { value: "Другое" } });
        tree = h.render();
        expect(rows(tree).map(n => n.props.t.id)).toEqual(["faq:10", "faq:11"]);
    });

    it("integrates only one placement control and clamps beneath the titlebar", () => {
        const h = harness(); h.placement.position = { right: 80, bottom: 20000, pinned: true };
        const tree = h.render(), all = nodes(tree);
        expect(all.filter(n => n.type === "WindowPlacementControls")).toHaveLength(1);
        expect(all.some(n => n.props.className === "vc-stx-resize")).toBe(false);
        const root = all.find(n => n.props.className === "vc-stx-win")!;
        expect(800 - root.props.style.bottom - root.props.style.height).toBeGreaterThanOrEqual(32);
    });

    it("Settings supplies keyboard-accessible movement and persists both search options", () => {
        const h = harness("Settings"); let tree = h.render();
        button(tree, "Настройки").props.onClick(); tree = h.render();
        const earlier = nodes(tree).find(n => n.props["aria-label"] === "Мои, позиция 2 из 4")!;
        expect(earlier.type).toBe("button"); expect(earlier.props.disabled).toBe(false);
        earlier.props.onKeyDown(key("ArrowLeft", { altKey: true })); tree = h.render();
        expect(h.store.data.windowTabOrder).toEqual(["personal", "all", "fav", "recent"]);
        const first = nodes(tree).find(n => n.props["aria-label"] === "Мои, позиция 1 из 4")!;
        first.props.onKeyDown(key("ArrowLeft", { altKey: true }));
        expect(h.store.data.windowTabOrder).toEqual(["personal", "all", "fav", "recent"]);
        const inputs = nodes(tree).filter(n => n.type === "input");
        inputs.find(n => n.props["aria-label"] === "Показывать личные шаблоны во Все")!.props.onChange({ currentTarget: { checked: true } });
        inputs.find(n => n.props["aria-label"] === "Общие шаблоны первыми в поиске")!.props.onChange({ currentTarget: { checked: false } });
        expect(h.store.data).toMatchObject({ showPersonalInAll: true, generalFirstInSearch: false });
        h.setPhase("offline"); tree = h.render();
        expect(nodes(tree).filter(n => n.type === "input").every(n => n.props.disabled)).toBe(true);
        expect(nodes(tree).filter(n => n.props["aria-keyshortcuts"]).every(n => n.props.disabled)).toBe(true);
    });
});
