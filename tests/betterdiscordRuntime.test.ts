import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, webcrypto } from "node:crypto";
import { bdRequire, evaluate, loadAdapter, root, source } from "./betterdiscordHarness";

const { JSDOM } = bdRequire("jsdom");
const React = bdRequire("react");
const ReactDOM = bdRequire("react-dom/client");
const distributionVersion = JSON.parse(source("distribution/config.json")).version;
let bundle: string;
beforeAll(() => {
    execFileSync(process.execPath, ["betterdiscord/build.mjs"], { cwd: root, stdio: "pipe" });
    bundle = source("betterdiscord/out/SupportTemplates.plugin.js");
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllGlobals(); });

function fixture({ delayedRead = false, missingStore = false, restrictedHost = false, supportedBridge = false, signedIn = false } = {}) {
    const dom = new JSDOM('<!doctype html><body><main><div class="channelTextArea_test"><div class="buttons_test"></div><div contenteditable="true" role="textbox" tabindex="0" data-slate-editor="true">draft stays</div></div></main></body>', { url: "https://discord.com/channels/test", pretendToBeVisual: true });
    const w = dom.window;
    w.HTMLElement.prototype.scrollIntoView = () => {}; // Layout/scrolling is not implemented by JSDOM.
    // ReactDOM was imported before this per-test window, so its input detection
    // takes the legacy branch. Bridge that branch to JSDOM's real event listeners.
    w.HTMLElement.prototype.attachEvent = function (name: string, handler: any) { this.addEventListener(name.replace(/^on/, ""), handler); };
    w.HTMLElement.prototype.detachEvent = function (name: string, handler: any) { this.removeEventListener(name.replace(/^on/, ""), handler); };
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
        UserStore: { getCurrentUser: () => signedIn ? { id: "123456789012345678" } : null, addChangeListener: (fn: any) => changes.add(fn), removeChangeListener: (fn: any) => changes.delete(fn) },
        AccessibilityStore: {}, LocaleStore: {}, ThemeStore: {}
    };
    const componentDispatch = { subscribe() {}, dispatchToLastSubscribed: vi.fn() };
    const editor = w.document.querySelector('[data-slate-editor="true"]');
    const slate = { children: [{ children: [{ text: editor.textContent }] }], operations: [] as any[] };
    const composer = {
        props: { disabled: false }, getSlateEditor: () => slate,
        ref: { current: { focus: () => editor.focus() } },
        handleInsertText: vi.fn((payload: any) => {
            slate.children[0].children[0].text += payload.rawText;
            slate.operations.push({ type: "insert_text", text: payload.rawText });
            editor.textContent = slate.children[0].children[0].text;
        })
    };
    const data = new Map();
    let resolveRead!: (value: any) => void;
    let delay = delayedRead;
    const wait = new Promise(resolve => { resolveRead = resolve; });
    const styleNodes = new Map();
    const host: any = {
        React, ReactDOM,
        ReactUtils: { getInternalInstance: (node: any) => node === editor ? { stateNode: editor, return: { stateNode: composer } } : null },
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
        if (supportedBridge) {
            globals.crypto = webcrypto;
            globals.indexedDB = new (bdRequire("fake-indexeddb").IDBFactory)();
            const dir = fs.mkdtempSync(join(tmpdir(), "stx-bd-runtime-"));
            host.Plugins.folder = join(dir, "plugins"); fs.mkdirSync(host.Plugins.folder);
            modules.fs = Object.fromEntries(["readFileSync", "writeFileSync", "mkdirSync", "statSync", "realpathSync", "renameSync", "unlinkSync", "existsSync"].map(k => [k, (...args: any[]) => {
                try { return (fs as any)[k](...args); } catch (error) { throw new Error((error as Error).message); }
            }]));
            modules.fs.lstatSync = modules.fs.statSync; // BD aliases lstat to stat and drops Error.code.
            host.Net = { fetch: vi.fn(async () => new Response("Private", { status: 404 })) };
            Object.defineProperty(globals.navigator, "locks", { value: { request: async (_name: any, _options: any, fn: any) => fn({}) } });
            cleanups.push(async () => { await React.act(async () => { plugin.stop(); await plugin.retiring; }); fs.rmSync(dir, { recursive: true, force: true }); });
        }
        globals.require = (name: string) => {
            if (name in modules) return modules[name];
            if (supportedBridge && name.startsWith(join(host.Plugins.folder, "..", "SupportTemplates") + "\\") && name.endsWith(".plugin.js"))
                return evaluate(fs.readFileSync(name, "utf8"), {}, globals);
            deniedModules.push(name);
            throw new Error(`ENOENT: no such file or directory, lstat 'Discord/${name}'`);
        };
    }
    const Plugin = evaluate(bundle, { electron: { clipboard: { writeText: vi.fn() } }, "@electron/remote": {} }, globals);
    const plugin = new Plugin();
    const frame = () => new Promise(resolve => w.requestAnimationFrame(() => resolve(undefined)));
    cleanups.push(async () => { await React.act(async () => { plugin.stop(); resolveRead(undefined); await frame(); }); w.close(); });
    return { plugin, Plugin, host, globals, componentDispatch, composer, slate, flux, changes, fonts, document: w.document, w, frame, resolveRead, data, deniedModules,
        channel: (guild: string) => { channel = { ...channel, guild_id: guild }; dispatcher.dispatch({ type: "CHANNEL_SELECT", guildId: guild }); },
        key: () => { const event = new w.KeyboardEvent("keydown", { code: "KeyT", key: "t", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }); w.document.activeElement.dispatchEvent(event); return event; } };
}

describe("BetterDiscord final bundle in React/DOM", () => {
    it("continues stop through a throwing toolbar cleanup and settings listener", async () => {
        const f = fixture();
        await React.act(async () => { await f.plugin.start(); await f.frame(); });
        const off = f.plugin.offButtons;
        f.plugin.offButtons = () => { off(); throw Error('toolbar teardown failure'); };
        const updated = vi.fn();
        f.plugin.settingsListeners.add(() => { throw Error('settings listener failure'); });
        f.plugin.settingsListeners.add(updated);
        const updaterStop = vi.fn(); f.plugin.updater = { stop: updaterStop };
        await React.act(async () => { f.plugin.stop(); await f.plugin.retiring; });
        expect(f.document.getElementById('vc-stx-host')).toBeNull();
        expect(f.document.querySelector('.stx-bd-button-mount')).toBeNull();
        expect(f.document.head.querySelector('style')).toBeNull();
        expect([...f.flux.values()].reduce((n, set) => n + set.size, 0)).toBe(0);
        expect(f.changes.size).toBe(0);
        expect(updaterStop).toHaveBeenCalledOnce(); expect(updated).toHaveBeenCalled();
        f.plugin.settingsListeners.clear();
    });
    it("rolls back style setup that throws after adding its DOM node", async () => {
        const f = fixture(); const add = f.host.DOM.addStyle;
        f.host.DOM.addStyle = (...args: any[]) => { add(...args); throw Error('style setup failure'); };
        await React.act(async () => { await f.plugin.start(); await f.frame(); });
        expect(f.document.head.querySelector('style')).toBeNull();
        expect(f.document.getElementById('vc-stx-host')).toBeNull();
        expect(f.plugin.runtimeActive).toBe(false);
    });
    it("restores encrypted login, loads FAQ and inserts a clicked template into the captured composer", async () => {
        const f = fixture({ restrictedHost: true, supportedBridge: true, signedIn: true });
        const accountId = "123456789012345678", connectionId = "11111111-1111-4111-8111-111111111111";
        const origin = "https://discord.com", panelOrigin = "https://panel.majestic-rp.tech";
        const plugins = fs.realpathSync(f.host.Plugins.folder);
        const id = createHash("sha256").update(JSON.stringify([plugins.toLowerCase(), origin])).digest("hex");
        const { createBrowserVaultSession } = loadAdapter("native/browserVault.ts");
        const saved = await createBrowserVaultSession({ root: join(plugins, "..", "SupportTemplates", id), origin, platform: "win32",
            crypto: webcrypto, indexedDB: f.globals.indexedDB, locks: f.globals.navigator.locks });
        const scopes = ["profile:read", "faq:read", "personal:read", "folders:read", "sync:read"];
        await saved.forAccount(accountId).save({ version: 1, state: "ready", accountId, origin: panelOrigin, clientId: "support-templates", expiresAt: Date.now() + 900000,
            tokens: { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 900, connectionId, scopes } });
        await saved.close();
        const serverTime = new Date().toISOString();
        f.host.Net.fetch.mockImplementation(async (url: string) => {
            if (url === panelOrigin + "/api/plugin/v1/me") return Response.json({ schemaVersion: 1, accountId, connectionId, name: "Fixture", projects: ["majestic"], scopes,
                permissionsRevision: "1", minimumPluginVersion: "1.0.0", serverTime });
            if (url === panelOrigin + "/api/plugin/v1/snapshot") return Response.json({ schemaVersion: 1, accountId, projects: ["majestic"], permissionsRevision: "1", revision: "1", serverTime,
                faq: [{ id: "majestic:1", version: "1", title: "Version fixture FAQ", text: "Fixture answer", format: "text", projects: ["majestic"], category: "Fixture", tags: [], status: "actual", updatedAt: serverTime }],
                personal: [], folders: [], trash: [], colorLabels: {}, limits: { colors: [] } });
            return new Response("Unavailable", { status: 404 });
        });
        await React.act(async () => { await f.plugin.start(); await f.frame(); });
        await React.act(async () => { f.document.querySelector('[data-stx="button"]').click(); await f.frame(); });
        await vi.waitFor(async () => {
            // Flush each frame separately: holding one act() open while polling
            // prevents React from committing a late IndexedDB/network completion.
            await React.act(async () => { await f.frame(); });
            expect(f.document.body.textContent).toContain("Version fixture FAQ");
        }, { timeout: 5000 });
        expect(f.document.body.textContent).not.toContain("нужна новая версия");
        expect(f.host.Net.fetch.mock.calls.some(([url]: [string]) => url.includes("oauth/"))).toBe(false);
        expect(f.deniedModules).toEqual([]);
        const editor = f.document.querySelector('[data-slate-editor="true"]');
        // The global event dispatcher deliberately does nothing. The bundle must
        // target the captured editor's owner and observe its model change.
        expect(f.document.activeElement).not.toBe(editor);
        await React.act(async () => { f.document.querySelector('.vc-stx-it').click(); await f.frame(); });
        expect(editor.textContent).toBe("draft staysFixture answer");
        expect(f.slate.children[0].children[0].text).toBe("draft staysFixture answer");
        expect(f.composer.handleInsertText).toHaveBeenCalledExactlyOnceWith({ rawText: "Fixture answer", plainText: "Fixture answer", addSpace: false });
        expect(f.componentDispatch.dispatchToLastSubscribed).not.toHaveBeenCalled();
    });
    it("downloads without evaluating, then loads the verified runtime through BD's absolute-path loader on next startup", async () => {
        const f = fixture({ restrictedHost: true, supportedBridge: true });
        const config = JSON.parse(source("distribution/config.json"));
        const version = `${BigInt(config.version.split(".")[0]) + 1n}.0.0${config.channel === "canary" ? "-canary.1" : ""}`;
        const code = `module.exports=class { getVersion(){return '${version}';} startBundledRuntime(){globalThis.BdApi.testStarts++;} stopBundledRuntime(){} getSettingsPanel(){} getBundledSettings(){} };`;
        const asset = { variant: "betterdiscord", platform: "win32", kind: "renderer", name: "SupportTemplates.plugin.js", size: Buffer.byteLength(code), sha256: createHash("sha256").update(code).digest("hex") };
        const manifest = { schema: 1, product: "SupportTemplates", repository: config.releaseRepository, channel: config.channel, version, assets: [asset] };
        const url = (name: string) => `https://github.com/${config.releaseRepository}/releases/download/v${version}/${name}`;
        const release = { draft: false, prerelease: config.channel === "canary", tag_name: `v${version}`, assets: [
            { name: config.manifestAsset, state: "uploaded", size: Buffer.byteLength(JSON.stringify(manifest)), browser_download_url: url(config.manifestAsset) },
            { name: asset.name, state: "uploaded", size: asset.size, browser_download_url: url(asset.name) }
        ] };
        f.host.testStarts = 0;
        f.host.Net.fetch.mockImplementation(async (input: string) => new Response(input.startsWith("https://api.github.com/") ? JSON.stringify([release]) : input === url(config.manifestAsset) ? JSON.stringify(manifest) : code));
        await React.act(async () => { await f.plugin.start(); await f.plugin.updater.check(); });
        expect(f.plugin.getVersion()).toBe(config.version); expect(f.host.testStarts).toBe(0);
        expect(f.document.querySelector('[data-slate-editor="true"]').textContent).toBe("draft stays");
        await React.act(async () => { f.plugin.stop(); await f.plugin.retiring; await f.plugin.start(); });
        expect(f.plugin.getVersion()).toBe(version); expect(f.host.testStarts).toBe(1);
        expect(f.deniedModules).toEqual([]);
    });
    it("starts automatic checks using only the standard BD bridge and keeps the editor intact on GitHub 404", async () => {
        const f = fixture({ restrictedHost: true, supportedBridge: true });
        await React.act(async () => { await f.plugin.start(); await f.plugin.updater.check().catch(() => {}); await f.frame(); });
        expect(f.host.Net.fetch).toHaveBeenCalledOnce();
        expect(f.deniedModules).toEqual([]);
        expect(f.document.querySelector('[data-slate-editor="true"]').textContent).toBe("draft stays");
        expect(f.document.querySelectorAll('[data-stx="button"]')).toHaveLength(1);
    });
    it("loads and opens settings under BetterDiscord's restricted module loader without probing unsupported modules", async () => {
        const f = fixture({ restrictedHost: true });
        await React.act(async () => { await f.plugin.start(); await f.frame(); });
        expect(f.document.querySelectorAll('[data-stx="button"]')).toHaveLength(1);
        const node = f.document.createElement("div"); f.document.body.append(node);
        const settings = ReactDOM.createRoot(node);
        await React.act(async () => { settings.render(f.plugin.getSettingsPanel()); });
        expect(node.textContent).toContain("Логи");
        expect(node.querySelector(".vc-stx-settings-nav, textarea")).toBeNull();
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
        expect(settingsNode.textContent).toContain("SupportTemplates");
        expect(settingsNode.textContent).toContain("Открыть папку логов");
        expect(settingsNode.textContent).not.toContain("Скачать краткий отчёт");
        expect(settingsNode.querySelector(".vc-stx-settings-nav, textarea")).toBeNull();
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
        expect(f.Plugin.prototype.getVersion()).toBe(distributionVersion);
        f.plugin.delegate = { getVersion: () => "1.0.1-canary.99", stopBundledRuntime() {} };
        expect(f.plugin.getVersion()).toBe("1.0.1-canary.99");
    });
    it("inserts through the focused Slate composer's handler and never broadcasts or sends", () => {
        const f = fixture();
        const { insertTextIntoChatInputBox } = loadAdapter("shims/discord.ts", {}, { document: f.document, BdApi: f.host });
        expect(() => insertTextIntoChatInputBox("reply")).toThrow("No focused chat editor");
        f.document.querySelector('[data-slate-editor="true"]').focus();
        insertTextIntoChatInputBox("reply");
        expect(f.composer.handleInsertText).toHaveBeenCalledExactlyOnceWith({ rawText: "reply", plainText: "reply", addSpace: false });
        const search = f.document.createElement("input"); f.document.body.append(search); search.focus();
        expect(() => insertTextIntoChatInputBox("wrong target")).toThrow("No focused chat editor");
        expect(f.composer.handleInsertText).toHaveBeenCalledOnce();
        expect(f.componentDispatch.dispatchToLastSubscribed).not.toHaveBeenCalled();
    });
    it("packages real UI/core, all host aliases, source/license and no Vencord runtime bridge", () => {
        const evidence = JSON.parse(source("betterdiscord/out/build-evidence.json"));
        for (const file of ["src/vencord/index.tsx", "src/vencord/ui/Window.tsx", "src/vencord/ui/Settings.tsx", "src/vencord/ui/PanelPersonalLibrary.tsx", "src/core/panelClient.ts", "src/core/panelEvents.ts"]) expect(evidence.inputs).toContain(file);
        expect(evidence.inputs).not.toContain("src/vencord/native.ts");
        expect(evidence.inputs).not.toContain("src/vencord/buildInfo.ts");
        expect(evidence.inputs).not.toContain("src/vencord/panelVault.ts");
        expect(bundle).not.toContain("VencordNative");
        expect(bundle).toContain(`@version ${distributionVersion}`);
        expect(evidence.embeddedCssBytes).toBeGreaterThan(10000);
        expect(source("betterdiscord/out/LICENSE")).toContain("GNU GENERAL PUBLIC LICENSE");
        expect(source("betterdiscord/out/source/LICENSE")).toContain("GNU GENERAL PUBLIC LICENSE");
    });
});
