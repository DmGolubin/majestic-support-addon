import { describe, expect, it } from "vitest";
import ts from "typescript";
import { evaluate, source } from "./betterdiscordHarness";

// Exercise the entry's actual JSX without invoking its packaging build or a client.
function fixture() {
    const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };
    const code = ts.transpileModule(source("betterdiscord/entry.tsx"), { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true
    } }).outputText;
    const { default: Plugin } = evaluate(code, {
        "../src/vencord/index": { settings: { definitions: { debug: { type: "boolean", displayName: "Debug" } }, store: { debug: false } } },
        "./ServiceSettings": { ServiceSettings: () => React.createElement("section", { "data-service": true }) },
        "./shims/host": { NAME: "SupportTemplates", api: () => ({}) },
        "./shims/common": { React, useState: () => [0, () => {}], useEffect: () => {} },
        "./shims/errorBoundary": ({ children }: any) => children,
        "./chatMounts": {}, "./native/vaultHost": {}, "./native/updateHost": {},
        "./shims/buildInfo": { PLUGIN_VERSION: "1.0.1-canary.22", PLUGIN_DISTRIBUTION: "betterdiscord" },
        "../src/vencord/buildDisplay": { distributionDisplay: (_distribution: string, version: string) => `BetterDiscord ${version}` },
        "stx:css": ""
    });
    function render(node: any): any[] {
        if (Array.isArray(node)) return node.flatMap(render);
        if (node == null || typeof node === "boolean") return [];
        if (typeof node !== "object") return [node];
        if (typeof node.type === "function") return render(node.type(node.props));
        return [node, ...render(node.props.children)];
    }
    return { Plugin, render };
}

describe("Q18 BetterDiscord delegated service settings", () => {
    it("shows one version/update header after a cached runtime takes over", () => {
        const { Plugin, render } = fixture();
        const bootstrap = new Plugin(), runtime = new Plugin();
        runtime.getVersion = () => "1.0.1-canary.99";
        bootstrap.delegate = runtime;
        const nodes = render(bootstrap.getSettingsPanel());
        expect(nodes.filter(node => node?.type === "header")).toHaveLength(1);
        expect(nodes.filter(node => node?.props?.["data-service"])).toHaveLength(1);
        expect(nodes.filter(node => node?.type === "input")).toHaveLength(1);
        expect(nodes).toContain("SupportTemplates · ");
        expect(nodes).toContain("BetterDiscord 1.0.1-canary.99");
    });

    it("retains the service header when the bundled runtime runs directly", () => {
        const { Plugin, render } = fixture();
        const nodes = render(new Plugin().getSettingsPanel());
        expect(nodes.filter(node => node?.type === "header")).toHaveLength(1);
        expect(nodes.filter(node => node?.props?.["data-service"])).toHaveLength(1);
    });
});
