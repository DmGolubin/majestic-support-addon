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

// Fixture reused from panelPersonalLibrary.test.ts; only Role16 scenarios are added below.
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

const deferred = () => {
    let resolve!: (value: { refreshed: boolean }) => void;
    let reject!: (error: PanelError) => void;
    const promise = new Promise<{ refreshed: boolean }>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const button = (h: ReturnType<typeof harness>, label: string) => h.find(n => n.type === "button" && textOf(n) === label);

describe("Master Role16 bounded user paths on the actual panel component", () => {
    it.each(["resolve", "reject"] as const)("deduplicates repeated save and blocks cancel while a write will %s", async outcome => {
        const h = harness(), gate = deferred();
        h.open(); h.change("Название", "Pending title");
        h.action.mockImplementationOnce(() => gate.promise);
        const form = h.find(n => n.type === "form");
        form.props.onSubmit({ preventDefault() {} });
        // Same handler before a commit, then fresh controls after commit.
        form.props.onSubmit({ preventDefault() {} });
        await h.submit(); await h.submit();
        expect(h.action).toHaveBeenCalledTimes(1); expect(h.prepare).toHaveBeenCalledTimes(1);
        expect(button(h, "Отмена").props.disabled).toBe(true);
        expect(button(h, "Сохраняем…").props.disabled).toBe(true);
        button(h, "Отмена").props.onClick(); button(h, "Отмена").props.onClick();
        h.change("Название", "Attempted replacement");
        expect(h.value("Название")).toBe("Pending title");
        expect(h.text()).not.toContain("Удалить несохранённый черновик?");
        expect(h.props.onBusy).toHaveBeenLastCalledWith(true);
        if (outcome === "resolve") gate.resolve({ refreshed: true });
        else gate.reject(new PanelError("network_error"));
        await settle(); h.render();
        expect(h.props.onBusy).toHaveBeenLastCalledWith(false);
        if (outcome === "resolve") expect(h.text()).toContain("Сохранено на панели");
        else {
            expect(h.value("Название")).toBe("Pending title");
            h.click("Отмена"); h.click("Продолжить редактирование");
            expect(h.value("Название")).toBe("Pending title");
        }
        h.unmount();
    });

    it("freezes unknown-outcome input and reuses one create action until explicit discard", async () => {
        const h = harness(); h.click("Добавить шаблон"); h.change("Название", "First intent");
        h.action.mockRejectedValueOnce(new PanelError("network_error"));
        await h.submit();
        const request: any = h.prepare.mock.calls[0][0];
        expect(request.method).toBe("POST"); expect(request.idempotencyKey).toBeTruthy();
        h.change("Название", "Second intent");
        expect(h.value("Название")).toBe("First intent");
        h.action.mockRejectedValueOnce(new PanelError("network_error"));
        await h.submit();
        expect(h.prepare).toHaveBeenCalledTimes(1); expect(h.action).toHaveBeenCalledTimes(2);
        expect(request.body.title).toBe("First intent");
        h.click("Отмена"); expect(h.text()).toContain("уже могла сохраниться на панели");
        h.click("Удалить черновик");
        h.click("Добавить шаблон"); h.change("Название", "Second intent"); await h.submit();
        const next: any = h.prepare.mock.calls[1][0];
        expect(next.body.title).toBe("Second intent"); expect(next.idempotencyKey).not.toBe(request.idempotencyKey);
        expect(h.action).toHaveBeenCalledTimes(3); h.unmount();
    });

    it("locks a dirty draft on scope revocation and saves it after rights return", async () => {
        const h = harness(); h.open(); h.change("Название", "Draft before revocation");
        h.personal.set({ scopes: [] }); h.render();
        expect(h.find(n => n.type === "fieldset").props.disabled).toBe(true);
        h.change("Название", "Disallowed change"); await h.submit();
        expect(h.value("Название")).toBe("Draft before revocation");
        expect(h.prepare).not.toHaveBeenCalled();
        h.click("Отмена"); h.click("Продолжить редактирование");
        h.personal.set({ scopes: ["personal:write"] }); await h.submit();
        expect(h.prepare.mock.calls[0][0]).toMatchObject({ method: "PATCH", body: { title: "Draft before revocation" } });
        expect(h.action).toHaveBeenCalledTimes(1); h.unmount();
    });

    it("does not retry an uncertain write after scope revocation, retaining its action when rights return", async () => {
        const h = harness(), gate = deferred(); h.open(); h.change("Название", "Pending revocation");
        h.action.mockImplementationOnce(() => gate.promise); await h.submit();
        h.personal.set({ scopes: [] }); h.render(); gate.reject(new PanelError("network_error"));
        await settle(); await h.submit();
        expect(h.action).toHaveBeenCalledTimes(1); expect(h.value("Название")).toBe("Pending revocation");
        h.personal.set({ scopes: ["personal:write"] }); await h.submit();
        expect(h.prepare).toHaveBeenCalledTimes(1); expect(h.action).toHaveBeenCalledTimes(2);
        expect(h.text()).toContain("Сохранено на панели"); h.unmount();
    });
});
