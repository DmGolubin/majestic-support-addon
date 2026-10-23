import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { validPrefix } from "../src/core/trigger";
import * as types from "../src/core/types";

// Execute actual modules with a hook/commit harness; no Discord, browser or network.
const codes = Object.fromEntries(["Settings", "Management", "Dialogs"].map(name => [name,
    ts.transpileModule(readFileSync(new URL(`../src/vencord/ui/${name}.tsx`, import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
    }).outputText
]));
const textOf = (n: any): string => Array.isArray(n) ? n.map(textOf).join("") : n == null || typeof n === "boolean" ? ""
    : typeof n === "object" ? textOf(n.props?.children) : String(n);
const all = (n: any, p: (n: any) => boolean): any[] => Array.isArray(n) ? n.flatMap(v => all(v, p))
    : !n || typeof n !== "object" ? [] : [...(p(n) ? [n] : []), ...all(n.props?.children, p)];

function harness(root = "Management", kind = "fields") {
    let cursor = 0, active: any, tree: any, rerender = true, personal: any;
    const owners = new Map<string, any>(), effects: (() => void)[] = [], listeners = new Set<(e: any) => void>();
    const onDirty = vi.fn(), discard = vi.fn(), resolve = vi.fn();
    const dialog = { kind, templateId: "t1", title: "Title", initial: {}, fields: [{ name: "Name", options: [] }], resolve };
    const ui = { set: vi.fn(), get: () => ({ dialog }), useSelect: (select: any) => select({ dialog }) };
    const store = { data: { prefix: ";", previewOpen: true,
        showPersonalInAll: false, generalFirstInSearch: true, windowTabOrder: [...types.WINDOW_TABS] },
        setPrefix: vi.fn((v: string) => { store.data.prefix = v; }),
        setShowPersonalInAll: vi.fn((v: boolean) => { store.data.showPersonalInAll = v; }),
        setGeneralFirstInSearch: vi.fn((v: boolean) => { store.data.generalFirstInSearch = v; }),
        setWindowTabOrder: vi.fn((v: types.WindowTab[]) => { store.data.windowTabOrder = types.readWindowTabOrder(v); }),
        byId: () => ({ title: "Template" }), bindFor: () => undefined, bindModeFor: () => "insert",
        clearBind: vi.fn(), setBind: vi.fn() };
    const comboOf = vi.fn(() => "Ctrl+KeyK");
    const hooks = {
        useRef(v: any) { const i = cursor++; return active.slots[i] ??= { current: v }; },
        useState(v: any) {
            const owner = active, i = cursor++;
            if (!(i in owner.slots)) owner.slots[i] = typeof v === "function" ? v() : v;
            return [owner.slots[i], (next: any) => {
                const value = typeof next === "function" ? next(owner.slots[i]) : next;
                if (owner.live && !Object.is(value, owner.slots[i])) { owner.slots[i] = value; rerender = true; }
            }];
        },
        useEffect(fn: () => any, deps: any[]) {
            const owner = active, i = cursor++, prev = owner.slots[i];
            if (!prev || deps.some((v, j) => !Object.is(v, prev[j]))) {
                owner.slots[i] = deps;
                effects.push(() => { owner.cleanups.get(i)?.(); owner.cleanups.set(i, fn()); });
            }
        }
    };
    const document = { activeElement: null,
        addEventListener: (_: string, fn: (e: any) => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: (e: any) => void) => listeners.delete(fn) };
    const empty = () => null;
    const deps: Record<string, any> = {
        "./DiagnosticControls": { DiagnosticControls: empty },
        "@webpack/common": { ...hooks, GuildStore: { getGuild: () => null } },
        "./settings-layout.css": {}, "../core/trigger": { validPrefix }, "../core/types": types,
        "./uiState": { ui, store, useStore: empty }, "./panel": { panel: { use: () => ({ phase: "ready" }) } },
        "./PanelPersonalLibrary": { discardPanelDraft: discard, PanelPersonalLibrary: (props: any) => { personal = props; return null; } },
        "./PanelConnection": { PanelConnection: empty }, "./TicketSettings": { TicketSettings: empty },
        "./LocalStorageNotice": { LocalStorageNotice: empty },
        "./BuildIdentity": { BuildIdentity: empty },
        "./ProjectIcon": { ProjectIcon: empty }, "./svg": { IconBell: empty, IconSettings: empty, IconTemplates: empty },
        "../core/keys": { comboOf, comboLabel: (s: string) => s, bindProblem: () => null },
        "../platform": { toast: vi.fn() }, "./debug": { dlog: vi.fn() }, "./keylatch": { latchKey: vi.fn() }
    };
    const React = { Fragment: "fragment", createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };
    for (const name of ["Settings", "Management", "Dialogs"]) {
        const exports: any = {};
        runInNewContext(codes[name], { exports, React, document, require: (id: string) => {
            if (!(id in deps)) throw Error(`Unexpected import: ${id}`);
            return deps[id];
        } });
        deps[`./${name}`] = exports;
    }
    const dispose = (o: any) => { o.live = false; o.cleanups.forEach((fn: any) => fn?.()); };
    const render = () => {
        let passes = 0;
        do {
            if (++passes > 20) throw Error("Render loop");
            rerender = false;
            const seen = new Set<string>();
            const visit = (n: any, path: string): any => {
                if (Array.isArray(n)) return n.map((v, i) => visit(v, `${path}/${i}`));
                if (!n || typeof n !== "object") return n;
                if (typeof n.type === "function") {
                    path += `:${n.props.key ?? ""}`; seen.add(path);
                    let owner = owners.get(path);
                    if (!owner || owner.type !== n.type) {
                        if (owner) dispose(owner);
                        owner = { type: n.type, slots: [], cleanups: new Map(), live: true }; owners.set(path, owner);
                    }
                    active = owner; cursor = 0;
                    return visit(n.type(n.props), path + "/output");
                }
                if (n.props.ref) n.props.ref.current = { focus: vi.fn(), contains: (target: any) => !target?.chat };
                return { ...n, props: { ...n.props, children: visit(n.props.children, path + "/children") } };
            };
            tree = visit(React.createElement(deps[`./${root}`][root], { onDirty }), "root");
            for (const [path, owner] of owners) if (!seen.has(path)) { dispose(owner); owners.delete(path); }
            effects.splice(0).forEach(fn => fn());
        } while (rerender);
    };
    const button = (label: string) => {
        const found = all(tree, n => n.type === "button" && textOf(n) === label);
        expect(found, label).toHaveLength(1); return found[0];
    };
    const click = (label: string) => { button(label).props.onClick(); render(); };
    const prefix = () => all(tree, n => n.props.id === "stx-prefix-input")[0];
    const change = (value: string) => { prefix().props.onChange({ currentTarget: { value } }); render(); };
    const press = (extra: any = {}) => {
        const e = { key: "Escape", target: { closest: () => null }, isComposing: false, keyCode: 27,
            preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
        [...listeners].forEach(fn => fn(e)); render(); return e;
    };
    render();
    return { render, button, click, prefix, change, press, store, ui, onDirty, discard, resolve, comboOf,
        personal: () => personal, text: () => textOf(tree),
        submit: () => { all(tree, n => n.type === "form")[0].props.onSubmit({ preventDefault() {} }); render(); },
        backdrop: () => { tree.props.onMouseDown?.({ button: 0, target: tree, currentTarget: tree }); render(); },
        tree: () => tree,
        unmount: () => { owners.forEach(dispose); owners.clear(); }
    };
}

describe("prefix dirty confirmation", () => {
    it.each(["Escape", "button", "backdrop"])("guards close via %s and preserves prefix on return", via => {
        const h = harness(); h.click("Настройки"); h.change("!");
        if (via === "Escape") h.press(); else if (via === "button") h.click("Закрыть"); else h.backdrop();
        expect(h.ui.set).not.toHaveBeenCalled(); expect(h.text()).toContain("Есть несохранённые изменения");
        h.click("Вернуться"); expect(h.prefix().props.value).toBe("!");
        h.click("Закрыть"); h.click("Закрыть без сохранения");
        expect(h.ui.set).toHaveBeenLastCalledWith({ management: false }); expect(h.store.data.prefix).toBe(";");
    });

    it("preserves prefix on staying, discards it on switching, and clears validation errors", () => {
        const h = harness(); h.click("Настройки"); h.change("a"); h.submit();
        expect(h.text()).toContain("Введите один знак");
        h.click("Тикеты"); h.click("Остаться"); expect(h.prefix().props.value).toBe("a");
        h.click("Тикеты"); h.click("Перейти без сохранения"); h.click("Настройки");
        expect(h.prefix().props.value).toBe(";"); expect(h.text()).not.toContain("Введите один знак");
        expect(h.discard).toHaveBeenCalledOnce(); h.press(); expect(h.ui.set).toHaveBeenCalledWith({ management: false });
    });

    it.each(["save", "revert"])("clears pending tab and close confirmations on %s", action => {
        const h = harness(); h.click("Настройки"); h.change("!"); h.click("Тикеты"); h.click("Закрыть");
        if (action === "save") h.submit(); else h.change(";");
        expect(h.text()).not.toContain("Есть несохранённые изменения");
        expect(h.store.data.prefix).toBe(action === "save" ? "!" : ";");
        h.press(); expect(h.ui.set).toHaveBeenCalledWith({ management: false });
    });

    it("invalid save keeps the close guard", () => {
        const h = harness(); h.click("Настройки"); h.change("a"); h.submit(); h.press();
        expect(h.store.setPrefix).not.toHaveBeenCalled(); expect(h.ui.set).not.toHaveBeenCalled();
        expect(h.text()).toContain("Закрыть без сохранения");
    });

    it("combines personal dirty callbacks with prefix changes, including late clean callbacks", () => {
        const h = harness("Settings"), personal = h.personal(); h.click("Настройки"); h.change("!");
        personal.onDirty(false); h.render(); expect(h.onDirty).toHaveBeenLastCalledWith(true);
        personal.onDirty(true); h.render(); h.submit(); expect(h.onDirty).toHaveBeenLastCalledWith(true);
        personal.onDirty(false); h.render(); expect(h.onDirty).toHaveBeenLastCalledWith(false);
    });

    it.each(["resolve", "reject"])("blocks stale tab/close handlers until the editor reports save %s", outcome => {
        const h = harness(), p = h.personal(); p.onDirty(true); h.render();
        h.click("Настройки"); h.click("Закрыть");
        const switchTab = h.button("Перейти без сохранения"), close = h.button("Закрыть без сохранения");
        const tab = h.button("Тикеты"), closeButton = h.button("Закрыть");
        p.onBusy(true);
        switchTab.props.onClick(); close.props.onClick(); tab.props.onClick(); closeButton.props.onClick();
        h.press(); h.backdrop();
        expect(h.discard).not.toHaveBeenCalled(); expect(h.ui.set).not.toHaveBeenCalled();
        for (const label of ["Перейти без сохранения", "Закрыть без сохранения", "Закрыть", "Тикеты"])
            expect(h.button(label).props.disabled).toBe(true);
        p.onBusy(false);
        if (outcome === "resolve") p.onDirty(false);
        h.render(); expect(h.button("Закрыть").props.disabled).toBe(false);
        if (outcome === "reject") { h.click("Перейти без сохранения"); expect(h.discard).toHaveBeenCalledOnce(); }
        else expect(h.text()).not.toContain("Есть несохранённые изменения");
        h.press(); expect(h.ui.set).toHaveBeenCalledWith({ management: false }); h.unmount();
    });
});

describe("Management focus and backdrop", () => {
    it("exposes three settings tabs without local import or demo entry points", () => {
        const h = harness("Settings"); h.click("Настройки");
        for (const removed of ["Выбрать файл", "Импорт", "Локальная библиотека", "Редактировать на панели", "Демо-данные", "Доступные серверы"])
            expect(h.text()).not.toContain(removed);
        for (const tab of ["Мои шаблоны", "Настройки", "Тикеты"]) expect(h.button(tab)).toBeDefined();
        expect(all(h.tree(), n => n.type === "a" || n.type === "input" && n.props.type === "file")).toHaveLength(0);
        h.unmount();
    });

    it("explains the personal-All toggle and retains its existing preference", () => {
        const h = harness("Settings"); h.click("Настройки");
        const label = "Показывать мои шаблоны во вкладке «Все»";
        const input = () => all(h.tree(), n => n.type === "input" && n.props["aria-label"] === label)[0];
        expect(h.text()).toContain(label);
        expect(h.text()).toContain("Выключено — личные шаблоны остаются во вкладке «Мои».");
        expect(input().props.checked).toBe(false);
        input().props.onChange({ currentTarget: { checked: true } }); h.render();
        expect(h.store.setShowPersonalInAll).toHaveBeenCalledExactlyOnceWith(true);
        expect(input().props.checked).toBe(true);
        h.click("Тикеты"); h.click("Настройки");
        expect(input().props.checked).toBe(true);
        input().props.onChange({ currentTarget: { checked: false } }); h.render();
        expect(h.store.data.showPersonalInAll).toBe(false);
        h.unmount();
    });

    it("leaves outside keyboard events alone and guards backdrop dismissal of dirty drafts", () => {
        const h = harness(); h.click("Настройки"); h.change("!");
        expect(all(h.tree(), n => n.props.role === "dialog")[0].props["aria-modal"]).toBeUndefined();
        for (const name of ["Escape", "Tab"]) {
            const event = h.press({ key: name, target: { chat: true } });
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(event.stopPropagation).not.toHaveBeenCalled();
        }
        expect(h.press({ key: "Tab" }).preventDefault).not.toHaveBeenCalled();
        expect(h.ui.set).not.toHaveBeenCalled();
        expect(h.text()).not.toContain("Есть несохранённые изменения");
        h.backdrop();
        expect(h.ui.set).not.toHaveBeenCalled();
        expect(h.text()).toContain("Есть несохранённые изменения");
        h.click("Вернуться"); expect(h.prefix().props.value).toBe("!");
    });
});

describe("IME Escape guards in actual Management and Dialogs", () => {
    for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
        it.each(["Management", "fields", "confirm", "bind"])(`ignores %s composing Escape ${JSON.stringify(flags)} then accepts ordinary Escape`, kind => {
            const h = kind === "Management" ? harness() : harness("Dialogs", kind);
            const e = h.press(flags);
            expect(e.preventDefault).not.toHaveBeenCalled(); expect(e.stopPropagation).not.toHaveBeenCalled();
            expect(h.ui.set).not.toHaveBeenCalled(); expect(h.resolve).not.toHaveBeenCalled();
            expect(h.comboOf).not.toHaveBeenCalled(); h.press();
            if (kind === "Management") expect(h.ui.set).toHaveBeenCalledWith({ management: false });
            else if (kind === "bind") expect(h.ui.set).toHaveBeenCalledWith({ dialog: null });
            else expect(h.resolve).toHaveBeenCalledWith(kind === "fields" ? null : { ok: false, checked: false });
            h.unmount();
        });

        it(`does not open dirty close confirmation during composition ${JSON.stringify(flags)}`, () => {
            const h = harness(); h.click("Настройки"); h.change("!"); h.press(flags);
            expect(h.text()).not.toContain("Есть несохранённые изменения");
            h.press(); expect(h.text()).toContain("Есть несохранённые изменения"); expect(h.ui.set).not.toHaveBeenCalled();
        });

        it(`does not clear or assign binds during composition ${JSON.stringify(flags)}`, () => {
            const h = harness("Dialogs", "bind");
            h.press({ ...flags, key: "Backspace" }); h.press({ ...flags, key: "k", ctrlKey: true });
            expect(h.store.clearBind).not.toHaveBeenCalled(); expect(h.store.setBind).not.toHaveBeenCalled();
            expect(h.comboOf).not.toHaveBeenCalled(); expect(h.ui.set).not.toHaveBeenCalled();
        });
    }
});
