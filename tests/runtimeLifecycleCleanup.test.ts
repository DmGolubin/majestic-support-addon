import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const code = ts.transpileModule(readFileSync(new URL("../src/vencord/index.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;

function harness() {
    const resources = new Set<string>(), attached = new Set<any>();
    const calls: string[] = [], errors = vi.fn(), startupError = new Error("original mount failure");
    const fault = { startup: "", cleanup: new Set<string>(), reenter: "" };
    let plugin: any;
    const step = (name: string) => {
        calls.push(name);
        if (name === fault.reenter) plugin.stop();
        if (fault.cleanup.has(name)) throw Error("cleanup failed: " + name);
        if (fault.startup === name) throw startupError;
    };
    const release = (name: string) => () => { resources.delete(name); step("off:" + name); };
    const acquire = (name: string) => () => { step("start:" + name); resources.add(name); return release(name); };
    const load = vi.fn(async () => {});
    let panelOff: (() => void) | null = null;
    const nodes: any[] = [], roots: any[] = [];
    const ui = { get: () => ({}), set: vi.fn(() => step("ui")) };
    const document = {
        addEventListener: (_: string, fn: any) => { attached.add(fn); step("add:keydown"); },
        removeEventListener: (_: string, fn: any) => { attached.delete(fn); step("remove:keydown"); },
        createElement: () => {
            step("create:host");
            const node: any = { id: "", connected: false, remove: vi.fn(() => { node.connected = false; step("remove:host"); }) };
            nodes.push(node); return node;
        },
        body: { append: (node: any) => { node.connected = true; step("append:host"); } },
    };
    const deps: Record<string, any> = {
        "./ui/diagnostics": { startDiagnostics: vi.fn(), stopDiagnostics: vi.fn() },
        "./styles.css": {}, "@api/ChatButtons": {},
        "@api/Settings": { definePluginSettings: () => ({ store: { debug: true, debugVerbose: true } }) },
        "@utils/types": { default: (p: unknown) => p, OptionType: { COMPONENT: 1, BOOLEAN: 2 } },
        "@webpack/common": { createRoot: () => {
            step("create:root"); const root = { render: vi.fn(() => step("render")), unmount: vi.fn(() => step("unmount")) };
            roots.push(root); return root;
        } },
        "./core/guard": {}, "./core/keys": {}, "./core/rank": {},
        "./platform": { currentGuildId: () => "guild", toast: () => step("toast"), onChannelChange: acquire("channel"), disposePlatformNotices: () => step("notices") },
        "./ui/ContextMenu": { resetMenuGuards: () => step("menu") },
        "./ui/debug": { setDebugVerbose: () => step("verbose"), setDebugEnabled: (on: boolean) => step(on ? "debug:on" : "debug:off"), setLoadTime: () => step("loadTime") },
        "./ui/demo": { disposeDemo: () => step("demo") }, "./ui/flow": { supersede: () => step("dialogs") },
        "./ui/fonts": { loadFonts: () => { resources.add("fonts"); step("fonts"); }, unloadFonts: release("fonts") },
        "./ui/Host": { Host: () => null }, "./ui/icons": {},
        "./ui/inline": { startInline: acquire("inline"), resetInline: () => step("inlineState") },
        "./ui/keylatch": { startLatch: acquire("latch") },
        "./ui/op": { nextGeneration: () => step("generation"), clearTargets: () => step("targets") },
        "./ui/panel": { startPanel: () => panelOff = acquire("panel")(), disposePanel: () => {
            const off = panelOff; panelOff = null;
            try { off?.(); } finally { step("panel"); }
        } },
        "./ui/ProjectIcon": {}, "./ui/NativeServiceSettings": {}, "./ui/ticketSound": { startTicketSound: acquire("sound") },
        "./ui/uiState": { realStore: { load }, ui }, "./ui/Window": {},
    };
    const exports: any = {};
    runInNewContext(code, { exports, document, performance: { now: () => 0 }, React: { createElement: () => ({}) }, console: { error: errors },
        require: (id: string) => { if (!(id in deps)) throw Error("Unexpected import " + id); return deps[id]; } });
    plugin = exports.default;
    return { plugin, resources, attached, calls, fault, load, roots, nodes, ui, errors, startupError };
}

describe("common runtime startup and teardown", () => {
    it.each(["add:keydown", "fonts", "append:host", "create:root", "render", "start:inline", "start:channel", "debug:on", "loadTime"])("rolls back failure at %s and can start again", phase => {
        return (async () => {
            const h = harness(); h.fault.startup = phase;
            await expect(h.plugin.start()).rejects.toBe(h.startupError);
            expect(h.resources.size).toBe(0); expect(h.attached.size).toBe(0);
            expect(h.nodes.every(n => !n.connected)).toBe(true);
            expect(h.roots.every(r => r.unmount.mock.calls.length === 1)).toBe(true);
            h.fault.startup = ""; await h.plugin.start();
            expect(h.nodes.filter(n => n.connected)).toHaveLength(1);
            h.plugin.stop(); expect(h.resources.size).toBe(0); expect(h.attached.size).toBe(0);
        })();
    });

    it("attempts every teardown phase despite errors and detaches owned resources before invoking callbacks", async () => {
        const h = harness(); await h.plugin.start(); h.calls.length = 0;
        h.fault.cleanup = new Set(["panel", "demo", "off:sound", "off:channel", "off:inline", "off:latch", "dialogs", "unmount", "off:fonts", "ui", "debug:off"]);
        h.fault.reenter = "off:panel";
        expect(() => h.plugin.stop()).not.toThrow();
        expect(h.calls).toEqual(["generation", "off:panel", "panel", "demo", "off:sound", "targets", "menu", "remove:keydown", "off:channel", "off:inline", "off:latch", "dialogs", "inlineState", "unmount", "remove:host", "off:fonts", "ui", "debug:off", "notices"]);
        expect(h.resources.size).toBe(0); expect(h.attached.size).toBe(0); expect(h.nodes[0].connected).toBe(false);
        expect(h.errors).toHaveBeenCalledTimes(h.fault.cleanup.size);
        h.plugin.stop(); expect(h.roots[0].unmount).toHaveBeenCalledOnce(); expect(h.nodes[0].remove).toHaveBeenCalledOnce();
        expect(h.calls.filter(c => c === "off:panel")).toHaveLength(1);
        h.fault.cleanup.clear(); h.fault.reenter = "";
        await h.plugin.start(); h.plugin.stop(); expect(h.resources.size).toBe(0);
    });

    it("preserves the original startup error when rollback also throws", async () => {
        const h = harness(); h.fault.startup = "render"; h.fault.cleanup.add("off:panel"); h.fault.cleanup.add("unmount");
        await expect(h.plugin.start()).rejects.toBe(h.startupError);
        expect(h.nodes[0].connected).toBe(false); expect(h.calls).toContain("debug:off"); expect(h.calls).toContain("notices");
    });

    it("does not remount after stop during storage load or duplicate an already started runtime", async () => {
        const h = harness(); let resolve!: () => void;
        h.load.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
        const pending = h.plugin.start(); h.plugin.stop(); resolve(); await pending;
        expect(h.nodes).toHaveLength(0); expect(h.resources.size).toBe(0);
        await Promise.all([h.plugin.start(), h.plugin.start()]); await h.plugin.start();
        expect(h.nodes).toHaveLength(1); expect(h.attached.size).toBe(1);
        h.plugin.stop(); expect(h.resources.size).toBe(0);
    });
});
