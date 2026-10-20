import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as keys from "../src/core/keys";
import { Store } from "../src/core/state";
import { splitGreeting } from "../src/core/text";
import { Template } from "../src/core/types";

const source = (name: string) => readFileSync(new URL(`../src/vencord/${name}`, import.meta.url), "utf8");
const compile = (code: string) => ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const codes = { menu: compile(source("ui/ContextMenu.tsx")), dialog: compile(source("ui/Dialogs.tsx")) };
const all = (node: any): any[] => Array.isArray(node) ? node.flatMap(all)
    : node && typeof node === "object" ? [node, ...all(node.props?.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join("")
    : node == null || typeof node === "boolean" ? "" : typeof node === "object" ? text(node.props?.children) : String(node);
const template = (id: string, source: Template["source"] = "faq"): Template => ({
    id, source, project: "mj", title: id, text: "Ответ", category: null, status: "actual",
    statusNote: null, teamUses: 0, command: null, color: null, updatedAt: null,
});
const keyEvent = (code: string, extra: any = {}) => ({
    code, key: code.startsWith("Key") ? code.slice(3) : code, ctrlKey: false, altKey: false,
    shiftKey: false, metaKey: false, repeat: false, isComposing: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra,
});

function harness(kind: "menu" | "dialog", personal = false) {
    const store = new Store({ get: async () => undefined, set: async () => {} });
    const target = template("target", personal ? "personal" : "faq"), other = template("other");
    store.templates = [target, other, template("third")];
    let state: any = { menu: kind === "menu" ? { id: target.id, x: 50, y: 60 } : null,
        dialog: kind === "dialog" ? { kind: "bind", templateId: target.id } : null };
    const ui = { get: () => state, set: (patch: any) => { state = { ...state, ...patch }; },
        useSelect: (select: any) => select(state) };
    const listeners = new Map<string, Set<(event: any) => void>>();
    const on = (name: string, callback: any) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(callback);
    };
    const off = (name: string, callback: any) => listeners.get(name)?.delete(callback);
    let cursor = 0, dirty = false;
    const slots: any[] = [], effects: (() => void)[] = [];
    const same = (a?: any[], b?: any[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    const useEffect = (setup: () => any, deps: any[]) => {
        const i = cursor++, previous = slots[i];
        if (same(previous?.deps, deps)) return;
        slots[i] = { deps };
        effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = setup(); });
    };
    const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };
    const hooks = {
        useState(initial: any) {
            const i = cursor++;
            if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
            return [slots[i], (value: any) => {
                const next = typeof value === "function" ? value(slots[i]) : value;
                if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; }
            }];
        },
        useRef(initial: any) { const i = cursor++; return slots[i] ??= { current: initial }; },
        useEffect, useLayoutEffect: useEffect,
    };
    let buttons: any[] = [];
    const document: any = { body: {}, activeElement: null, addEventListener: on, removeEventListener: off };
    const opener = { isConnected: true, focus: vi.fn(() => { document.activeElement = opener; }) };
    document.activeElement = opener;
    const element: any = { isConnected: true, style: { visibility: "visible" },
        getBoundingClientRect: () => ({ width: 250, height: 220 }),
        focus: vi.fn(() => { document.activeElement = element; }),
        contains: (value: any) => value === element || buttons.includes(value),
        querySelectorAll: () => buttons, closest: () => null };
    const toast = vi.fn(), insertTemplate = vi.fn(), latchKey = vi.fn();
    const deps: Record<string, any> = {
        "@webpack/common": hooks, "../core/keys": keys, "../core/text": { splitGreeting },
        "../platform": { toast }, "./debug": { dlog() {} }, "./keylatch": { latchKey },
        "./uiState": { store, ui }, "./flow": { insertTemplate, addToCompose: vi.fn(), supersede() {} },
        "./svg": { IconStar: "IconStar" },
    };
    const exports: any = {};
    runInNewContext(codes[kind], { exports, React, document, setTimeout, clearTimeout,
        window: { innerWidth: 1000, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
        require: (id: string) => { if (!(id in deps)) throw new Error("Unexpected dependency " + id); return deps[id]; } });
    let tree: any;
    const render = () => {
        let turns = 0;
        do {
            dirty = false; cursor = 0;
            const node = kind === "menu" ? exports.ContextMenu() : exports.Dialogs();
            tree = kind === "dialog" && node ? node.type(node.props) : node;
            buttons = all(tree).filter(n => n.type === "button").map(n => {
                const b: any = { node: n, isConnected: true, closest: (s: string) => s === "button" ? b : null,
                    focus: () => { document.activeElement = b; } };
                return b;
            });
            for (const n of all(tree)) if (n.props.ref) n.props.ref.current = element;
            effects.splice(0).forEach(fn => fn());
            if (++turns > 10) throw new Error("Unstable render");
        } while (dirty);
        return tree;
    };
    const press = (event: any) => {
        event.target ??= document.activeElement;
        [...listeners.get("keydown") ?? []].forEach(fn => fn(event));
        return event;
    };
    const button = (label: string) => all(tree).find(n => n.type === "button" && text(n) === label);
    render();
    return { store, target, other, ui, toast, insertTemplate, render, press, button, element, document, opener,
        tree: () => tree, buttons: () => buttons,
        cleanup: () => slots.forEach(s => s?.cleanup?.()) };
}

describe("A24 per-template shortcut UI", () => {
    it.each([false, true])("exposes a keyboard-addressable bind action for a nonfavorite template (personal=%s)", personal => {
        const h = harness("menu", personal);
        expect(h.store.data.favorites).toEqual([]);
        const action = h.button("Назначить сочетание клавиш…");
        expect(action.props.role).toBe("menuitem");
        expect(h.tree().props.role).toBe("menu");
        expect(h.element.focus).toHaveBeenCalled();
        const index = all(h.tree()).filter(n => n.type === "button").indexOf(action);
        for (let i = 0; i < index; i++) { h.press(keyEvent("ArrowDown")); h.render(); }
        expect(h.tree().props["aria-activedescendant"]).toBe(action.props.id);
        h.press(keyEvent("Enter"));
        expect(h.ui.get()).toMatchObject({ menu: null, dialog: { kind: "bind", templateId: "target" } });
        expect(h.insertTemplate).not.toHaveBeenCalled();
        h.cleanup();
    });

    it.each([false, true])("assigns a supported custom chord without adding the template to favorites (personal=%s)", personal => {
        const h = harness("dialog", personal);
        h.press(keyEvent("KeyQ", { ctrlKey: true, altKey: true }));
        expect(h.store.bindFor(h.target.id)).toBe("Ctrl+Alt+KeyQ");
        expect(h.store.data.favorites).toEqual([]);
        expect(h.ui.get().dialog).toBeNull();
        h.cleanup();
    });

    it("requires explicit reassignment and cancel preserves both existing bindings", () => {
        const h = harness("dialog");
        h.store.setBind(h.target.id, "F7"); h.store.setBind(h.other.id, "F8");
        h.press(keyEvent("F8")); h.render();
        expect(h.store.bindFor(h.target.id)).toBe("F7"); expect(h.store.bindFor(h.other.id)).toBe("F8");
        expect(text(h.tree())).toContain("уже назначено шаблону «other»");
        h.button("Отмена").props.onClick();
        expect(h.store.bindFor(h.target.id)).toBe("F7"); expect(h.store.bindFor(h.other.id)).toBe("F8");
        h.cleanup();
    });

    it("confirms reassignment and rechecks an owner changed while the prompt was open", () => {
        const h = harness("dialog");
        h.store.setBind(h.other.id, "F8"); h.press(keyEvent("F8")); h.render();
        h.store.setBind("third", "F8");
        h.button("Переназначить").props.onClick(); h.render();
        expect(h.store.bindFor(h.target.id)).toBeUndefined();
        expect(h.store.bindFor("third")).toBe("F8");
        expect(text(h.tree())).toContain("уже назначено шаблону «third»");
        h.button("Переназначить").props.onClick();
        expect(h.store.bindFor(h.target.id)).toBe("F8"); expect(h.store.bindFor("third")).toBeUndefined();
        h.cleanup();
    });

    it("allows changing the candidate instead of confirming a collision", () => {
        const h = harness("dialog");
        h.store.setBind(h.other.id, "F8"); h.press(keyEvent("F8")); h.render();
        h.press(keyEvent("F9"));
        expect(h.store.bindFor(h.target.id)).toBe("F9"); expect(h.store.bindFor(h.other.id)).toBe("F8");
        h.cleanup();
    });

    it.each(["KeyQ", "Shift+KeyQ", "Ctrl+KeyC", "Alt+Digit1"])("rejects unsupported/reserved %s without mutating bindings", combo => {
        const h = harness("dialog");
        const parts = combo.split("+"), code = parts.pop()!;
        h.press(keyEvent(code, { ctrlKey: parts.includes("Ctrl"), shiftKey: parts.includes("Shift"), altKey: parts.includes("Alt") }));
        expect(h.store.data.binds).toEqual({});
        expect(h.toast).toHaveBeenCalledWith(expect.any(String), "failure");
        expect(h.ui.get().dialog).not.toBeNull();
        h.cleanup();
    });

    it.each([{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { getModifierState: () => true }])("ignores composition, repeats and AltGraph: %j", flags => {
        const h = harness("dialog");
        h.press(keyEvent("F8", flags));
        expect(h.store.data.binds).toEqual({});
        expect(h.ui.get().dialog).not.toBeNull();
        h.cleanup();
    });

    it("keeps Tab focus inside the dialog and leaves focused-button activation native", () => {
        const h = harness("dialog");
        expect(h.tree().props.role).toBeUndefined(); // Fragment contains the named modal.
        expect(all(h.tree()).find(n => n.props.role === "dialog").props["aria-modal"]).toBe("true");
        h.press(keyEvent("Tab"));
        expect(h.buttons()).toContain(h.document.activeElement);
        const event = h.press(keyEvent("Enter"));
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(h.store.data.binds).toEqual({});
        h.cleanup();
    });

    it("ignores stale confirmation after replacement/removal and never dismisses a newer dialog", () => {
        const h = harness("dialog");
        h.store.setBind(h.other.id, "F8"); h.press(keyEvent("F8")); h.render();
        const confirm = h.button("Переназначить").props.onClick;
        h.store.templates = [h.other, template("target", "personal")];
        confirm();
        expect(h.store.bindFor(h.other.id)).toBe("F8"); expect(h.store.bindFor(h.target.id)).toBeUndefined();
        const replacement = { kind: "bind", templateId: h.other.id };
        h.ui.set({ dialog: replacement }); confirm();
        expect(h.ui.get().dialog).toBe(replacement);
        h.cleanup();
    });

    it("removes only the selected template's binding", () => {
        const h = harness("dialog"); h.store.setBind(h.target.id, "F7"); h.store.setBind(h.other.id, "F8");
        h.button("Снять клавишу").props.onClick();
        expect(h.store.bindFor(h.target.id)).toBeUndefined(); expect(h.store.bindFor(h.other.id)).toBe("F8");
        h.cleanup();
    });
});

describe("A24 row actions and existing global bind handler", () => {
    it.each(["faq", "personal"] as const)("keeps right-click menu access without a row action button or insertion (%s)", sourceKind => {
        const file = source("ui/Window.tsx");
        const code = compile(file.slice(file.indexOf("function RowImpl("), file.indexOf("// React from @webpack/common")) + "\nexports.RowImpl = RowImpl;");
        const openMenu = vi.fn(), insertTemplate = vi.fn(), hide = vi.fn(), exports: any = {};
        const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };
        runInNewContext(code, { exports, React, openMenu, insertTemplate, nqHighlight: (s: string) => s, snippetOf: () => "Ответ" });
        const t = template("target", sourceKind);
        const tree = exports.RowImpl({ t, tokens: [], onHide: hide, alt: 0 });
        expect(all(tree).filter(n => n.type === "button")).toHaveLength(0);
        const event = { preventDefault: vi.fn(), clientX: 80, clientY: 90 };
        tree.props.onContextMenu(event);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(hide).toHaveBeenCalledOnce();
        expect(openMenu).toHaveBeenCalledExactlyOnceWith(t.id, 80, 90);
        expect(insertTemplate).not.toHaveBeenCalled();
    });

    it.each(["faq", "personal"] as const)("executes a nonfavorite custom bind through the existing handler (%s)", sourceKind => {
        const file = source("index.tsx"), code = compile(file.slice(file.indexOf("const inForeignInput"), file.indexOf("let host:")));
        const t = template("target", sourceKind), insertTemplate = vi.fn();
        const context = {
            ui: { get: () => ({ windowOpen: false, dialog: null, menu: null, management: false }) },
            store: { templateForCombo: (combo: string) => combo === "Ctrl+Alt+KeyQ" ? t : undefined },
            comboOf: keys.comboOf, activeScope: () => "mj", pluginOn: () => true,
            swallowLatched: () => false, handleInlineKey: () => false, insertTemplate, latchKey() {},
            debugEnabled: () => false, noteKey() {}, dlog() {}, keyDesc: () => "", costStart: () => 0, costEnd() {},
        };
        const onKey = runInNewContext(code + "\nonKey;", context);
        const event = keyEvent("KeyQ", { ctrlKey: true, altKey: true, target: { closest: () => null } });
        onKey(event);
        expect(insertTemplate).toHaveBeenCalledExactlyOnceWith(t, { via: "bind Ctrl+Alt+KeyQ" });
    });
});
