import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

type Node = { type: unknown; props: Record<string, any>; };
const nodes = (node: any): Node[] => Array.isArray(node) ? node.flatMap(nodes)
    : !node || typeof node !== "object" ? [] : [node, ...nodes(node.props?.children)];

describe.each(["native", "betterdiscord"])("%s host settings", variant => {
    it.each([true, false])("retains logs without account actions (plugin active: %s)", active => {
        const DiagnosticControls = vi.fn(), BuildIdentity = vi.fn();
        const React = { createElement: (type: unknown, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };
        const dependencies: Record<string, any> = {
            "./host-settings.css": {}, "../src/vencord/ui/host-settings.css": {},
            "./BuildIdentity": { BuildIdentity }, "./shims/common": { React },
            "./DiagnosticControls": { DiagnosticControls }, "../src/vencord/ui/DiagnosticControls": { DiagnosticControls },
        };
        const exports: any = {};
        const source = readFileSync(new URL(variant === "native" ? "../src/vencord/ui/NativeServiceSettings.tsx" : "../betterdiscord/ServiceSettings.tsx", import.meta.url), "utf8");
        const code = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
        }).outputText;
        runInNewContext(code, {
            exports, React,
            document: { getElementById: () => active ? {} : null },
            require: (id: string) => {
                if (!(id in dependencies)) throw new Error(`Unexpected dependency in log settings: ${id}`);
                return dependencies[id];
            },
        });
        const tree = variant === "native" ? exports.NativeServiceSettings() : exports.ServiceSettings({ active });
        const all = nodes(tree);
        expect(all.find(node => node.type === DiagnosticControls)?.props.available).toBe(active);
        expect(all.some(node => node.type === "button" || node.props.role === "status")).toBe(false);
        expect(all.filter(node => typeof node.type === "function").map(node => node.type)).toEqual(
            variant === "native" ? [BuildIdentity, DiagnosticControls] : [DiagnosticControls]);
    });
});
