import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as guard from "../src/core/guard";
import * as text from "../src/core/text";
import * as tokens from "../src/core/tokens";
import * as types from "../src/core/types";

// Real adapter/capture/flow regressions. Host APIs, DOM, clipboard and storage are synthetic.
const compiled = new Map<string, string>();
function load(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    if (!compiled.has(file)) compiled.set(file, ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
        fileName: file,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
    }).outputText);
    const module = { exports: {} as any };
    runInNewContext(compiled.get(file)!, {
        module, exports: module.exports, ...globals,
        require: (name: string) => {
            if (!(name in dependencies)) throw new Error("Unmocked dependency: " + name);
            return dependencies[name];
        },
    });
    return module.exports;
}

function harness() {
    const common: Record<string, any> = {
        SelectedGuildStore: { getGuildId: () => types.PROJECTS.mj.guildId },
        SelectedChannelStore: { getChannelId: () => "channel-A" },
        ChannelStore: { getChannel: () => ({ name: "ticket", guild_id: types.PROJECTS.mj.guildId }) },
        GuildStore: { getGuild: () => ({ name: "Guild" }) },
        FluxDispatcher: { subscribe: vi.fn(), unsubscribe: vi.fn() }, showToast: vi.fn(),
    };
    const insert = vi.fn();
    const clipboard = { writeText: vi.fn(async (_text: string) => {}), readText: vi.fn(async () => "browser clip") };
    const native = { clipboard: { read: vi.fn((): unknown => "native clip") } };
    let notice: any;
    const document = {
        activeElement: { closest: () => null }, querySelector: vi.fn((): any => null),
        getElementById: () => notice,
        createElement: () => ({ id: "", textContent: "", style: {}, isConnected: false, setAttribute: vi.fn(), remove: vi.fn(() => { notice = undefined; }) }),
        body: { append: vi.fn((node: any) => { notice = node; node.isConnected = true; }) },
    };
    const timers = { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() };
    const platform = load("../src/vencord/platform.ts", {
        "@api/DataStore": { get: vi.fn(), set: vi.fn() },
        "@utils/discord": { insertTextIntoChatInputBox: insert }, "@webpack/common": common,
    }, { document, navigator: { clipboard }, DiscordNative: native, console: { error: vi.fn() }, ...timers });
    return { common, insert, clipboard, native, document, platform, timers, notice: () => notice };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

// Real plugin module; only dependencies outside this review are inert. start() is never called.
function pluginFor(platform: any, op: any, ui: any) {
    const dependencies: Record<string, unknown> = {
        "./styles.css": {}, "@api/ChatButtons": {},
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@utils/types": { default: (value: unknown) => value, OptionType: { COMPONENT: 1, BOOLEAN: 2 } },
        "@webpack/common": {}, "./core/guard": guard, "./core/keys": {}, "./core/rank": {},
        "./platform": platform, "./ui/op": op, "./ui/uiState": { ui },
    };
    const lifecycle = { resetMenuGuards: vi.fn(), setDebugEnabled: vi.fn(), disposeDemo: vi.fn(), supersede: vi.fn(), unloadFonts: vi.fn(), resetInline: vi.fn(), disposePanel: vi.fn() };
    for (const name of ["ContextMenu", "debug", "demo", "flow", "fonts", "Host", "icons", "inline", "keylatch", "panel", "ProjectIcon", "Settings", "ticketSound", "Window"]) dependencies[`./ui/${name}`] = lifecycle;
    return load("../src/vencord/index.tsx", dependencies, { document: { removeEventListener: vi.fn() } });
}

describe("Role05 Discord compatibility regressions", () => {
    it.each([
        ["SelectedGuildStore", "currentGuildId"], ["SelectedChannelStore", "currentChannel"],
        ["ChannelStore", "currentChannel"], ["GuildStore", "guildName"], ["FluxDispatcher", "onChannelChange"],
    ])("absent %s safely disables %s", (name, method) => {
        const h = harness(); h.common[name] = undefined;
        const result = h.platform[method](() => {});
        if (method === "currentGuildId") expect(result).toBeNull();
        if (method === "guildName") expect(result).toBe("");
        if (method === "currentChannel") {
            expect(result).toEqual({ id: null, name: "", guildId: null });
            expect(h.platform.currentGuildId()).toBeNull();
        }
        if (method === "onChannelChange") { expect(() => result()).not.toThrow(); expect(h.platform.currentGuildId()).toBeNull(); }
    });

    it("renamed store method disables scope and missing toast reports without clipboard", () => {
        const h = harness(); h.common.SelectedGuildStore = {};
        expect(h.platform.currentGuildId()).toBeNull();
        h.common.showToast = undefined;
        expect(() => h.platform.toast("Compatibility failure")).not.toThrow();
        expect(h.notice().textContent).toBe("Compatibility failure");
        expect(h.notice().setAttribute).toHaveBeenCalledWith("role", "status");
        h.platform.toast("Retry");
        expect(h.document.body.append).toHaveBeenCalledOnce();
        expect(h.notice().textContent).toBe("Retry");
        expect(h.clipboard.writeText).not.toHaveBeenCalled();
    });

    it("contains throwing lazy proxy lookups, deduplicates notices and retries recovered stores", () => {
        const h = harness(); const saved = h.common.ChannelStore;
        h.common.ChannelStore = new Proxy({}, { get() { throw new Error("lookup failed"); } });
        expect(h.platform.currentGuildId()).toBeNull();
        expect(h.platform.currentGuildId()).toBeNull();
        expect(h.common.showToast).toHaveBeenCalledOnce();
        h.common.ChannelStore = saved;
        expect(h.platform.currentGuildId()).toBe(types.PROJECTS.mj.guildId);
    });

    it("plugin.stop disposes the actual fallback DOM/timer and resets capability notices", () => {
        const h = harness(); h.common.SelectedGuildStore = undefined; h.common.showToast = undefined;
        expect(h.platform.currentGuildId()).toBeNull();
        const notice = h.notice();
        expect(notice).toBeDefined();
        const plugin = pluginFor(h.platform, { nextGeneration: vi.fn(), clearTargets: vi.fn() }, { set: vi.fn() });
        plugin.default.stop();
        expect(h.timers.clearTimeout).toHaveBeenLastCalledWith(1);
        expect(notice.remove).toHaveBeenCalledOnce();
        expect(h.notice()).toBeUndefined();
        h.platform.disposePlatformNotices();
        expect(notice.remove).toHaveBeenCalledOnce();
        h.platform.currentGuildId();
        expect(h.document.body.append).toHaveBeenCalledTimes(2);
    });

    it.each(["resolve", "reject"])("late clipboard %s cannot recreate a disposed notice", async outcome => {
        const h = harness(); h.common.showToast = undefined;
        h.insert.mockImplementationOnce(() => { throw new Error("insert unavailable"); });
        let done!: () => void;
        h.clipboard.writeText.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
            done = outcome === "resolve" ? resolve : () => reject(new Error("denied"));
        }));
        h.platform.insertText("Prepared reply"); await settle();
        h.platform.disposePlatformNotices(); done(); await settle();
        expect(h.notice()).toBeUndefined();
        expect(h.document.body.append).toHaveBeenCalledOnce();
        expect(h.timers.setTimeout).toHaveBeenCalledOnce();
    });

    it("degrades optional diagnostic stores to null", () => {
        expect(harness().platform.discordEnv()).toEqual({ zoom: null, fontSize: null, locale: null, theme: null });
    });

    it("falls back to browser clipboard after a changed native return type or native throw", async () => {
        const h = harness();
        h.native.clipboard.read.mockReturnValueOnce({ text: "not a string" });
        expect(await h.platform.readClipboard()).toBe("browser clip");
        h.native.clipboard.read.mockImplementationOnce(() => { throw new Error("bridge unavailable"); });
        expect(await h.platform.readClipboard()).toBe("browser clip");
        h.native.clipboard.read.mockImplementationOnce(() => { throw new Error("bridge unavailable"); });
        h.clipboard.readText.mockRejectedValueOnce(new Error("denied"));
        expect(await h.platform.readClipboard()).toBeNull();
    });

    it("reports insertion failure immediately and reports copy only after resolution", async () => {
        const h = harness(); h.insert.mockImplementationOnce(() => { throw new Error("missing dispatch"); });
        let done!: () => void;
        h.clipboard.writeText.mockImplementationOnce(() => new Promise<void>(resolve => { done = resolve; }));
        expect(h.platform.insertText("Prepared reply")).toBe(false);
        expect(h.common.showToast).toHaveBeenCalledOnce();
        expect(h.common.showToast.mock.calls[0][0].text).not.toContain("текст скопирован");
        await settle();
        expect(h.clipboard.writeText).toHaveBeenCalledExactlyOnceWith("Prepared reply");
        expect(h.common.showToast).toHaveBeenCalledOnce();
        done(); await settle();
        expect(h.common.showToast.mock.calls[1][0].text).toContain("текст скопирован");
    });

    it.each(["sync", "async", "missing", "getter"])("contains %s clipboard failure even without Discord toast", async mode => {
        const h = harness(); h.insert.mockImplementationOnce(() => { throw new Error("missing dispatch"); });
        if (mode === "sync") h.clipboard.writeText.mockImplementationOnce(() => { throw new Error("bridge refused synchronously"); });
        if (mode === "async") h.clipboard.writeText.mockRejectedValueOnce(new Error("denied"));
        if (mode === "missing") Object.assign(h.clipboard, { writeText: undefined });
        if (mode === "getter") Object.defineProperty(h.clipboard, "writeText", { get() { throw new Error("bridge gone"); } });
        h.common.showToast = undefined;
        expect(h.platform.insertText("Prepared reply")).toBe(false);
        expect(h.notice().textContent).toContain("Не удалось вставить");
        await settle();
        expect(h.notice().textContent).toContain("Не удалось вставить и скопировать");
        expect(h.insert).toHaveBeenCalledOnce();
    });

    it.each(["missing", "detached", "sidebar", "keyboard"])("%s target uses the real toggle/capture/flow without a sidebar fallback", async mode => {
        const h = harness();
        const mainEditor = { isConnected: true, textContent: "Main draft", focus: vi.fn() };
        h.document.querySelector.mockReturnValue(mainEditor);
        const { createObservable } = load("../src/vencord/ui/observable.ts", { "@webpack/common": {} });
        const ui = createObservable({ windowOpen: false, compose: [], dialog: null, menu: null, management: false });
        const op = load("../src/vencord/ui/op.ts", { "../platform": h.platform, "./uiState": { ui } }, {
            window: { getSelection: () => "" },
        });
        const plugin = pluginFor(h.platform, op, ui);
        const sidebarEditor = { isConnected: mode !== "detached", textContent: "Sidebar draft", focus: vi.fn() };
        // A sidebar button whose renamed ancestor no longer matches channelTextArea.
        const sidebarButton = { closest: vi.fn(() => mode === "missing" ? null : { querySelector: () => sidebarEditor }) };
        const allowed = mode === "sidebar" || mode === "keyboard";
        if (mode === "keyboard") plugin.toggleWindow();
        else plugin.toggleWindow(undefined, op.editorNear(sidebarButton));
        expect(ui.get().windowOpen).toBe(allowed);
        if (!allowed) {
            expect(op.windowEditor()).toBeNull();
            expect(h.document.querySelector).not.toHaveBeenCalled();
            expect(mainEditor.focus).not.toHaveBeenCalled();
            expect(h.insert).not.toHaveBeenCalled();
            expect(h.common.showToast).toHaveBeenCalledOnce();
            return; // No window/action is published from an uncertain button target.
        }
        expect(op.targetNow().editor).toBe(mode === "sidebar" ? sidebarEditor : mainEditor);
        const template: types.Template = {
            id: "t", title: "Answer", text: "Prepared reply", project: "mj", source: "faq", status: "actual",
            category: null, statusNote: null, teamUses: 0, command: null, color: null, updatedAt: null,
        };
        const store = { setVersion: 1, byId: () => template, templates: [template], markUsed: vi.fn() };
        const flow = load("../src/vencord/ui/flow.ts", {
            "../core/guard": guard, "../core/text": text, "../core/tokens": tokens, "../core/types": types,
            "../platform": h.platform, "./op": op, "./debug": { debugEnabled: () => false, dlog: vi.fn() },
            "./uiState": { ui, store, activeScope: () => "mj", currentMode: () => "mj", libraryIsFresh: () => true },
        }, { document: h.document });
        const inserting = flow.insertTemplate(template);
        // Closing the picker releases its global reference immediately; the real
        // async flow must still use the target it captured before that cleanup.
        expect(ui.get().windowOpen).toBe(false);
        expect(op.windowEditor()).toBeNull();
        await inserting;
        expect((mode === "sidebar" ? sidebarEditor : mainEditor).focus).toHaveBeenCalledOnce();
        if (mode === "sidebar") expect(mainEditor.focus).not.toHaveBeenCalled();
        expect(h.insert).toHaveBeenCalledExactlyOnceWith("Prepared reply");
        expect(store.markUsed).toHaveBeenCalledExactlyOnceWith("t");
    });

    it("channel subscription failures are retryable and cleanup failures leave callbacks inert", () => {
        const h = harness(); const fn = vi.fn(); const dispatcher = h.common.FluxDispatcher;
        dispatcher.subscribe.mockImplementationOnce(() => { throw new Error("partial subscription"); });
        expect(() => h.platform.onChannelChange(fn)()).not.toThrow();
        dispatcher.subscribe.mock.calls[0][1]({ guildId: "stale" });
        expect(fn).not.toHaveBeenCalled();
        expect(h.platform.currentGuildId()).toBeNull();
        const off = h.platform.onChannelChange(fn);
        expect(h.platform.currentGuildId()).toBe(types.PROJECTS.mj.guildId);
        dispatcher.unsubscribe.mockImplementationOnce(() => { throw new Error("cleanup failed"); });
        expect(off).not.toThrow(); expect(off).not.toThrow();
        dispatcher.subscribe.mock.calls[1][1]({ guildId: "stale" });
        expect(fn).not.toHaveBeenCalled();
    });

    it("channel hooks pair subscription and unsubscription and tolerate an absent event payload", () => {
        const h = harness(); const fn = vi.fn();
        const off = h.platform.onChannelChange(fn);
        const [event, handler] = h.common.FluxDispatcher.subscribe.mock.calls[0];
        expect(event).toBe("CHANNEL_SELECT"); handler(undefined);
        expect(fn).toHaveBeenCalledExactlyOnceWith(null);
        off(); expect(h.common.FluxDispatcher.unsubscribe).toHaveBeenCalledExactlyOnceWith(event, handler);
    });
});
