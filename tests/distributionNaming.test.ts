import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import config from "../distribution/config.json";
import * as display from "../src/vencord/buildDisplay";
import { bdRequire, evaluate, root } from "./betterdiscordHarness";
// @ts-expect-error Node build utility has no generated declarations.
import { adapterPlugin } from "../betterdiscord/build.mjs";

const React = bdRequire("react");
const { renderToStaticMarkup } = bdRequire("react-dom/server");
const { JSDOM } = bdRequire("jsdom");
const identityCode = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/BuildIdentity.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
}).outputText;

describe("distribution presentation", () => {
    it.each([
        ["1.0.1-canary.18", "1.0.1 · тестовая сборка 18"],
        ["1.0.1-canary.99+abc123", "1.0.1 · тестовая сборка 99"],
        ["1.0.1", "1.0.1"],
        ["1.0.1-beta.2", "1.0.1-beta.2"],
        ["1.0.1-canary.18.extra", "1.0.1-canary.18.extra"]
    ])("formats %s without mislabelling an unknown prerelease", (version, expected) => {
        expect(display.humanBuildVersion(version)).toBe(expected);
    });

    it.each([
        ["betterdiscord", "BetterDiscord"],
        ["vencord", "Vencord (полный набор плагинов)"],
        ["standalone", "Отдельная сборка (только SupportTemplates)"]
    ] as const)("renders the %s identity with technical provenance available", (variant, label) => {
        const exports: any = {};
        runInNewContext(identityCode, { exports, React, require: (id: string) => {
            if (id === "../buildDisplay") return display;
            if (id === "../buildInfo") return { PLUGIN_DISTRIBUTION: variant, PLUGIN_VERSION: "1.0.1-canary.18", PLUGIN_BUILD: "abc123" };
            throw Error(`Unexpected import: ${id}`);
        } });
        const dom = new JSDOM(renderToStaticMarkup(React.createElement(exports.BuildIdentity)));
        try {
            const identity = dom.window.document.querySelector("p");
            expect(identity.textContent).toBe(`${label} · 1.0.1 · тестовая сборка 18`);
            expect(identity.textContent).not.toMatch(/canary/i);
            expect(identity.title).toBe("Версия: 1.0.1-canary.18 · abc123");
        } finally { dom.window.close(); }
    });
});

describe("BetterDiscord runtime identity", () => {
    let Plugin: any;
    beforeAll(async () => {
        // Bundle the real entry and host adapter in memory; no release packaging or installation.
        const result = await bdRequire("esbuild").build({
            absWorkingDir: root, entryPoints: [join(root, "betterdiscord/entry.tsx")],
            bundle: true, write: false, platform: "node", format: "cjs", target: "es2022",
            jsxFactory: "React.createElement", jsxFragment: "React.Fragment",
            inject: [join(root, "betterdiscord/shims/common.ts")], external: ["electron", "@electron/remote"],
            define: { __STX_COMMIT__: '"abc123"', VERSION: '"BetterDiscord"', BUILD_TIMESTAMP: "0" },
            outfile: "SupportTemplates.plugin.js", plugins: [adapterPlugin()], logLevel: "silent"
        });
        Plugin = evaluate(result.outputFiles.find((file: any) => file.path.endsWith(".js")).text,
            { electron: {}, "@electron/remote": {} }, { BdApi: { React } }).default;
    });

    it("keeps the registry name and full machine version while labelling the visible build", () => {
        const plugin = new Plugin();
        expect(plugin.getName()).toBe("SupportTemplates");
        expect(Plugin.prototype.getVersion()).toBe(config.version);
        expect(plugin.getVersion()).toBe(config.version);
        expect(plugin.getDescription()).toContain("для BetterDiscord");
        const dom = new JSDOM(renderToStaticMarkup(plugin.getSettingsPanel()));
        try {
            const heading = dom.window.document.querySelector("header strong");
            expect(heading.textContent).toBe(`SupportTemplates · BetterDiscord · ${display.humanBuildVersion(config.version)}`);
            expect(heading.textContent).not.toMatch(/canary/i);
            expect(heading.title).toBe(`Версия: ${config.version}`);
        } finally { dom.window.close(); }
    });

    it("displays the active delegate build without changing its updater version", () => {
        const plugin = new Plugin();
        plugin.delegate = { getVersion: () => "1.0.1-canary.99" };
        expect(plugin.getVersion()).toBe("1.0.1-canary.99");
        const dom = new JSDOM(renderToStaticMarkup(plugin.getSettingsPanel()));
        try {
            const heading = dom.window.document.querySelector("header strong");
            expect(heading.textContent).toBe("SupportTemplates · BetterDiscord · 1.0.1 · тестовая сборка 99");
            expect(heading.title).toBe("Версия: 1.0.1-canary.99");
        } finally { dom.window.close(); }
    });
});
