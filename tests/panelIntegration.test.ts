import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/core/state";
import { routeStore } from "../src/core/storeRouter";
import { PanelError } from "../src/core/panelClient";
import { Template } from "../src/core/types";

const compiled = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/panel.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
function observable<T extends object>(value: T) {
    return { get: () => value, set: (patch: Partial<T>) => { value = { ...value, ...patch }; } };
}
function deferred<T>() {
    let resolve!: (v: T) => void, reject!: (e: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const template: Template = { id: "faq:majestic:7", source: "faq", project: "mj", title: "FAQ", text: "Answer", category: null,
    status: "actual", statusNote: null, color: null, command: null, updatedAt: null, teamUses: 0 };

function harness() {
    const writes = vi.fn(async () => {});
    const realStore = new Store({ get: async () => undefined, set: writes });
    const routed = routeStore(realStore);
    const access = observable({ enabled: true, ready: false, projects: [] as string[], checkedAt: 0 });
    const ui = observable({ windowOpen: true, management: false, compose: [] as string[], inline: null, menu: null, dialog: null });
    const state = { discordId: "123", revision: "1", name: "Support", profileId: "123", error: null as unknown,
        templates: [template], pendingLogin: null as Promise<void> | null, pendingGet: null as Promise<unknown> | null,
        pendingLogout: null as Promise<void> | null, nowServer: "time-a", projects: ["mj"], permissions: "1", pendingSnapshot: null as Promise<unknown> | null,
        saved: false, secure: true, pendingVault: null as Promise<void> | null, restoreError: null as unknown };
    const clients: FakeClient[] = [];
    class FakeClient {
        connectionId = "connection";
        disposed = false;
        constructor() { clients.push(this); }
        login = vi.fn(async (device: (v: unknown) => void) => {
            device({ userCode: "ABCD", verificationUriComplete: "https://panel.majestic-rp.tech/connect?user_code=ABCD" });
            if (state.pendingLogin) await state.pendingLogin;
        });
        restore = vi.fn(async () => { if (state.restoreError) throw state.restoreError; return state.saved; });
        streamAuthorized = vi.fn(async (operation: (token: string, signal: AbortSignal) => Promise<void>) => operation("test-only", new AbortController().signal));
        refreshForStream = vi.fn(async () => {});
        get = vi.fn(async (path: string) => {
            if (state.pendingGet) return state.pendingGet;
            if (state.error) throw state.error;
            if (path === "/me") return { accountId: state.profileId, connectionId: "connection", minimumPluginVersion: "1.0.0", projects: state.projects, name: state.name, permissionsRevision: state.permissions, scopes: ["profile:read"] };
            if (state.pendingSnapshot) return state.pendingSnapshot;
            return { accountId: state.profileId, revision: state.revision, permissionsRevision: "1", serverTime: state.nowServer,
                templates: state.templates, personal: [], folders: [] };
        });
        dispose = vi.fn(() => { this.disposed = true; });
        cancel = vi.fn(async () => { this.disposed = true; });
        logout = vi.fn(async () => { this.disposed = true; if (state.pendingLogout) await state.pendingLogout; });
    }
    let freshness: () => Promise<boolean> = async () => false;
    let generation = 0;
    const handlers = new Map<string, () => void>();
    const windowHandlers = new Map<string, () => void>();
    const accountHandlers = new Set<() => void>();
    const streams: { signal: AbortSignal; emit: (event: { type: string; data: unknown }) => void; end: () => void; fail: (error: unknown) => void }[] = [];
    const streamReader = vi.fn((_token: string, signal: AbortSignal, emit: (event: { type: string; data: unknown }) => void) => new Promise<void>((end, fail) => {
        streams.push({ signal, emit, end, fail });
        signal.addEventListener("abort", () => end(), { once: true });
    }));
    const deps: Record<string, unknown> = {
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: state.discordId }),
            addChangeListener: (fn: () => void) => accountHandlers.add(fn), removeChangeListener: (fn: () => void) => accountHandlers.delete(fn) }, FluxDispatcher: {
            subscribe: (name: string, fn: () => void) => handlers.set(name, fn), unsubscribe: (name: string) => handlers.delete(name) } },
        "../buildInfo": { PLUGIN_VERSION: "1.0.0" }, "../core/state": { Store },
        "../core/panelCatalog": { parseProfile: (v: unknown) => v, parseSnapshot: (v: unknown) => v },
        "../core/panelClient": { PanelClient: FakeClient, PanelError },
        "../core/panelProtocol": { PANEL_ORIGIN: "https://panel.majestic-rp.tech" },
        "../core/panelEvents": { createPanelEventStream: () => streamReader },
        "../panelVault": { createPanelVault: async () => { if (state.pendingVault) await state.pendingVault; return state.secure ? {} : undefined; } },
        "../core/panelTransport": { createPanelTransport: vi.fn() }, "../panelHtml": { htmlToDiscordText: vi.fn() },
        "./demo": { disableDemo: vi.fn(), enableDemo: vi.fn() },
        "./flow": { confirmedForeign: new Set(), supersede: vi.fn() }, "./observable": { createObservable: observable },
        "./op": { nextGeneration: () => ++generation, captureWindowTarget: vi.fn(), windowEditor: () => null },
        "./uiState": { panelAccess: access, realStore, selectStore: routed.select, ui,
            libraryIsFresh: () => access.get().ready && Date.now() - access.get().checkedAt <= 30000,
            setFreshnessCheck: (fn: () => Promise<boolean>) => { freshness = fn; } }
    };
    const module = { exports: {} as any };
    const open = vi.fn();
    runInNewContext(compiled, { module, exports: module.exports, Date, setTimeout, clearTimeout, Math, AbortController, window: { open,
        addEventListener: (name: string, fn: () => void) => windowHandlers.set(name, fn), removeEventListener: (name: string) => windowHandlers.delete(name) },
        require: (name: string) => { if (!(name in deps)) throw new Error("Unexpected import " + name); return deps[name]; } });
    return { api: module.exports, store: routed.store, realStore, state, ui, access, clients, writes, open, handlers, windowHandlers, accountHandlers, streams, streamReader,
        freshness: () => freshness(), generation: () => generation };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-18T00:00:00Z")); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("real panel controller with isolated transport/UI boundaries", () => {
    it("opens confirmation and atomically loads a separate read-only catalog", async () => {
        const h = harness(); await h.api.connectPanel();
        expect(h.open).toHaveBeenCalledOnce(); expect(h.api.panel.get().phase).toBe("ready");
        expect(h.store.templates).toEqual([template]); expect(h.store.catalogReadOnly).toBe(true);
        expect(h.realStore.templates).toEqual([]); expect(h.writes).not.toHaveBeenCalled();
        expect(h.api.panel.get().code).toBe(""); expect(h.api.panel.get().url).toBe("");
    });
    it("does not replace identical records just because server time changes", async () => {
        const h = harness(); await h.api.connectPanel();
        const v = h.store.setVersion, g = h.generation();
        h.state.nowServer = "time-b"; await h.api.reloadPanel();
        expect(h.store.setVersion).toBe(v); expect(h.generation()).toBe(g);
    });
    it("preserves preferences on rename and drops removed IDs on a complete snapshot", async () => {
        const h = harness(); await h.api.connectPanel(); h.store.toggleFavorite(template.id);
        h.state.templates = [{ ...template, title: "Renamed" }]; h.state.revision = "2";
        await h.api.reloadPanel(); expect(h.store.data.favorites).toEqual([template.id]);
        h.state.templates = []; h.state.revision = "3";
        await h.api.reloadPanel(); expect(h.store.templates).toEqual([]); expect(h.store.data.favorites).toEqual([]);
    });
    it("prevents local import and personal mutation of panel data", async () => {
        const h = harness(); await h.api.connectPanel();
        expect(() => h.store.importText("anything")).toThrow();
        expect(() => h.store.replaceDemoCatalog("")).toThrow();
        await expect(h.store.saveFolder("Folder")).rejects.toThrow();
        await expect(h.store.deletePersonal("personal:panel:1")).rejects.toThrow();
        expect(h.store.templates).toEqual([template]);
    });
    it("ignores login completion after cancellation and never reads a snapshot", async () => {
        const h = harness(), wait = deferred<void>(); h.state.pendingLogin = wait.promise;
        const task = h.api.connectPanel(); await vi.advanceTimersByTimeAsync(0); await h.api.cancelPanelLogin(); wait.resolve(); await task;
        expect(h.api.panel.get().phase).toBe("idle"); expect(h.store.templates).toEqual([]);
        expect(h.clients[0].get).not.toHaveBeenCalled();
    });
    it("drops late snapshot work on logout", async () => {
        const h = harness(); await h.api.connectPanel();
        const late = deferred<unknown>(); h.state.pendingGet = late.promise;
        const task = h.api.reloadPanel(); await h.api.logoutPanel(); late.resolve({ accountId: "123" }); await task;
        expect(h.store.templates).toEqual([]); expect(h.access.get().ready).toBe(false);
    });
    it("enforces newly received rights before a delayed snapshot", async () => {
        const h = harness(); h.state.projects = ["mj", "ro"]; await h.api.connectPanel();
        h.state.projects = ["mj"]; h.state.permissions = "2";
        const wait = deferred<unknown>(); h.state.pendingSnapshot = wait.promise;
        const task = h.api.reloadPanel(); await vi.advanceTimersByTimeAsync(0);
        expect(h.access.get().ready).toBe(false); expect(h.store.templates).toEqual([]);
        expect(h.api.panel.get().phase).toBe("loading");
        await h.api.logoutPanel(); wait.resolve({}); await task;
    });
    it("blocks a different Discord account and erases catalog", async () => {
        const h = harness(); h.state.discordId = "999"; await h.api.connectPanel();
        expect(h.api.panel.get().phase).toBe("error"); expect(h.store.templates).toEqual([]);
        expect(h.clients[0].get).toHaveBeenCalledTimes(1);
    });
    it("clears data on Discord logout and plugin disposal", async () => {
        const h = harness(); const off = h.api.startPanel(); await h.api.connectPanel();
        h.handlers.get("LOGOUT")!(); expect(h.store.templates).toEqual([]); expect(h.access.get().ready).toBe(false);
        off(); expect(h.handlers.size).toBe(0); h.api.disposePanel();
    });
    it("deduplicates freshness requests and blocks stale inserts on network failure", async () => {
        const h = harness(); await h.api.connectPanel(); const active = h.clients[0]; active.get.mockClear();
        vi.setSystemTime(Date.now() + 31000);
        await Promise.all([h.freshness(), h.freshness(), h.freshness()]);
        expect(active.get).toHaveBeenCalledTimes(2);
        vi.setSystemTime(Date.now() + 31000); h.state.error = new PanelError("network_error");
        expect(await h.freshness()).toBe(false); expect(h.access.get().ready).toBe(false);
        expect(h.api.panel.get().phase).toBe("offline");
    });
    it("honours retry delay even when refresh is clicked repeatedly", async () => {
        const h = harness(); await h.api.connectPanel(); h.state.error = new PanelError("rate_limited", 429, 60000);
        await h.api.reloadPanel(); const active = h.clients[0], calls = active.get.mock.calls.length;
        await h.api.reloadPanel(); await h.api.reloadPanel(); expect(active.get).toHaveBeenCalledTimes(calls);
    });
    it("clears revoked/uncertain sessions instead of retrying a broken refresh", async () => {
        for (const code of ["session_revoked", "refresh_uncertain"]) {
            const h = harness(); await h.api.connectPanel(); h.state.error = new PanelError(code, 401);
            await h.api.reloadPanel(); expect(h.api.panel.get().phase).toBe("error");
            expect(h.store.templates).toEqual([]); expect(h.access.get().ready).toBe(false);
        }
    });
    it("does not switch a new login to local mode when an older logout completes late", async () => {
        const h = harness(); await h.api.connectPanel(); const delayed = deferred<void>(); h.state.pendingLogout = delayed.promise;
        const leaving = h.api.useLocalLibrary(); h.state.pendingLogout = null;
        const reconnect = h.api.connectPanel(); await vi.advanceTimersByTimeAsync(0);
        expect(h.clients).toHaveLength(1); // New vault is not claimed before the old cleanup settles.
        delayed.resolve(); await leaving; await reconnect;
        expect(h.api.panel.get().enabled).toBe(true); expect(h.api.panel.get().phase).toBe("ready");
        expect(h.store.catalogReadOnly).toBe(true);
    });

    it("restores saved login without opening a browser and checks fresh rights before the catalog", async () => {
        const h = harness(); h.state.saved = true; h.ui.set({ windowOpen: false });
        await h.api.restorePanel();
        expect(h.open).not.toHaveBeenCalled(); expect(h.clients[0].login).not.toHaveBeenCalled();
        expect(h.clients[0].get.mock.calls.map(([path]) => path)).toEqual(["/me", "/snapshot"]);
        expect(h.api.panel.get().persistent).toBe(true); expect(h.api.panel.get().phase).toBe("ready");
        expect(h.ui.get().windowOpen).toBe(false);
    });

    it("starts idle without saved credentials, and reports a memory-only environment truthfully", async () => {
        const h = harness(); h.state.secure = false;
        await h.api.restorePanel();
        expect(h.clients[0].get).not.toHaveBeenCalled(); expect(h.open).not.toHaveBeenCalled();
        expect(h.api.panel.get().phase).toBe("idle"); expect(h.api.panel.get().persistent).toBe(false);
    });

    it("cannot finish restoring after stop during a slow native vault lookup", async () => {
        const h = harness(), wait = deferred<void>(); h.state.saved = true; h.state.pendingVault = wait.promise;
        const task = h.api.restorePanel(); h.api.disposePanel(); wait.resolve(); await task;
        expect(h.clients).toHaveLength(0); expect(h.store.templates).toEqual([]);
    });

    it("coalesces SSE changes and rejects a snapshot overtaken by a newer event", async () => {
        const h = harness(); await h.api.connectPanel();
        const old = deferred<unknown>(); h.state.pendingSnapshot = old.promise;
        h.streams[0].emit({ type: "library.changed", data: {} }); await vi.advanceTimersByTimeAsync(0);
        h.streams[0].emit({ type: "library.changed", data: {} }); h.streams[0].emit({ type: "library.changed", data: {} });
        h.state.pendingSnapshot = null; h.state.revision = "3"; h.state.templates = [{ ...template, text: "New answer" }];
        old.resolve({ accountId: "123", revision: "2", templates: [{ ...template, text: "Old answer" }], personal: [], folders: [] });
        await vi.advanceTimersByTimeAsync(0);
        expect(h.store.templates[0].text).toBe("New answer"); expect(h.access.get().ready).toBe(true);
        expect(h.clients[0].get.mock.calls.filter(([p]) => p === "/snapshot")).toHaveLength(3);
    });

    it("clears rights immediately on permissions event even while snapshot is delayed", async () => {
        const h = harness(); await h.api.connectPanel(); const wait = deferred<unknown>(); h.state.pendingSnapshot = wait.promise;
        h.streams[0].emit({ type: "permissions.changed", data: {} });
        expect(h.access.get().ready).toBe(false); expect(h.store.templates).toEqual([]);
        await h.api.logoutPanel(); wait.resolve({}); await vi.advanceTimersByTimeAsync(0);
        expect(h.store.templates).toEqual([]);
    });

    it("revocation stops the stream, clears credentials and ignores late events", async () => {
        const h = harness(); await h.api.connectPanel(); const active = h.clients[0];
        h.streams[0].emit({ type: "session.revoked", data: {} });
        expect(h.store.templates).toEqual([]); expect(active.cancel).toHaveBeenCalledOnce();
        expect(h.streams[0].signal.aborted).toBe(true);
        const calls = active.get.mock.calls.length;
        h.streams[0].emit({ type: "library.changed", data: {} }); await vi.advanceTimersByTimeAsync(120000);
        expect(active.get).toHaveBeenCalledTimes(calls); expect(h.streamReader).toHaveBeenCalledOnce();
    });

    it("refreshes after token.expired then reconnects and resnapshots on resync.required", async () => {
        const h = harness(); await h.api.connectPanel();
        h.streams[0].emit({ type: "token.expired", data: {} }); h.streams[0].end();
        await vi.advanceTimersByTimeAsync(250);
        expect(h.clients[0].refreshForStream).toHaveBeenCalledOnce(); expect(h.streams).toHaveLength(2);
        const calls = h.clients[0].get.mock.calls.length;
        h.streams[1].emit({ type: "resync.required", data: {} }); await vi.advanceTimersByTimeAsync(0);
        expect(h.clients[0].get.mock.calls.length).toBe(calls + 2);
    });

    it("honours SSE Retry-After while the fallback catalog poll remains available", async () => {
        const h = harness(); await h.api.connectPanel();
        h.streams[0].fail(new PanelError("rate_limited", 429, 120000)); await vi.advanceTimersByTimeAsync(119999);
        expect(h.streams).toHaveLength(1); expect(h.clients[0].get.mock.calls.length).toBeGreaterThan(2);
        expect(h.api.panel.get().sync).toBe("retrying"); await vi.advanceTimersByTimeAsync(1);
        expect(h.streams).toHaveLength(2);
    });

    it("checks stale state on focus and removes resume listeners at stop", async () => {
        const h = harness(); const off = h.api.startPanel(); await vi.advanceTimersByTimeAsync(0); await h.api.connectPanel();
        const active = h.clients.at(-1)!; const calls = active.get.mock.calls.length;
        vi.setSystemTime(Date.now() + 31000); h.windowHandlers.get("focus")!(); await vi.advanceTimersByTimeAsync(0);
        expect(active.get.mock.calls.length).toBe(calls + 2);
        off(); h.api.disposePanel(); expect(h.windowHandlers.size).toBe(0); expect(h.streams[0].signal.aborted).toBe(true);
    });

    it("drops the previous account immediately on a UserStore change", async () => {
        const h = harness(); const off = h.api.startPanel(); await vi.advanceTimersByTimeAsync(0); await h.api.connectPanel();
        h.state.discordId = "999"; for (const listener of h.accountHandlers) listener();
        expect(h.store.templates).toEqual([]); expect(h.access.get().ready).toBe(false);
        expect(h.clients.at(-1)!.logout).toHaveBeenCalledOnce(); off(); expect(h.accountHandlers.size).toBe(0);
    });

    it("a pending SSE retry from a previous login cannot block a new session's stream", async () => {
        const h = harness(); await h.api.connectPanel(); h.streams[0].fail(new PanelError("network_error"));
        await vi.advanceTimersByTimeAsync(0); await h.api.logoutPanel(); await h.api.connectPanel();
        expect(h.streams).toHaveLength(2);
    });

    it("cancels a pending device login immediately when Discord switches accounts", async () => {
        const h = harness(), wait = deferred<void>(); const off = h.api.startPanel(); await vi.advanceTimersByTimeAsync(0);
        h.state.pendingLogin = wait.promise; const connecting = h.api.connectPanel(); await vi.advanceTimersByTimeAsync(0);
        const active = h.clients.at(-1)!; h.state.discordId = "999";
        for (const listener of h.accountHandlers) listener();
        expect(h.api.panel.get().code).toBe(""); expect(active.logout).toHaveBeenCalledOnce();
        wait.resolve(); await connecting; expect(active.get).not.toHaveBeenCalled(); off();
    });
});
