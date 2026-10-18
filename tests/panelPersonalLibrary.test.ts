import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { PanelError } from "../src/core/panelClient";
import { splitGreeting } from "../src/core/text";

// Execute the actual component and its module cache with a small hook/commit harness.
// No Discord, network, local storage or alternate editor implementation.
const code = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/PanelPersonalLibrary.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
}).outputText;
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
    const React = { Fragment: "fragment", createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };
    const colorExports: any = {};
    runInNewContext(colorCode, { exports: colorExports, React, require: (id: string) => {
        if (id !== "../styles/color-picker.css") throw new Error("Unexpected palette import " + id);
        return {};
    } });
    const deps: Record<string, unknown> = {
        "@webpack/common": hooks, "../core/panelClient": { PanelError }, "../core/text": { splitGreeting }, "../core/tokenEditor": {},
        "./markdown": { Markdown: ({ text }: any) => text }, "./Select": { Select: (props: any) => React.createElement("select", props, ...props.children) },
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
                    if (!active) { active = { slots: [], cleanups: new Map(), live: true }; instances.set(key, active); }
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

describe("panel personal editor lifecycle and retries", () => {
    it("retains an unsaved draft across direct Settings unmount, and explicit discard clears it", () => {
        const h = harness(); h.open(); h.change("Название", "Unsaved"); h.unmount(); h.render();
        expect(h.value("Название")).toBe("Unsaved"); expect(h.props.onDirty).toHaveBeenLastCalledWith(true);
        h.exports.discardPanelDraft(); h.render(); expect(h.text()).not.toContain("Редактирование шаблона");
        h.open(); expect(h.value("Название")).toBe("Original"); h.unmount();
    });
    it("clears cached drafts on connection, account and generation changes", () => {
        const h = harness(); h.open(); h.change("Название", "Private draft"); h.unmount();
        const initial = h.personal.get(); h.personal.set({ connectionId: "connection-B" }); h.render();
        expect(h.text()).not.toContain("Private draft"); h.open(); expect(h.value("Название")).toBe("Original");
        h.change("Название", "Another draft"); h.personal.set({ generation: 2, catalog: null }); h.render();
        h.personal.set(initial); h.render(); expect(h.text()).not.toContain("Another draft"); h.unmount();
    });
    it.each(["stale_library", "write_busy", "invalid_request"])("keeps uncertain create UUID/action across retry preflight %s", async code => {
        const h = harness(); h.click("Добавить шаблон"); h.change("Название", "New");
        h.action.mockRejectedValueOnce(new PanelError("network_error")).mockRejectedValueOnce(new PanelError(code));
        await h.submit(); const request = h.prepare.mock.calls[0][0];
        h.unmount(); h.render(); await h.submit();
        expect(h.prepare).toHaveBeenCalledTimes(1); expect(h.text()).toContain("Повторить сохранение");
        await h.submit(); expect(h.prepare).toHaveBeenCalledTimes(1); expect(h.prepare.mock.calls[0][0]).toBe(request);
        expect(h.action).toHaveBeenCalledTimes(3); expect(h.text()).toContain("Сохранено на панели"); h.unmount();
    });
    it("preserves a 412 draft, blocks save, and hides cached comparison until fresh reload", async () => {
        const h = harness(); h.open(); h.change("Название", "My draft");
        h.action.mockImplementationOnce(async () => { h.panel.set({ phase: "offline" }); throw new PanelError("version_conflict", 412); });
        await h.submit(); expect(h.value("Название")).toBe("My draft");
        expect(h.text()).toContain("Текущая версия ещё не загружена");
        expect(h.text()).not.toContain("Отменить черновик и открыть текущую запись");
        expect(h.find(n => n.type === "button" && textOf(n) === "Сохранить на панели").props.disabled).toBe(true);
        h.row.title = "Fresh server"; h.row.version = "new-version"; h.panel.set({ phase: "ready" });
        expect(h.text()).toContain("Fresh server"); expect(h.value("Название")).toBe("My draft");
        h.click("Продолжить как новый шаблон"); expect(h.value("Название")).toBe("My draft (копия)");
        await h.submit(); expect(h.prepare.mock.calls[1][0]).toMatchObject({ method: "POST", body: { title: "My draft (копия)" } }); h.unmount();
    });
    it("derives a new template project from its selected folder and translates amber", async () => {
        const h = harness(); expect(h.text()).toContain("Янтарный"); expect(h.text()).not.toContain("Hello");
        h.change("Папка", "8"); h.click("Добавить шаблон"); h.change("Название", "RO new"); await h.submit();
        expect(h.prepare.mock.calls[0][0]).toMatchObject({ body: { project: "russia-online", folderId: "8" } }); h.unmount();
    });
});
