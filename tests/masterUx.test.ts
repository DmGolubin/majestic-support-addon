import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { PanelError } from "../src/core/panelClient";
import { splitGreeting } from "../src/core/text";
import { fieldToken } from "../src/core/tokenEditor";

// Execute the actual component and its module cache with a small hook/commit harness.
// No Discord, network, local storage or alternate editor implementation.
const code = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/PanelPersonalLibrary.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
}).outputText;
const selectCode = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/Select.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const colorCode = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/ColorPicker.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
}).outputText;
const textOf = (n: any): string => Array.isArray(n) ? n.map(textOf).join("") : n == null || typeof n === "boolean" ? ""
    : typeof n === "object" ? textOf(n.props?.children) : String(n);
const all = (n: any, p: (n: any) => boolean): any[] => Array.isArray(n) ? n.flatMap(v => all(v, p))
    : !n || typeof n !== "object" ? [] : [...(p(n) ? [n] : []), ...all(n.props?.children, p)];
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness() {
    let renderNeeded = true, tree: any, cursor = 0, active: any;
    const instances = new Map<string, any>(), effects: (() => void)[] = [];
    const hooks = {
        useRef(value: any) { const i = cursor++; return active.slots[i] ??= { current: value }; },
        useState(value: any) {
            const owner = active, i = cursor++;
            if (!(i in owner.slots)) owner.slots[i] = typeof value === "function" ? value() : value;
            return [owner.slots[i], (next: any) => {
                if (!owner.live) return;
                const value = typeof next === "function" ? next(owner.slots[i]) : next;
                if (!Object.is(value, owner.slots[i])) { owner.slots[i] = value; renderNeeded = true; }
            }];
        },
        useLayoutEffect(fn: () => any, deps: any[]) {
            const owner = active, i = cursor++, old = owner.slots[i];
            if (!old || deps.some((v, j) => !Object.is(v, old[j]))) {
                owner.slots[i] = deps; effects.push(() => { owner.cleanups.get(i)?.(); owner.cleanups.set(i, fn()); });
            }
        }
    };
    const observable = (initial: any) => {
        let value = initial; const subscribers = new Set<() => void>();
        return { get: () => value, use: () => value,
            subscribe: (fn: () => void) => { subscribers.add(fn); return () => subscribers.delete(fn); },
            set: (patch: any) => { value = { ...value, ...patch }; renderNeeded = true; subscribers.forEach(fn => fn()); }
        };
    };
    const row = { id: "7", version: "old-version", title: "Original", text: "Hello\n[[greeting:end]]\nActual body", projects: ["mj"], shared: false,
        command: "cmd", color: "amber", folderId: null, updatedAt: "2026-10-18T00:00:00Z" };
    const personal = observable({ generation: 1, connectionId: "connection-A", scopes: ["personal:write", "folders:write"], busy: false,
        catalog: { accountId: "account-A", personalRecords: [row], folderRecords: [{ id: "8", version: "folder-v1", title: "RO folder", project: "ro", position: 0 }],
            projects: ["mj", "ro"], colors: ["amber"], colorLabels: {} } });
    const panel = observable({ phase: "ready" });
    const action = vi.fn(async (): Promise<{ refreshed: boolean }> => ({ refreshed: true }));
    const prepare = vi.fn((_request: unknown) => action);
    const props = { onDirty: vi.fn(), onBusy: vi.fn() };
    const React = { Children: { toArray: (children: any) => [children].flat(Infinity).filter(Boolean) }, isValidElement: (n: any) => !!n && typeof n === "object" && "type" in n, Fragment: "fragment", createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };
    const colorExports: any = {};
    runInNewContext(colorCode, { exports: colorExports, React, require: (id: string) => {
        if (id !== "../styles/color-picker.css") throw new Error("Unexpected palette import " + id);
        return {};
    } });
    const selectExports: any = {};
    runInNewContext(selectCode, { exports: selectExports, React, crypto: { randomUUID }, require: (id: string) => {
        if (id === "@webpack/common") return { ...hooks, React };
        if (id === "./svg") return { IconChevron: () => null };
        throw new Error("Unexpected Select import " + id);
    } });
    const deps: Record<string, unknown> = {
        "@webpack/common": hooks, "../core/panelClient": { PanelError }, "../core/text": { splitGreeting }, "../core/tokenEditor": {},
        "./markdown": { Markdown: ({ text }: any) => text }, "./Select": selectExports,
        "./TokenToolbar": { TokenToolbar: () => null }, "./PanelConnection": { PanelConnection: () => "Connection" }, "./panel-personal.css": {},
        "./ColorPicker": colorExports,
        "./panel": { panel, panelPersonal: personal, preparePanelWrite: prepare, authorizePanelEditing: vi.fn(), reloadPanel: vi.fn(),
            panelWriteMessage: (error: PanelError) => error.code }
    };
    const exports: any = {};
    runInNewContext(code, { exports, React, crypto: { randomUUID }, require: (id: string) => {
        if (!(id in deps)) throw new Error("Unexpected import " + id); return deps[id];
    } });
    const dispose = (owner: any) => { owner.live = false; owner.cleanups.forEach((fn: any) => fn?.()); };
    const render = () => {
        let passes = 0;
        do {
            if (++passes > 20) throw new Error("Render loop");
            renderNeeded = false; const seen = new Set<string>();
            const visit = (node: any, path: string): any => {
                if (Array.isArray(node)) return node.map((n, i) => visit(n, path + "." + i));
                if (!node || typeof node !== "object") return node;
                if (typeof node.type === "function") {
                    const key = path + ":" + (node.props.key ?? ""); seen.add(key);
                    active = instances.get(key);
                    if (!active || active.type !== node.type) { if (active) dispose(active); active = { type: node.type, slots: [], cleanups: new Map(), live: true }; instances.set(key, active); }
                    cursor = 0; return visit(node.type(node.props), key + ".child");
                }
                return { ...node, props: { ...node.props, children: visit(node.props.children, path + ".child") } };
            };
            tree = visit(React.createElement(exports.PanelPersonalLibrary, props), "root");
            for (const [key, owner] of instances) if (!seen.has(key)) { dispose(owner); instances.delete(key); }
            while (effects.length) effects.shift()!();
        } while (renderNeeded);
        return tree;
    };
    const find = (predicate: (n: any) => boolean) => { render(); const found = all(tree, predicate)[0]; if (!found) throw new Error("Missing control"); return found; };
    const click = (label: string) => { const b = find(n => n.type === "button" && textOf(n) === label); expect(b.props.disabled).not.toBe(true); b.props.onClick(); render(); };
    const change = (label: string, value: string) => {
        const l = find(n => n.type === "label" && textOf(n).startsWith(label));
        const input = all(l, n => ["input", "select"].includes(n.type))[0]; input.props.onChange({ currentTarget: { value } }); render();
    };
    const open = () => { find(n => n.props?.className === "vc-stx-pp-card").props.onClick(); render(); };
    const submit = async () => { find(n => n.type === "form").props.onSubmit({ preventDefault() {} }); await settle(); render(); };
    const unmount = () => { instances.forEach(dispose); instances.clear(); };
    const value = (label: string) => all(find(n => n.type === "label" && textOf(n).startsWith(label)), n => n.type === "input")[0].props.value;
    render();
    return { exports, personal, panel, row, action, prepare, props, render, find, click, change, open, submit, unmount, value, text: () => textOf(render()) };
}

// Regression tests for the confirmed Role06 UX defects.
// Hook harness adapted from panelPersonalLibrary.test.ts; the real Select is executed too.
const choose = (h: ReturnType<typeof harness>, label: string, option: string) => {
    h.find(n => n.props.role === "combobox" && n.props["aria-label"] === label).props.onClick();
    h.find(n => n.props.role === "option" && textOf(n) === option).props.onClick(); h.render();
};

describe("Role06 folder UX regressions (no network or browser)", () => {
    it("shows surviving templates under all folders after deleting the selected folder", async () => {
        const h = harness();
        h.row.folderId = "8" as any;
        h.row.projects = ["ro"];
        choose(h, "Фильтр папок", "RO folder · Россия Онлайн");
        expect(all(h.render(), n => n.props.className === "vc-stx-pp-card")).toHaveLength(1);
        h.click("RO folderРоссия Онлайн"); h.click("Удалить");
        h.action.mockImplementationOnce(async () => {
            h.personal.set({ catalog: { ...h.personal.get().catalog, folderRecords: [], personalRecords: [{ ...h.row, folderId: null }] } });
            return { refreshed: true };
        });
        h.click("Подтвердить удаление"); await settle(); h.render();
        expect(h.prepare.mock.calls[0][0]).toMatchObject({ method: "DELETE", path: "/folders/8" });
        expect(h.personal.get().catalog.personalRecords).toHaveLength(1);
        expect(textOf(h.find(n => n.props.role === "combobox" && n.props["aria-label"] === "Фильтр папок"))).toBe("Все папки");
        expect(all(h.render(), n => n.props.className === "vc-stx-pp-card")).toHaveLength(1);
        expect(h.text()).not.toContain("Шаблоны не найдены.");
        h.unmount();
    });

    it("starts new drafts without the removed folder after a same-account refresh", async () => {
        const h = harness();
        choose(h, "Фильтр папок", "RO folder · Россия Онлайн");
        // A same-account refreshed snapshot removes the selected folder.
        h.personal.set({ catalog: { ...h.personal.get().catalog, folderRecords: [] } });
        h.render(); h.click("Добавить шаблон"); h.change("Название", "New title");
        h.find(n => n.type === "textarea").props.onChange({ currentTarget: { value: "New body" } });
        expect(textOf(h.find(n => n.props.role === "combobox" && n.props["aria-label"] === "Папка шаблона"))).toBe("Без папки");
        await h.submit();
        expect(h.prepare.mock.calls[0][0]).toMatchObject({ body: { folderId: null, title: "New title", text: "New body" } });
        h.unmount();
    });

    it("preserves an open draft and identifies its vanished folder until explicitly reselected", async () => {
        const h = harness(); h.row.folderId = "8" as any; h.row.projects = ["ro"];
        h.open(); h.change("Название", "Unsaved title");
        h.personal.set({ catalog: { ...h.personal.get().catalog, folderRecords: [] } });
        expect(textOf(h.find(n => n.props.role === "combobox" && n.props["aria-label"] === "Папка шаблона"))).toBe("Папка недоступна");
        expect(h.text()).toContain("Выберите другую папку или «Без папки».");
        expect(h.value("Название")).toBe("Unsaved title");
        expect(h.find(n => n.type === "textarea").props.value).toBe(h.row.text);
        expect(h.prepare).not.toHaveBeenCalled();
        choose(h, "Папка шаблона", "Без папки"); await h.submit();
        expect(h.prepare.mock.calls[0][0]).toMatchObject({ body: { folderId: null, title: "Unsaved title", text: h.row.text } });
        h.unmount();
    });

    it("preserves an uncertain create payload and UUID when its folder disappears, including remount", async () => {
        const h = harness(); choose(h, "Фильтр папок", "RO folder · Россия Онлайн");
        h.click("Добавить шаблон"); h.change("Название", "Pending title");
        h.find(n => n.type === "textarea").props.onChange({ currentTarget: { value: "Pending body" } });
        h.action.mockRejectedValueOnce(new PanelError("network_error"));
        await h.submit();
        const request = h.prepare.mock.calls[0][0];
        expect(request).toMatchObject({ method: "POST", idempotencyKey: expect.any(String), body: { folderId: "8", project: "russia-online" } });
        const before = JSON.stringify(request);
        h.personal.set({ catalog: { ...h.personal.get().catalog, folderRecords: [] } });
        h.unmount(); h.render();
        expect(textOf(h.find(n => n.props.role === "combobox" && n.props["aria-label"] === "Папка шаблона"))).toBe("Папка недоступна");
        expect(h.find(n => n.type === "fieldset").props.disabled).toBe(true);
        expect(h.value("Название")).toBe("Pending title");
        expect(h.text()).not.toContain("Выберите другую папку");
        expect(h.text()).toContain("Повторить сохранение");
        await h.submit();
        expect(h.action).toHaveBeenCalledTimes(2);
        expect(h.prepare).toHaveBeenCalledOnce();
        expect(JSON.stringify(h.prepare.mock.calls[0][0])).toBe(before);
        h.unmount();
    });

    it.each(["Без папки", "RO folder · Россия Онлайн"])("keeps an existing filter and new draft consistent: %s", async option => {
        const h = harness(); choose(h, "Фильтр папок", option);
        h.personal.set({ catalog: { ...h.personal.get().catalog } });
        expect(textOf(h.find(n => n.props.role === "combobox" && n.props["aria-label"] === "Фильтр папок"))).toBe(option);
        h.click("Добавить шаблон"); h.change("Название", "New title");
        await h.submit();
        expect(h.prepare.mock.calls[0][0]).toMatchObject({ body: { folderId: option === "Без папки" ? null : "8" } });
        h.unmount();
    });
});

function simpleComponent(name: string, deps: Record<string, any>, globals: Record<string, any> = {}) {
    const slots: any[] = []; let cursor = 0;
    const React = { Fragment: "fragment", createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };
    const hooks = {
        useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
            return [slots[i], (value: any) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
        useRef: (value: any) => ({ current: value }), useEffect: () => {},
    };
    const exports: any = {};
    const code = ts.transpileModule(readFileSync(new URL(`../src/vencord/ui/${name}.tsx`, import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
    }).outputText;
    runInNewContext(code, { exports, React, ...globals, require: (id: string) => {
        if (id === "@webpack/common") return hooks;
        if (!(id in deps)) throw Error("Unexpected import " + id);
        return deps[id];
    } });
    return (props: any) => { cursor = 0; return exports[name](props); };
}

describe("Role06 keyboard and field semantics regressions", () => {
    it.each([{ composing: false, keyCode: 229 }, { composing: true, keyCode: 13 }, { composing: false, keyCode: 13 }])("guards composition but accepts ordinary Enter: %j", ({ composing, keyCode }) => {
        class Input {}
        const render = simpleComponent("TokenToolbar", {
            "../core/tokenEditor": { fieldToken }, "./token-toolbar.css": {},
        }, { HTMLInputElement: Input });
        const insert = vi.fn(() => true), capture = vi.fn();
        const props = { capture, insert, hasBoundary: false };
        let tree = render(props);
        all(tree, n => n.type === "button")[0].props.onClick(); tree = render(props);
        all(tree, n => n.type === "input")[0].props.onChange({ currentTarget: { value: "ник" } }); tree = render(props);
        const key = { key: "Enter", keyCode, nativeEvent: { isComposing: composing, keyCode }, target: new Input(), preventDefault: vi.fn() };
        all(tree, n => n.props.role === "group")[0].props.onKeyDown(key);
        if (composing || keyCode === 229) {
            expect(insert).not.toHaveBeenCalled();
            expect(key.preventDefault).not.toHaveBeenCalled();
            expect(all(render(props), n => n.props.role === "group")).toHaveLength(1);
        } else {
            expect(insert).toHaveBeenCalledExactlyOnceWith("{{ник}}");
            expect(key.preventDefault).toHaveBeenCalledOnce();
            expect(all(render(props), n => n.props.role === "group")).toHaveLength(0);
        }
    });

    it("associates distinct field labels, names choice groups and exposes changing selection", () => {
        const dialog = { kind: "fields", title: "Answer", initial: { Status: "A" }, fields: [{ name: "Nickname", options: [] }, { name: "Server", options: [] }, { name: "Status", options: ["A", "B"] }], resolve: vi.fn() };
        const render = simpleComponent("Dialogs", {
            "../core/keys": {}, "../platform": {}, "./debug": {}, "./keylatch": {},
            "./uiState": { ui: { useSelect: (fn: any) => fn({ dialog }) } },
        });
        const draw = () => {
            const root = render({});
            // Dialogs -> Fields -> Frame, all actual component functions.
            const fields = root.type(root.props); return fields.type(fields.props);
        };
        let frame = draw();
        expect(all(frame, n => n.props.role === "dialog")[0].props).toMatchObject({ "aria-modal": "true", "aria-label": "Answer — заполните перед вставкой" });
        const inputs = all(frame, n => n.type === "input");
        expect(new Set(inputs.map(n => n.props.id)).size).toBe(2);
        expect(inputs.map(input => textOf(all(frame, n => n.type === "label" && n.props.htmlFor === input.props.id)[0]))).toEqual(["Nickname", "Server"]);
        const group = all(frame, n => n.props.role === "group")[0];
        expect(textOf(all(frame, n => n.props.id === group.props["aria-labelledby"])[0])).toBe("Status");
        const option = (label: string) => all(frame, n => n.type === "button" && textOf(n) === label)[0];
        expect(option("A").props["aria-pressed"]).toBe(true);
        expect(option("B").props["aria-pressed"]).toBe(false);
        option("B").props.onClick(); frame = draw();
        expect(option("A").props["aria-pressed"]).toBe(false);
        expect(option("B").props["aria-pressed"]).toBe(true);
        option("Вставить").props.onClick();
        expect(dialog.resolve).toHaveBeenCalledWith({ Status: "B" });
    });
});
