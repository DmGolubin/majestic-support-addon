import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { bdRequire, evaluate, loadAdapter, root, source } from "./betterdiscordHarness";

const { JSDOM } = bdRequire("jsdom");
const React = bdRequire("react");
const ReactDOM = bdRequire("react-dom/client");
let bundle: string;
beforeAll(() => {
    execFileSync(process.execPath, ["betterdiscord/build.mjs"], { cwd: root, stdio: "pipe" });
    bundle = source("betterdiscord/out/SupportTemplates.plugin.js");
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllGlobals(); });

function fixture({ delayedRead = false, missingStore = false, restrictedHost = false } = {}) {
    const dom = new JSDOM('<!doctype html><body><main><div class="channelTextArea_test"><div class="buttons_test"></div><div contenteditable="true" role="textbox" tabindex="0" data-slate-editor="true">draft stays</div></div></main></body>', { url: "https://discord.com/channels/test", pretendToBeVisual: true });
    const w = dom.window;
    const globals: any = {};
    for (const name of ["window", "document", "navigator", "location", "Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "MutationObserver", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle"]) {
        globals[name] = name === "window" ? w : w[name]; vi.stubGlobal(name, globals[name]);
    }
    globals.requestAnimationFrame = w.requestAnimationFrame.bind(w);
    globals.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
    vi.stubGlobal("requestAnimationFrame", globals.requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", globals.cancelAnimationFrame);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const fonts = new Set(); Object.defineProperty(w.document, "fonts", { value: fonts });
    globals.FontFace = class {};
    globals.atob = (s: string) => Buffer.from(s, "base64").toString("binary");
    globals.performance = performance;
    globals.innerWidth = w.innerWidth; globals.innerHeight = w.innerHeight;
    globals.process = { ...process, platform: "linux" }; // no production updater network / OS vault in DOM tests
    globals.console = { ...console, debug: vi.fn() };
    globals.AbortController = w.AbortController;
    const flux = new Map<string, Set<(e: any) => void>>();
    const changes = new Set<() => void>();
    const dispatcher = {
        subscribe(type: string, fn: any) { if (!flux.has(type)) flux.set(type, new Set()); flux.get(type)!.add(fn); },
        unsubscribe(type: string, fn: any) { flux.get(type)?.delete(fn); },
        dispatch(e: any) { for (const fn of flux.get(e.type) ?? []) fn(e); }
    };
    let channel = { id: "123456789012345678", name: "support", guild_id: "530693013622489088" };
    const stores: any = {
        ChannelStore: { getChannel: () => channel, addChangeListener: (fn: any) => changes.add(fn), removeChangeListener: (fn: any) => changes.delete(fn) },
        SelectedChannelStore: { getChannelId: () => channel.id }, SelectedGuildStore: { getGuildId: () => channel.guild_id },
        GuildStore: { getGuild: () => ({ name: "Majestic" }) },
        UserStore: { getCurrentUser: () => null, addChangeListener: (fn: any) => changes.add(fn), removeChangeListener: (fn: any) => changes.delete(fn) },
        AccessibilityStore: {}, LocaleStore: {}, ThemeStore: {}
    };
    const componentDispatch = { subscribe() {}, dispatchToLastSubscribed: vi.fn() };
    const data = new Map();
    let resolveRead!: (value: any) => void;
    let delay = delayedRead;
    const wait = new Promise(resolve => { resolveRead = resolve; });
    const styleNodes = new Map();
    const host: any = {
        React, ReactDOM,
        Webpack: { getStore: (name: string) => missingStore && name === "ChannelStore" ? undefined : stores[name],
            getModule: (filter: any) => [dispatcher, componentDispatch].find(filter) },
        Data: { load: vi.fn((_name, key) => {
            if (delay && key !== "host-settings") { delay = false; return wait; }
            return data.get(key);
        }), save: vi.fn((_name, key, value) => data.set(key, structuredClone(value))) },
        UI: { showToast: vi.fn() }, Plugins: { folder: "unused" },
        DOM: { addStyle(name: string, css: string) { const node = w.document.createElement("style"); node.textContent = css; w.document.head.append(node); styleNodes.set(name, node); },
            removeStyle(name: string) { styleNodes.get(name)?.remove(); styleNodes.delete(name); } }
    };
    globals.BdApi = host;
    // Cross-realm clone of a deliberately deferred BdApi.load is used only to exercise
    // stop/start while the shared Store load awaits; production BD load is synchronous.
    globals.structuredClone = (value: any) => value === wait ? wait : structuredClone(value);
    const deniedModules: string[] = [];
    if (restrictedHost) {
        globals.process = { platform: "win32", env: {}, pid: 1 };
        // BetterDiscord's renderer exposes a finite polyfill switch, not Node require.
        // In particular fs has no promises/open/link and crypto has no randomUUID.
        const modules: Record<string, any> = {
            fs: { existsSync: () => false }, path: bdRequire("path"),
            crypto: { createHash: bdRequire("crypto").createHash, randomBytes: bdRequire("crypto").randomBytes },
            electron: {}, buffer: bdRequire("buffer"), events: bdRequire("events")
        };
        globals.require = (name: string) => {
            if (name in modules) return modules[name];
            deniedModules.push(name);
            throw new Error(`ENOENT: no such file or directory, lstat 'Discord/${name}'`);
        };
    }
    const Plugin = evaluate(bundle, { electron: { clipboard: { writeText: vi.fn() } }, "@electron/remote": {} }, globals);
    const plugin = new Plugin();
    const frame = () => new Promise(resolve => w.requestAnimationFrame(() => resolve(undefined)));
    cleanups.push(async () => { await React.act(async () => { plugin.stop(); resolveRead(undefined); await frame(); }); w.close(); });
    return { plugin, Plugin, host, componentDispatch, flux, changes, fonts, document: w.document, w, frame, resolveRead, data, deniedModules,
        channel: (guild: string) => { channel = { ...channel, guild_id: guild }; dispatcher.dispatch({ type: "CHANNEL_SELECT", guildId: guild }); },
        key: () => { const event = new w.KeyboardEvent("keydown", { code: "KeyT", key: "t", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }); w.document.activeElement.dispatchEvent(event); return event; } };
}

describe("BetterDiscord final bundle in React/DOM", () => {
    it("loads and opens settings under BetterDiscord's restricted module loader without probing unsupported modules", async () => {
        const f = fixture({ restrictedHost: true });
        await React.act(async () => { await f.plugin.start(); await f.frame(); });
        expect(f.document.querySelectorAll('[data-stx="button"]')).toHaveLength(1);
        const node = f.document.createElement("div"); f.document.body.append(node);
        const settings = ReactDOM.createRoot(node);
        await React.act(async () => { settings.render(f.plugin.getSettingsPanel()); });
        expect(node.textContent).toContain("Мои шаблоны");
        expect(node.textContent).toContain("Обновляйте плагин вручную");
        expect(f.deniedModules).toEqual([]);
        await React.act(async () => settings.unmount());
    });
    it("mounts the actual shared UI with embedded CSS, opens by keyboard/button, renders host settings and cleans all roots/subscriptions", async () => {
        const f = fixture();
        await React.act(async () => { await f.plugin.start(); await f.frame(); });
        expect(f.document.querySelectorAll("#vc-stx-host")).toHaveLength(1);
        expect(f.document.querySelectorAll('[data-stx="button"]')).toHaveLength(1);
        expect(f.document.head.textContent).toContain(".vc-stx-root");
        const editor = f.document.querySelector('[data-slate-editor="true"]');
        editor.focus();
        let event: any;
        await React.act(async () => { event = f.key(); });
        expect(event.defaultPrevented).toBe(true);
        expect(f.document.body.textContent).toContain("Подключите аккаунт панели");
        await React.act(async () => { f.document.querySelector('[data-stx="button"]').click(); });
        expect(f.document.querySelector(".vc-stx-login")).toBeNull();
        const settingsNode = f.document.createElement("div"); f.document.body.append(settingsNode);
        const settings = ReactDOM.createRoot(settingsNode);
        await React.act(async () => { settings.render(f.plugin.getSettingsPanel()); });
        expect(settingsNode.textContent).toContain("0.1.0-canary.15");
        expect(settingsNode.textContent).toContain("Мои шаблоны");
        expect(settingsNode.textContent).toContain("Режим отладки");
        expect(editor.textContent).toBe("draft stays");
        await React.act(async () => { settings.unmount(); f.plugin.stop(); await f.frame(); });
        expect(f.document.querySelectorAll("#vc-stx-host, .stx-bd-button-mount")).toHaveLength(0);
        expect(f.document.head.querySelectorAll("style")).toHaveLength(0);
        expect([...f.flux.values()].every(set => set.size === 0)).toBe(true);
        expect(f.changes.size).toBe(0); expect(f.fonts.size).toBe(0);
        expect(f.host.UI.showToast).not.toHaveBeenCalled();
    });
    it("is invisible on unsupported guilds and survives editor replacement without duplicate buttons", async () => {
        const f = fixture();
        await React.act(async () => { await f.plugin.start(); await f.frame(); });
        const editor = f.document.querySelector('[data-slate-editor="true"]'); editor.focus();
        await React.act(async () => { f.channel("999"); await f.frame(); });
        expect(f.document.querySelectorAll('[data-stx="button"]')).toHaveLength(0);
        expect(f.key().defaultPrevented).toBe(false);
        await React.act(async () => { f.channel("530693013622489088"); await f.frame(); });
        const area = f.document.querySelector('[class*="channelTextArea"]');
        await React.act(async () => { area.replaceWith(area.cloneNode(true)); await f.frame(); await f.frame(); });
        expect(f.document.querySelectorAll(".stx-bd-button-mount")).toHaveLength(1);
        expect(f.document.querySelectorAll("#vc-stx-host")).toHaveLength(1);
    });
    it("stop before deferred storage finishes never mounts late; repeated start has one lifecycle", async () => {
        const f = fixture({ delayedRead: true });
        let first: Promise<void>;
        await React.act(async () => { first = f.plugin.start(); await Promise.resolve(); await Promise.resolve(); });
        await React.act(async () => { f.plugin.stop(); f.resolveRead(undefined); await first!; await f.frame(); });
        expect(f.document.getElementById("vc-stx-host")).toBeNull();
        await React.act(async () => { await Promise.all([f.plugin.start(), f.plugin.start()]); await f.frame(); });
        expect(f.document.querySelectorAll("#vc-stx-host")).toHaveLength(1);
        expect(f.document.querySelectorAll('[data-stx="button"]')).toHaveLength(1);
        expect(f.flux.get("CHANNEL_SELECT")?.size).toBe(2); // shared core + toolbar mounts
    });
    it("fails cleanly before any partial mount when required Discord stores disappear", async () => {
        const f = fixture({ missingStore: true });
        await React.act(async () => { await f.plugin.start(); });
        expect(f.document.getElementById("vc-stx-host")).toBeNull();
        expect(f.flux.size).toBe(0); expect(f.document.head.querySelectorAll("style")).toHaveLength(0);
        expect(f.host.UI.showToast).toHaveBeenCalledOnce();
    });
    it("reports effective cached runtime version and tolerates prototype metadata checks", () => {
        const f = fixture();
        expect(f.Plugin.prototype.getVersion()).toBe("0.1.0-canary.15");
        f.plugin.delegate = { getVersion: () => "0.1.0-canary.16", stopBundledRuntime() {} };
        expect(f.plugin.getVersion()).toBe("0.1.0-canary.16");
    });
    it("inserts through ComponentDispatch only into a focused Slate composer and never sends", () => {
        const f = fixture();
        const { insertTextIntoChatInputBox } = loadAdapter("shims/discord.ts", {}, { document: f.document, BdApi: f.host });
        expect(() => insertTextIntoChatInputBox("reply")).toThrow("No focused chat editor");
        f.document.querySelector('[data-slate-editor="true"]').focus();
        insertTextIntoChatInputBox("reply");
        expect(f.componentDispatch.dispatchToLastSubscribed).toHaveBeenCalledExactlyOnceWith("INSERT_TEXT", { plainText: "reply" });
        const search = f.document.createElement("input"); f.document.body.append(search); search.focus();
        expect(() => insertTextIntoChatInputBox("wrong target")).toThrow("No focused chat editor");
        expect(f.componentDispatch.dispatchToLastSubscribed).toHaveBeenCalledOnce();
    });
    it("packages real UI/core, all host aliases, source/license and no Vencord runtime bridge", () => {
        const evidence = JSON.parse(source("betterdiscord/out/build-evidence.json"));
        for (const file of ["src/vencord/index.tsx", "src/vencord/ui/Window.tsx", "src/vencord/ui/Settings.tsx", "src/vencord/ui/PanelPersonalLibrary.tsx", "src/core/panelClient.ts", "src/core/panelEvents.ts"]) expect(evidence.inputs).toContain(file);
        expect(evidence.inputs).not.toContain("src/vencord/native.ts");
        expect(evidence.inputs).not.toContain("src/vencord/buildInfo.ts");
        expect(evidence.inputs).not.toContain("src/vencord/panelVault.ts");
        expect(bundle).not.toContain("VencordNative");
        expect(bundle).toContain("@version 0.1.0-canary.15");
        expect(evidence.embeddedCssBytes).toBeGreaterThan(10000);
        expect(source("betterdiscord/out/LICENSE")).toContain("GNU GENERAL PUBLIC LICENSE");
        expect(source("betterdiscord/out/source/LICENSE")).toContain("GNU GENERAL PUBLIC LICENSE");
    });
});
