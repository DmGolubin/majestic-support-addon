import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/core/state";
import { routeStore } from "../src/core/storeRouter";

// Execute the real adapter modules without copying into Vencord or loading Discord.
const compile = (file: string) => ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const demoCode = compile("../src/vencord/ui/demo.ts");
const pluginCode = compile("../src/vencord/index.tsx");
const loginCode = compile("../src/vencord/ui/LoginWindow.tsx");
const observable = <T extends object>(initial: T) => {
    let value = initial;
    return { get: () => value, set: (patch: Partial<T>) => { value = { ...value, ...patch }; } };
};
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
};
const draft = { title: "Personal", text: "Private draft", project: "mj" as const, color: null, command: null, folderId: null };

async function harness() {
    const write = vi.fn(async () => {});
    const real = new Store({ get: async () => undefined, set: write });
    real.importText("## Majestic RP\n### Local\nPreserve local text");
    await real.savePersonal({ ...draft, title: "Local personal" });
    real.setPrefix("!");
    await real.flush();
    const localBefore = structuredClone(real.data);
    const writesBefore = write.mock.calls.length;
    const router = routeStore(real);
    const ui = observable<Record<string, unknown>>({ management: false, windowOpen: false, dialog: null, compose: [], inline: null, menu: null });
    const access = observable({ enabled: false, ready: false });
    let generation = 0;
    const op = {
        nextGeneration: () => ++generation, generationNow: () => generation,
        clearTargets: vi.fn(), captureWindowTarget: vi.fn(), editorNear: vi.fn(),
    };
    const server = { phase: "ready", revision: 1, raw: "## Majestic RP\n### FAQ\nDemo answer" };
    const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith("/requests")
        ? { id: "mock-session", device: "mock-device", code: "mock-code", url: "http://127.0.0.1:47833/#mock" }
        : { ...server } }));
    const common = {
        setTimeout, clearTimeout, AbortController, console, structuredClone,
        window: { open: vi.fn() }, fetch,
    };
    const evaluate = (code: string, dependencies: Record<string, unknown>, extra: object = {}) => {
        const module = { exports: {} as any };
        runInNewContext(code, {
            ...common, ...extra, module, exports: module.exports,
            require: (name: string) => {
                if (!(name in dependencies)) throw new Error("Unmocked dependency: " + name);
                return dependencies[name];
            },
        });
        return module.exports;
    };
    const flow = { confirmedForeign: new Set<string>(), supersede: vi.fn(), insertTemplate: vi.fn() };
    const state = {
        demoAccess: access, realStore: real, store: router.store, selectStore: router.select, ui,
        activeScope: vi.fn(), pluginOn: vi.fn(), poolFor: vi.fn(), useTechProject: vi.fn(),
    };
    const demo = evaluate(demoCode, {
        "../core/state": { Store }, "../platform": { toast: vi.fn() },
        "./flow": flow, "./observable": { createObservable: observable }, "./op": op, "./uiState": state,
    });
    const mount = vi.fn();
    const unmount = vi.fn();
    const append = vi.fn();
    const addEventListener = vi.fn();
    const document = { addEventListener, removeEventListener: vi.fn(), createElement: () => ({ id: "", remove: vi.fn() }), body: { append } };
    const noops = (names: string[]) => Object.fromEntries(names.map(name => [name, vi.fn(() => 0)]));
    const pluginModule = evaluate(pluginCode, {
        "./styles.css": {}, "@api/ChatButtons": {},
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@utils/types": { default: (value: unknown) => value, OptionType: { COMPONENT: 1, BOOLEAN: 2 } },
        "@webpack/common": { createRoot: () => ({ render: mount, unmount }) },
        "./core/guard": { serverMode: vi.fn() }, "./core/keys": { comboOf: vi.fn() }, "./core/rank": { favoritesOf: vi.fn() },
        "./platform": { currentGuildId: vi.fn(), currentChannel: vi.fn(), toast: vi.fn(), onChannelChange: () => vi.fn() },
        "./ui/ContextMenu": { resetMenuGuards: vi.fn() },
        "./ui/debug": noops(["costEnd", "costStart", "debugEnabled", "dlog", "keyDesc", "noteKey", "setDebugEnabled", "setDebugVerbose", "setLoadTime"]),
        "./ui/demo": demo, "./ui/flow": flow, "./ui/fonts": noops(["loadFonts", "unloadFonts"]),
        "./ui/Host": { Host: () => null }, "./ui/icons": { MJ_ICON: "" },
        "./ui/inline": { startInline: () => vi.fn(), resetInline: vi.fn(), handleInlineKey: vi.fn() },
        "./ui/keylatch": { startLatch: () => vi.fn(), latchKey: vi.fn(), swallowLatched: vi.fn() },
        "./ui/op": op, "./ui/panel": { startPanel: () => vi.fn(), disposePanel: vi.fn() }, "./ui/ProjectIcon": {}, "./ui/Settings": {},
        "./ui/ticketSound": { startTicketSound: () => vi.fn() }, "./ui/uiState": state, "./ui/Window": {},
    }, { document, performance: { now: () => 0 }, React: { createElement: () => ({}) } });
    const plugin = pluginModule.default;
    const mountLogin = () => {
        const login = evaluate(loginCode, {
            "@webpack/common": { useRef: () => ({ current: { focus() {}, contains: (target: any) => target.inside === true } }), useEffect: (effect: () => void) => effect() },
            "./demo": { ...demo, demo: { use: () => ({ enabled: false }) } },
            "./op": op, "./panel": { panel: { use: () => ({ enabled: true, phase: "idle" }) } },
            "./PanelConnection": {}, "./uiState": { ui, useChatRect: () => null },
        }, { document, innerWidth: 1280, innerHeight: 720, React: { createElement: () => ({}) } });
        login.LoginWindow();
        return addEventListener.mock.calls.find(([event]) => event === "mousedown")![1] as (event: unknown) => void;
    };
    const connect = async () => {
        await demo.connectDemo();
        await vi.advanceTimersByTimeAsync(700);
        expect(demo.demo.get().phase).toBe("ready");
    };
    const seedSession = async () => {
        demo.enableDemo();
        await connect();
        await router.store.savePersonal(draft);
        await router.store.saveFolder("Session folder");
        const id = router.store.templates[0].id;
        router.store.toggleFavorite(id);
        router.store.markUsed(id);
        router.store.setBind(id, "Ctrl+Alt+KeyF");
        router.store.setPrefix("?");
        router.store.setTechProject("ro");
        await router.store.flush();
        ui.set({ management: true, windowOpen: true, compose: [id], dialog: { kind: "fields" }, inline: {}, menu: {} });
    };
    const expectCleared = (previewOpen = false) => {
        expect(router.store.templates).toEqual([]);
        expect(router.store.data).toMatchObject({ raw: "", personal: [], folders: [], favorites: [], recent: [], usage: {}, binds: {}, intentional: [], prefix: "?", techProject: "ro", previewOpen });
        expect(access.get().ready).toBe(false);
        expect(demo.demo.get()).toMatchObject({ revision: 0, code: "", url: "" });
        expect(ui.get()).toMatchObject({ management: false, dialog: null, compose: [], inline: null, menu: null });
    };
    const expectLocalUntouched = () => {
        expect(real.data).toEqual(localBefore);
        expect(write).toHaveBeenCalledTimes(writesBefore);
    };
    return { demo, plugin, toggleWindow: pluginModule.toggleWindow, mountLogin, real, router, ui, access, server, fetch, mount, append, addEventListener, op, connect, seedSession, expectCleared, expectLocalUntouched };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("demo session and plugin lifecycle", () => {
    it("closes login on the second icon click without reopening after outside mousedown", async () => {
        const h = await harness();
        h.toggleWindow();
        const onDown = h.mountLogin();
        // The nested icon resolves its owning chat button, as Element.closest does in Discord.
        onDown({ target: { closest: (selector: string) => selector === "[data-stx=button]" ? {} : null } });
        h.toggleWindow();
        expect(h.ui.get().windowOpen).toBe(false);
        h.toggleWindow();
        expect(h.ui.get().windowOpen).toBe(true);
        onDown({ target: { inside: true, closest: () => null } });
        expect(h.ui.get().windowOpen).toBe(true);
        onDown({ target: { closest: () => null } });
        expect(h.ui.get().windowOpen).toBe(false);
    });
    it.each(["template", "folder"])("cannot republish a pending %s into a retired demo session", async kind => {
        const h = await harness();
        h.demo.enableDemo();
        const saving = kind === "template"
            ? h.router.store.savePersonal(draft, undefined, "personal:retired")
            : h.router.store.saveFolder("Retired folder", undefined, "folder:retired");
        h.demo.disposeDemo();
        await saving;
        expect(h.router.store.data.personal).toEqual([]);
        expect(h.router.store.data.folders).toEqual([]);
        expect(h.router.store.templates).toEqual([]);
        h.expectLocalUntouched();
    });
    it.each(["revoked", "expired", "denied"])("clears records and management on %s, then reconnects cleanly", async phase => {
        const h = await harness();
        await h.seedSession();
        h.router.store.setPreviewOpen(true);
        h.server.phase = phase;
        await vi.advanceTimersByTimeAsync(2000);
        h.expectCleared(true);
        expect(h.demo.demo.get().phase).toBe(phase);
        expect(h.ui.get().windowOpen).toBe(false);
        const requests = h.fetch.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10000);
        expect(h.fetch).toHaveBeenCalledTimes(requests);
        h.server.phase = "ready";
        await h.connect();
        expect(h.router.store.templates).toHaveLength(1);
        expect(h.router.store.data.personal).toEqual([]);
        expect(h.router.store.data).toMatchObject({ prefix: "?", techProject: "ro", previewOpen: true });
        h.expectLocalUntouched();
    });

    it("clears the previous library before a new login completes", async () => {
        const h = await harness();
        await h.seedSession();
        h.server.phase = "pending";
        const authorization = deferred<any>();
        h.fetch.mockImplementationOnce(() => authorization.promise);
        const connecting = h.demo.connectDemo();
        h.expectCleared();
        authorization.resolve({ ok: true, json: async () => ({ id: "next-session", device: "next-device", code: "next-code", url: "http://127.0.0.1:47833/#next" }) });
        await connecting;
        expect(h.demo.demo.get()).toMatchObject({ phase: "pending", code: "next-code", revision: 0 });
        expect(h.router.store.templates).toEqual([]);
        expect(h.router.store.data.personal).toEqual([]);
        h.expectLocalUntouched();
    });

    it("cancels login, clears drafts and ignores a late successful response", async () => {
        const h = await harness();
        await h.seedSession();
        const late = deferred<any>();
        h.fetch.mockImplementationOnce(() => late.promise);
        await vi.advanceTimersByTimeAsync(2000);
        h.demo.cancelDemoLogin();
        h.expectCleared();
        late.resolve({ ok: true, json: async () => ({ ...h.server }) });
        await vi.advanceTimersByTimeAsync(10000);
        h.expectCleared();
        expect(h.demo.demo.get().phase).toBe("idle");
        h.expectLocalUntouched();
    });

    it("retains session records and preferences through a transient outage", async () => {
        const h = await harness();
        await h.seedSession();
        const before = structuredClone(h.router.store.data);
        h.fetch.mockRejectedValueOnce(new Error("mock offline"));
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.demo.demo.get().phase).toBe("offline");
        expect(h.access.get().ready).toBe(false);
        expect(h.router.store.data).toEqual(before);
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.access.get().ready).toBe(true);
        expect(h.router.store.data).toEqual(before);
        h.expectLocalUntouched();
    });

    it("teardown keeps demo locked; only explicit exit selects the preserved local library", async () => {
        const h = await harness();
        await h.seedSession();
        h.plugin.stop();
        h.expectCleared();
        expect(h.demo.demo.get()).toMatchObject({ enabled: true, localMode: false, phase: "idle" });
        await h.plugin.start();
        expect(h.demo.demo.get().localMode).toBe(false);
        expect(h.router.store.templates).toEqual([]);
        h.demo.disableDemo();
        expect(h.demo.demo.get()).toMatchObject({ enabled: false, localMode: true });
        expect(h.router.store.data).toBe(h.real.data);
        h.plugin.stop();
        expect(h.demo.demo.get().localMode).toBe(true);
        h.expectLocalUntouched();
    });

    it("session changes during storage load do not cancel startup", async () => {
        const h = await harness();
        const load = deferred<void>();
        vi.spyOn(h.real, "load").mockReturnValue(load.promise);
        const start = h.plugin.start();
        h.demo.enableDemo();
        await h.connect(); // Catalog invalidation also changes the operation generation.
        load.resolve();
        await start;
        expect(h.mount).toHaveBeenCalledTimes(1);
        expect(h.addEventListener).toHaveBeenCalledWith("keydown", expect.any(Function), true);
        h.plugin.stop();
    });

    it("stop during storage load still prevents a late mount and preserves initial mode", async () => {
        const h = await harness();
        const load = deferred<void>();
        vi.spyOn(h.real, "load").mockReturnValue(load.promise);
        const start = h.plugin.start();
        h.plugin.stop();
        load.resolve();
        await start;
        expect(h.mount).not.toHaveBeenCalled();
        expect(h.append).not.toHaveBeenCalled();
        expect(h.demo.demo.get()).toMatchObject({ enabled: false, localMode: false });
        h.expectLocalUntouched();
    });

    it("only the latest start mounts after stop/restart with overlapping loads", async () => {
        const h = await harness();
        const oldLoad = deferred<void>();
        const newLoad = deferred<void>();
        vi.spyOn(h.real, "load").mockReturnValueOnce(oldLoad.promise).mockReturnValueOnce(newLoad.promise);
        const oldStart = h.plugin.start();
        h.plugin.stop();
        const newStart = h.plugin.start();
        newLoad.resolve();
        await newStart;
        oldLoad.resolve();
        await oldStart;
        expect(h.mount).toHaveBeenCalledTimes(1);
        h.plugin.stop();
    });
});
