import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };
const common = { React, useState: (value: any) => [value, () => {}], useRef: (value: any) => ({ current: value }) };
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes)
    : node && typeof node === "object" ? [node, ...nodes(node.props?.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join("")
    : node && typeof node === "object" ? text(node.props?.children) : typeof node === "string" ? node : "";
function load(name: string, deps: Record<string, any>) {
    const source = ts.transpileModule(readFileSync(new URL(`../src/vencord/ui/${name}.tsx`, import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
    }).outputText;
    const box = { React, exports: {}, require: (id: string) => {
        if (id === "@webpack/common") return common;
        if (id in deps) return deps[id];
        throw Error(`Unmocked ${id}`);
    } };
    runInNewContext(source, box);
    return box.exports as any;
}

it("keeps the template window mounted with a notice during retained access, but shows login after access closes", () => {
    const state = { enabled: true, phase: "ready", stale: true };
    const deps: any = { "@components/ErrorBoundary": { default: "Boundary" }, "../platform": {},
        "./panel": { panel: { use: () => state } },
        "./uiState": { ui: { useSelect: (fn: any) => fn({ windowOpen: true, dialog: null, management: false }) } },
        "./debug": { debugState: { useSelect: () => false } }, "./demo": { demo: { useSelect: () => false } }, "./flow": {} };
    deps["./reminderNoticeStore"] = { clearReminderNotifications() {} };
    for (const name of ["ComposeBar", "ContextMenu", "DebugPanel", "DemoBanner", "Dialogs", "InlinePop", "LoginWindow", "Management", "Window", "ReminderNotifications"])
        deps[`./${name}`] = { [name === "InlinePop" ? "Inline" : name]: name };
    const { Host } = load("Host", deps);
    let tree = Host();
    expect(nodes(tree).find(n => n.type === "Window")?.props.connectionNotice).toContain("загруженные шаблоны");
    expect(nodes(tree).some(n => n.type === "LoginWindow")).toBe(false);
    state.stale = false;
    expect(nodes(Host()).find(n => n.type === "Window")?.props.connectionNotice).toBe("");
    state.phase = "offline";
    expect(nodes(Host()).some(n => n.type === "LoginWindow")).toBe(true);
    expect(nodes(Host()).some(n => n.type === "Window")).toBe(false);
});

it("describes retained library access as reconnecting rather than an authenticated live connection", () => {
    const state = { enabled: true, phase: "ready", stale: true, persistent: true,
        error: "Загруженные шаблоны временно доступны; редактирование и напоминания приостановлены." };
    const { PanelConnection } = load("PanelConnection", {
        "./panel": { panel: { use: () => state } }, "./svg": {}, "./SupportedServers": { SupportedServers: "Servers" }
    });
    const tree = PanelConnection({});
    expect(text(tree)).toContain("Восстанавливаем связь · шаблоны доступны");
    expect(text(tree)).not.toContain("Подключён");
    expect(nodes(tree).filter(n => n.props?.role === "alert")).toHaveLength(0);
    expect(text(tree)).toContain("Повторить");
    expect(text(tree)).toContain("Выйти");
});
