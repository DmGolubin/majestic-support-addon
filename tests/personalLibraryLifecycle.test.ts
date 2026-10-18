import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERSONAL_COLORS, PersonalDraft } from "../src/core/personal";
import { Store } from "../src/core/state";
import { routeStore } from "../src/core/storeRouter";
import { PREFIXES, validPrefix } from "../src/core/trigger";

// Transpile and execute the real components, with a small explicit hook/commit harness.
// No React installation, DOM, Discord, network, or copied lifecycle implementation.
const codes = Object.fromEntries(["PersonalLibrary", "Settings", "Management"].map(name => [name,
    ts.transpileModule(readFileSync(new URL(`../src/vencord/ui/${name}.tsx`, import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
    }).outputText,
]));
const deferred = () => {
    let resolve!: () => void, reject!: (e: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const draft = (title = "Original"): PersonalDraft => ({ title, text: "Answer", project: "mj", command: null, color: null, folderId: null });
const makeStore = () => {
    const write = vi.fn(async (_key: string, _data: unknown) => {});
    return { store: new Store({ get: async () => undefined, set: write }), write };
};
const textOf = (node: any): string => Array.isArray(node) ? node.map(textOf).join("")
    : node == null || typeof node === "boolean" ? "" : typeof node === "object" ? textOf(node.props?.children) : String(node);
const all = (node: any, predicate: (node: any) => boolean): any[] => Array.isArray(node) ? node.flatMap(n => all(n, predicate))
    : !node || typeof node !== "object" ? [] : [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)];

function harness(initial: Store, rootName = "PersonalLibrary") {
    const route = routeStore(initial);
    const onDirty = vi.fn(), onBusy = vi.fn(), toast = vi.fn();
    const ui = { set: vi.fn() };
    const demoState = { enabled: false, revision: 1 };
    const panelState = { enabled: false, phase: "idle" };
    const listeners = new Map<string, (e: any) => void>();
    let picker: any;
    const document = {
        activeElement: null,
        addEventListener: (name: string, fn: (e: any) => void) => listeners.set(name, fn),
        removeEventListener: (name: string) => listeners.delete(name),
        createElement: () => (picker = { click: vi.fn() }),
    };
    type Instance = { type: any; slots: any[]; cleanups: Map<number, { run: () => void; layout: boolean; }>; live: boolean; };
    const instances = new Map<string, Instance>();
    let active!: Instance, cursor = 0, needsRender = true, tree: any, mounted = true;
    const effects: (() => void)[] = [];
    const passiveCleanups: (() => void)[] = [];
    const effectHook = (effect: () => void | (() => void), deps: unknown[], layout: boolean) => {
        const owner = active, i = cursor++, prev = owner.slots[i];
        if (!prev || deps.some((v, j) => !Object.is(v, prev[j]))) {
            owner.slots[i] = deps;
            effects.push(() => {
                owner.cleanups.get(i)?.run();
                const cleanup = effect();
                if (cleanup) owner.cleanups.set(i, { run: cleanup, layout });
            });
        }
    };
    const hooks = {
        useRef(value: any) { const i = cursor++; return active.slots[i] ??= { current: value }; },
        useState(value: any) {
            const owner = active, i = cursor++;
            if (!(i in owner.slots)) owner.slots[i] = typeof value === "function" ? value() : value;
            return [owner.slots[i], (next: any) => {
                if (!owner.live) return;
                const v = typeof next === "function" ? next(owner.slots[i]) : next;
                if (!Object.is(v, owner.slots[i])) { owner.slots[i] = v; needsRender = true; }
            }];
        },
        useEffect(effect: () => void | (() => void), deps: unknown[]) {
            effectHook(effect, deps, false);
        },
        useLayoutEffect(effect: () => void | (() => void), deps: unknown[]) {
            effectHook(effect, deps, true);
        },
    };
    const empty = () => null;
    const dependencies: Record<string, any> = {
        "@webpack/common": { ...hooks, GuildStore: { getGuild: () => null } },
        "./settings-layout.css": {}, "./ProjectIcon": { ProjectIcon: empty },
        "../core/personal": { PERSONAL_COLORS }, "../core/tokenEditor": {},
        "../core/trigger": { PREFIXES, validPrefix }, "../platform": { toast },
        "./demo": { demo: { use: () => demoState, useSelect: (f: any) => f(demoState) } },
        "./panel": { panel: { use: () => panelState }, useDemoLibrary: vi.fn(), useLocalLibrary: vi.fn() },
        "./Select": { Select: "select" }, "./TokenToolbar": { TokenToolbar: empty },
        "./DemoConnection": { DemoConnection: empty }, "./PanelConnection": { PanelConnection: empty },
        "./TicketSettings": { TicketSettings: empty },
        "./LocalStorageNotice": { LocalStorageNotice: empty },
        "./svg": Object.fromEntries(["IconFolder", "IconPlus", "IconBell", "IconLink", "IconSettings", "IconTemplates"].map(n => [n, empty])),
        "./flow": { confirmedForeign: new Set(), supersede: vi.fn() }, "./op": { nextGeneration: vi.fn() },
        "./uiState": {
            store: route.store, getStoreSelection: route.getSelection, ui,
            useStore: () => {
                const [, update] = hooks.useState(0);
                hooks.useEffect(() => route.store.subscribe(() => update((n: number) => n + 1)), []);
            },
        },
    };
    const React = { Fragment: "fragment", createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };
    // Exercise the parent's dirty/busy contract with the existing async editor fixture.
    // PanelPersonalLibrary has separate API and lifecycle tests; this is a shell test.
    dependencies["./PanelPersonalLibrary"] = { discardPanelDraft: vi.fn(), PanelPersonalLibrary: (props: any) => panelState.enabled ? null
        : React.createElement(dependencies["./PersonalLibrary"].PersonalLibrary, props) };
    for (const name of ["PersonalLibrary", "Settings", "Management"]) {
        const exports: any = {};
        runInNewContext(codes[name], { exports, React, document, crypto: { randomUUID }, console,
            require: (id: string) => { if (!(id in dependencies)) throw Error(`Unmocked ${id}`); return dependencies[id]; },
        });
        dependencies[`./${name}`] = exports;
    }
    const dispose = (owner: Instance, deferPassive = false) => {
        owner.live = false;
        owner.cleanups.forEach(({ run, layout }) => { if (deferPassive && !layout) passiveCleanups.push(run); else run(); });
    };
    const render = () => {
        if (!mounted) return tree;
        let passes = 0;
        do {
            if (++passes > 20) throw Error("Render loop");
            needsRender = false;
            const seen = new Set<string>();
            const visit = (node: any, path: string): any => {
                if (Array.isArray(node)) return node.map((n, i) => visit(n, `${path}/${i}`));
                if (!node || typeof node !== "object") return node;
                if (typeof node.type === "function") {
                    path += `:${node.props.key ?? ""}`;
                    seen.add(path);
                    let owner = instances.get(path);
                    if (!owner || owner.type !== node.type) {
                        if (owner) dispose(owner);
                        owner = { type: node.type, slots: [], cleanups: new Map(), live: true };
                        instances.set(path, owner);
                    }
                    active = owner; cursor = 0;
                    return visit(node.type(node.props), path + "/output");
                }
                if (node.props.ref) node.props.ref.current = { focus: vi.fn(), contains: () => true };
                return { ...node, props: { ...node.props, children: visit(node.props.children, path + "/children") } };
            };
            tree = visit(React.createElement(dependencies[`./${rootName}`][rootName], { onDirty, onBusy }), "root");
            // Commit deleted owners before new effects, as React does for keyed replacements.
            for (const [path, owner] of instances) if (!seen.has(path)) { dispose(owner); instances.delete(path); }
            effects.splice(0).forEach(effect => effect());
        } while (needsRender);
        return tree;
    };
    const nodes = (type: string) => all(tree, n => n.type === type);
    const button = (label: string) => {
        const matches = nodes("button").filter(n => textOf(n) === label);
        expect(matches, `button ${label}`).toHaveLength(1);
        return matches[0];
    };
    const click = (label: string) => { button(label).props.onClick(); render(); };
    const input = (maxLength: number) => nodes("input").find(n => n.props.maxLength === maxLength);
    const change = (node: any, value: string) => { node.props.onChange({ currentTarget: { value } }); render(); };
    const submit = () => { const form = nodes("form")[0]; form.props.onSubmit({ preventDefault() {} }); return form; };
    const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); render(); };
    render();
    return { route, onDirty, onBusy, ui, toast, panelState, demoState, listeners, render, nodes, button, click, input, change, submit, settle,
        picker: () => picker, tree: () => tree,
        unmount: (deferPassive = false) => { mounted = false; [...instances.values()].reverse().forEach(owner => dispose(owner, deferPassive)); instances.clear(); },
        flushPassive: () => passiveCleanups.splice(0).forEach(fn => fn()),
        remount: () => { mounted = true; render(); },
        newDraft: () => { click("Добавить шаблон"); change(input(160), "Draft"); change(nodes("textarea")[0], "Draft answer"); },
    };
}

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("PersonalLibrary actual component lifecycle", () => {
    it("keeps a rejected create dirty, guards double submit synchronously, and retries the same create ID", async () => {
        const { store, write } = makeStore(), gate = deferred();
        write.mockImplementationOnce(() => gate.promise);
        const save = vi.spyOn(store, "savePersonal"), h = harness(store);
        h.newDraft();
        h.click("Назад"); // confirmation exists before saving
        const discard = h.button("Отменить изменения");
        const form = h.submit();
        form.props.onSubmit({ preventDefault() {} });
        discard.props.onClick(); // intentionally call stale handler before React re-render
        h.render();
        expect(save).toHaveBeenCalledTimes(1);
        expect(h.button("Отменить изменения").props.disabled).toBe(true);
        expect(h.nodes("fieldset")[0].props.disabled).toBe(true);
        expect(store.data.personal).toEqual([]);
        gate.reject(new Error("disk")); await h.settle();
        expect(h.input(160).props.value).toBe("Draft");
        expect(h.onDirty).toHaveBeenLastCalledWith(true);
        expect(h.onBusy).toHaveBeenLastCalledWith(false);
        expect(textOf(h.tree())).toContain("disk");
        h.submit(); await h.settle();
        expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
        expect(save.mock.calls[1][1]).toBeUndefined();
        expect(store.data.personal).toHaveLength(1);
        expect(h.nodes("textarea")).toHaveLength(0);
        expect(h.onDirty).toHaveBeenLastCalledWith(false);
    });

    it("marks an untouched copy dirty and discards a failed copy without mutating the original", async () => {
        const { store, write } = makeStore();
        const id = await store.savePersonal(draft());
        const h = harness(store);
        h.click("Создать копию");
        expect(h.onDirty).toHaveBeenLastCalledWith(true);
        write.mockRejectedValueOnce(new Error("disk"));
        h.submit(); await h.settle();
        h.click("Назад"); h.click("Отменить изменения");
        expect(store.data.personal.map(t => t.id)).toEqual([id]);
        expect(h.onDirty).toHaveBeenLastCalledWith(false);
        expect(textOf(h.tree())).not.toContain("disk");
    });

    it("locks folder editing/cancel while pending, preserves rejection, and retries creation", async () => {
        const { store, write } = makeStore(), gate = deferred();
        const save = vi.spyOn(store, "saveFolder"), h = harness(store);
        h.click("Создать папку"); h.change(h.input(80), "GPU");
        const cancel = h.button("Отмена"), input = h.input(80);
        write.mockImplementationOnce(() => gate.promise);
        h.submit(); cancel.props.onClick(); input.props.onChange({ currentTarget: { value: "Lost" } }); h.render();
        expect(h.input(80).props).toMatchObject({ disabled: true, value: "GPU" });
        expect(h.button("Отмена").props.disabled).toBe(true);
        gate.reject(new Error("disk")); await h.settle();
        expect(h.onDirty).toHaveBeenLastCalledWith(true);
        expect(store.data.folders).toEqual([]);
        h.submit(); await h.settle();
        expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
        expect(store.data.folders).toHaveLength(1);
        expect(store.data.folders[0].name).toBe("GPU");
        expect(h.onDirty).toHaveBeenLastCalledWith(false);
    });

    it.each(["template", "folder"])("does not recreate a deleted %s edit target", async kind => {
        const { store } = makeStore();
        const id = kind === "template" ? await store.savePersonal(draft()) : await store.saveFolder("GPU");
        const h = harness(store);
        if (kind === "template") { h.click("Редактировать"); h.change(h.input(160), "Changed"); await store.deletePersonal(id); }
        else { h.click("GPU0"); h.click("Переименовать"); h.change(h.input(80), "Changed"); await store.deleteFolder(id); }
        h.submit(); await h.settle();
        expect(textOf(h.tree())).toContain("больше не существует");
        expect(h.onDirty).toHaveBeenLastCalledWith(true);
        expect(store.data.personal).toEqual([]); expect(store.data.folders).toEqual([]);
    });

    it.each(["template", "folder"])("retains a rejected %s edit and retries it as an update", async kind => {
        const { store, write } = makeStore();
        const id = kind === "template" ? await store.savePersonal(draft()) : await store.saveFolder("GPU");
        const h = harness(store);
        if (kind === "template") h.click("Редактировать");
        else { h.click("GPU0"); h.click("Переименовать"); }
        h.change(h.input(kind === "template" ? 160 : 80), "Changed");
        write.mockRejectedValueOnce(new Error("disk")); h.submit(); await h.settle();
        expect(kind === "template" ? store.data.personal[0].title : store.data.folders[0].name).toBe(kind === "template" ? "Original" : "GPU");
        expect(h.onDirty).toHaveBeenLastCalledWith(true);
        expect(h.input(kind === "template" ? 160 : 80).props.value).toBe("Changed");
        h.submit(); await h.settle();
        const records = kind === "template" ? store.data.personal : store.data.folders;
        expect(records).toHaveLength(1); expect(records[0].id).toBe(id);
        expect(kind === "template" ? store.data.personal[0].title : store.data.folders[0].name).toBe("Changed");
        expect(h.onDirty).toHaveBeenLastCalledWith(false);
    });

    it("can cancel a failed folder creation without leaving a shared record or dirty guard", async () => {
        const { store, write } = makeStore(), h = harness(store);
        h.click("Создать папку"); h.change(h.input(80), "GPU");
        write.mockRejectedValueOnce(new Error("disk")); h.submit(); await h.settle();
        h.click("Отмена");
        expect(store.data.folders).toEqual([]); expect(h.input(80)).toBeUndefined();
        expect(h.onDirty).toHaveBeenLastCalledWith(false); expect(h.onBusy).toHaveBeenLastCalledWith(false);
        expect(textOf(h.tree())).not.toContain("disk");
    });

    it.each(["resolve", "reject"] as const)("suppresses %s after unmount without clearing a newer draft's ownership", async outcome => {
        const { store, write } = makeStore(), gate = deferred();
        const h = harness(store);
        h.newDraft(); write.mockImplementationOnce(() => gate.promise); h.submit();
        await h.settle(); h.unmount(true); // React may defer passive cleanup past promise settlement.
        expect(h.onBusy).toHaveBeenLastCalledWith(false);
        expect(h.onDirty).toHaveBeenLastCalledWith(false);
        h.remount(); h.newDraft();
        const dirtyCalls = h.onDirty.mock.calls.length, busyCalls = h.onBusy.mock.calls.length;
        if (outcome === "resolve") gate.resolve(); else gate.reject(new Error("old failure"));
        await h.settle();
        expect(h.onDirty).toHaveBeenCalledTimes(dirtyCalls); expect(h.onBusy).toHaveBeenCalledTimes(busyCalls);
        expect(h.input(160).props.value).toBe("Draft");
        expect(textOf(h.tree())).not.toContain("old failure");
        h.flushPassive();
    });

    it.each(["resolve", "reject"] as const)("invalidates A→B→A before rerender and ignores stale %s", async outcome => {
        const a = makeStore(), b = makeStore(), gate = deferred();
        const h = harness(a.store);
        h.newDraft(); a.write.mockImplementationOnce(() => gate.promise);
        const oldForm = h.submit(); await h.settle();
        h.route.select(b.store); h.route.select(a.store);
        if (outcome === "resolve") gate.resolve(); else gate.reject(new Error("old failure"));
        const callbacks = [h.onDirty.mock.calls.length, h.onBusy.mock.calls.length];
        // Settle before committing the remount: selection identity alone must suppress completion.
        for (let i = 0; i < 30; i++) await Promise.resolve();
        expect([h.onDirty.mock.calls.length, h.onBusy.mock.calls.length]).toEqual(callbacks);
        h.render(); h.newDraft();
        const writes = a.write.mock.calls.length;
        oldForm.props.onSubmit({ preventDefault() {} }); await h.settle();
        expect(a.write).toHaveBeenCalledTimes(writes); expect(b.write).not.toHaveBeenCalled();
        expect(h.onDirty).toHaveBeenLastCalledWith(true);
        expect(h.input(160).props.value).toBe("Draft");
        expect(textOf(h.tree())).not.toContain("old failure");
    });

    it.each(["resolve", "reject"] as const)("keeps B's pending save busy when retired A %s", async outcome => {
        const a = makeStore(), b = makeStore(), old = deferred(), next = deferred();
        const h = harness(a.store);
        h.newDraft(); a.write.mockImplementationOnce(() => old.promise); h.submit(); await h.settle();
        h.route.select(b.store); h.render(); h.newDraft();
        b.write.mockImplementationOnce(() => next.promise); h.submit(); await h.settle();
        const dirtyCalls = h.onDirty.mock.calls.length, busyCalls = h.onBusy.mock.calls.length;
        if (outcome === "resolve") old.resolve(); else old.reject(new Error("old failure"));
        await h.settle();
        expect(h.onDirty).toHaveBeenCalledTimes(dirtyCalls); expect(h.onBusy).toHaveBeenCalledTimes(busyCalls);
        expect(h.onBusy).toHaveBeenLastCalledWith(true); expect(h.button("Сохранение…").props.disabled).toBe(true);
        expect(b.store.data.personal).toEqual([]);
        next.resolve(); await h.settle();
        expect(b.store.data.personal).toHaveLength(1); expect(h.onBusy).toHaveBeenLastCalledWith(false);
    });
});

describe("Settings / Management actual callbacks", () => {
    it.each(["resolve", "reject"] as const)("blocks pre-opened tab/modal confirmations, Escape, backdrop and close until save %s", async outcome => {
        const { store, write } = makeStore(), gate = deferred();
        const h = harness(store, "Management");
        h.newDraft(); h.click("Настройки"); h.click("Закрыть");
        const switchTab = h.button("Перейти без сохранения"), close = h.button("Закрыть без сохранения");
        const tab = h.button("Тикеты"), backdrop = h.tree();
        write.mockImplementationOnce(() => gate.promise); h.submit();
        switchTab.props.onClick(); close.props.onClick(); tab.props.onClick(); h.button("Закрыть").props.onClick();
        backdrop.props.onMouseDown({ target: backdrop, currentTarget: backdrop });
        h.listeners.get("keydown")!({ key: "Escape", target: { closest: () => null }, preventDefault() {}, stopPropagation() {} });
        h.render();
        expect(h.ui.set).not.toHaveBeenCalled();
        for (const label of ["Перейти без сохранения", "Закрыть без сохранения", "Закрыть", "Тикеты"]) expect(h.button(label).props.disabled).toBe(true);
        expect(h.nodes("textarea")).toHaveLength(1);
        if (outcome === "resolve") gate.resolve(); else gate.reject(new Error("disk"));
        await h.settle();
        expect(h.button("Закрыть").props.disabled).toBe(false);
        if (outcome === "reject") {
            expect(h.nodes("textarea")).toHaveLength(1);
            h.click("Перейти без сохранения");
            expect(h.nodes("textarea")).toHaveLength(0);
        } else expect(textOf(h.tree())).not.toContain("Есть несохранённые изменения");
        h.click("Закрыть"); expect(h.ui.set).toHaveBeenLastCalledWith({ management: false });
    });

    it("clears parent guards on forced session removal and protects the next editor from old success", async () => {
        const { store, write } = makeStore(), gate = deferred();
        const h = harness(store, "Management");
        h.newDraft(); write.mockImplementationOnce(() => gate.promise); h.submit(); await h.settle();
        h.panelState.enabled = true; h.render();
        expect(h.button("Закрыть").props.disabled).toBe(false);
        h.panelState.enabled = false; h.render(); h.newDraft();
        gate.resolve(); await h.settle(); h.click("Закрыть");
        expect(h.ui.set).not.toHaveBeenCalled();
        expect(h.button("Закрыть без сохранения")).toBeDefined();
    });

    it("exposes only three tabs and removes local import and demo entry points", () => {
        const { store } = makeStore(), h = harness(store, "Settings");
        h.click("Настройки");
        const rendered = textOf(h.tree());
        for (const removed of ["Выбрать файл", "Импорт", "Локальная библиотека", "Редактировать на панели", "Демо-данные"]) expect(rendered).not.toContain(removed);
        for (const tab of ["Мои шаблоны", "Настройки", "Тикеты"]) expect(h.button(tab)).toBeDefined();
        expect(h.nodes("a")).toHaveLength(0);
        const servers = h.nodes("div").filter(n => n.props.className === "vc-stx-server-tile");
        expect(servers).toHaveLength(3);
        for (const server of servers) {
            expect(server.props.onClick).toBeUndefined();
            expect(server.props.tabIndex).toBeUndefined();
        }
        expect(h.nodes("input").filter(n => n.props.type === "file")).toHaveLength(0);
    });
});
