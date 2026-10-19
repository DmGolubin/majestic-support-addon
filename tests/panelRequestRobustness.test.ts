import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store, STORE_KEY } from "../src/core/state";
import { diagnosticJournal } from "../src/core/diagnosticJournal";
import { routeStore } from "../src/core/storeRouter";
import { createPanelPreferencesStorage } from "../src/core/panelPreferences";
import { PanelError } from "../src/core/panelClient";
import { PanelCatalogValidationError, parseFolderRecord, parsePersonalRecord, parseProfile, parseSnapshot, supportsPanelVersion } from "../src/core/panelCatalog";
import { PanelMutation, panelMutationScope } from "../src/core/panelProtocol";
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

function harness(wire?: { get(path: string): Promise<unknown>; mutate?(request: PanelMutation): Promise<unknown>; }, pluginVersion = "1.0.0") {
    const preferenceData = new Map<string, unknown>();
    const io = { readError: false, writeError: false, pendingRead: null as Promise<void> | null, pendingWrite: null as Promise<void> | null };
    const preferenceStorage = {
        get: vi.fn(async (key: string) => {
            if (io.pendingRead) await io.pendingRead;
            if (io.readError) throw new Error("Read failed");
            return structuredClone(preferenceData.get(key));
        }),
        set: vi.fn(async (key: string, value: unknown) => {
            if (io.pendingWrite) await io.pendingWrite;
            if (io.writeError) throw new Error("Write failed");
            preferenceData.set(key, structuredClone(value));
        })
    };
    const writes = vi.fn(async () => {});
    const realStore = new Store({ get: async () => undefined, set: writes });
    const routed = routeStore(realStore);
    const access = observable({ enabled: true, ready: false, projects: [] as string[], checkedAt: 0 });
    const ui = observable({ windowOpen: true, management: false, compose: [] as string[], inline: null, menu: null, dialog: null });
    const state = { discordId: "123456789012345678", revision: "1", name: "Support", profileId: "123456789012345678", error: null as unknown,
        templates: [template], pendingLogin: null as Promise<void> | null, pendingGet: null as Promise<unknown> | null,
        pendingLogout: null as Promise<void> | null, nowServer: "time-a", projects: ["mj"], permissions: "1", pendingSnapshot: null as Promise<unknown> | null,
        saved: false, secure: true, pendingVault: null as Promise<void> | null, restoreError: null as unknown };
    const clients: FakeClient[] = [];
    class FakeClient {
        connectionId = wire ? "12345678-1234-1234-1234-123456789abc" : "connection";
        disposed = false;
        constructor(_transport?: unknown, public options: { writeAccess?: boolean; reminderAccess?: boolean } = {}) { clients.push(this); }
        mutate = vi.fn(async (request: PanelMutation, guard: () => void) => { guard(); return wire?.mutate?.(request); });
        login = vi.fn(async (device: (v: unknown) => void) => {
            device({ userCode: "ABCD", verificationUriComplete: "https://panel.majestic-rp.tech/connect?user_code=ABCD" });
            if (state.pendingLogin) await state.pendingLogin;
        });
        restore = vi.fn(async () => { if (state.restoreError) throw state.restoreError; return state.saved; });
        resumeLogin = vi.fn();
        streamAuthorized = vi.fn(async (operation: (token: string, signal: AbortSignal) => Promise<void>) => operation("test-only", new AbortController().signal));
        refreshForStream = vi.fn(async () => {});
        get = vi.fn(async (path: string) => {
            if (wire) return wire.get(path);
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
    const documentHandlers = new Map<string, () => void>();
    const accountHandlers = new Set<() => void>();
    const streams: { signal: AbortSignal; emit: (event: { type: string; data: unknown }) => void; end: () => void; fail: (error: unknown) => void }[] = [];
    const streamReader = vi.fn((_token: string, signal: AbortSignal, emit: (event: { type: string; data: unknown }) => void) => new Promise<void>((end, fail) => {
        streams.push({ signal, emit, end, fail });
        signal.addEventListener("abort", () => end(), { once: true });
    }));
    const permission = vi.fn(async (_interactive: boolean): Promise<string> => "ready");
    const reminders = { invalidateTicketReminders: vi.fn(), stopTicketReminders: vi.fn(), syncTicketReminders: vi.fn() };
    const parsers = wire ? { parseProfile: vi.fn(parseProfile), parseSnapshot: vi.fn(parseSnapshot), parsePersonalRecord, parseFolderRecord }
        : { parseProfile: (v: unknown) => v, parseSnapshot: (v: unknown) => v };
    const deps: Record<string, unknown> = {
        "../panelPermission": { ensurePanelPermission: permission },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: state.discordId }),
            addChangeListener: (fn: () => void) => accountHandlers.add(fn), removeChangeListener: (fn: () => void) => accountHandlers.delete(fn) }, FluxDispatcher: {
            subscribe: (name: string, fn: () => void) => handlers.set(name, fn), unsubscribe: (name: string) => handlers.delete(name) } },
        "../core/diagnosticJournal": { diagnosticJournal },
        "../buildInfo": { PLUGIN_VERSION: pluginVersion }, "../core/state": { Store, STORE_KEY },
        "../core/panelCatalog": { ...parsers, PanelCatalogValidationError, supportsPanelVersion },
        "../core/panelPreferences": { createPanelPreferencesStorage },
        "../platform": { storage: preferenceStorage },
        "../core/panelClient": { PanelClient: FakeClient, PanelError },
        "../core/panelProtocol": { PANEL_ORIGIN: "https://panel.majestic-rp.tech", panelMutationScope },
        "../core/panelEvents": { createPanelEventStream: () => streamReader },
        "../panelVault": { createPanelVault: async () => { if (state.pendingVault) await state.pendingVault; return state.secure ? {} : undefined; } },
        "../core/panelTransport": { createPanelTransport: vi.fn() }, "../panelHtml": { htmlToDiscordText: vi.fn(() => "Answer") },
        "./demo": { disableDemo: vi.fn(), enableDemo: vi.fn() },
        "./ticketReminders": reminders,
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
        document: { visibilityState: "visible", addEventListener: (name: string, fn: () => void) => documentHandlers.set(name, fn),
            removeEventListener: (name: string) => documentHandlers.delete(name) },
        require: (name: string) => { if (!(name in deps)) throw new Error("Unexpected import " + name); return deps[name]; } });
    return { reminders, parsers, permission, preferenceData, preferenceStorage, io, api: module.exports, store: routed.store, realStore, state, ui, access, clients, writes, open, handlers, windowHandlers, accountHandlers, streams, streamReader,
        documentHandlers, freshness: () => freshness(), generation: () => generation };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-18T00:00:00Z")); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("request/session robustness regressions", () => {
    it("uses 361 profile/snapshot pairs and one SSE connection during six healthy idle hours", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const h = harness(); await h.api.connectPanel();
        await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
        expect(h.clients[0].get.mock.calls.filter(([path]) => path === "/me")).toHaveLength(361);
        expect(h.clients[0].get.mock.calls.filter(([path]) => path === "/snapshot")).toHaveLength(361);
        expect(h.streamReader).toHaveBeenCalledOnce();
        expect(h.clients[0].cancel).not.toHaveBeenCalled(); h.api.disposePanel();
    });

    it("coalesces 100 simultaneous explicit reloads into one pair", async () => {
        const h = harness(); await h.api.connectPanel();
        h.clients[0].get.mockClear();
        await Promise.all(Array.from({ length: 100 }, () => h.api.reloadPanel()));
        expect(h.clients[0].get.mock.calls.map(([path]) => path)).toEqual(["/me", "/snapshot"]);
        h.api.disposePanel();
    });

    it("uses six failed reads over five offline minutes, then one recovery pair", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const h = harness(); await h.api.connectPanel();
        h.clients[0].get.mockClear();
        h.state.error = new PanelError("network_error"); await h.api.reloadPanel();
        await vi.advanceTimersByTimeAsync(300000); // attempts at 0, 10, 30, 70, 150, 270 seconds
        expect(h.clients[0].get).toHaveBeenCalledTimes(6);
        expect(h.clients[0].cancel).not.toHaveBeenCalled();
        expect(h.api.panel.get().phase).toBe("offline");
        h.state.error = null; await vi.advanceTimersByTimeAsync(90000);
        expect(h.clients[0].get).toHaveBeenCalledTimes(8);
        expect(h.api.panel.get().phase).toBe("ready"); h.api.disposePanel();
    });

    it("keeps the longest Retry-After from the initial parallel reads", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const h = harness(), login = deferred<void>(); h.state.pendingLogin = login.promise;
        const connected = h.api.connectPanel(); await vi.advanceTimersByTimeAsync(0);
        const active = h.clients[0];
        active.get.mockRejectedValueOnce(new PanelError("network_error"))
            .mockRejectedValueOnce(new PanelError("rate_limited", 429, 120000));
        login.resolve(); await connected;
        await vi.advanceTimersByTimeAsync(119999);
        expect(active.get).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(active.get).toHaveBeenCalledTimes(4);
        expect(h.api.panel.get().phase).toBe("ready"); h.api.disposePanel();
    });

    it.each(["catalog", "SSE"])("chunks a long %s Retry-After without early requests or losing recovery", async target => {
        const timers = vi.spyOn(globalThis, "setTimeout");
        const h = harness(); await h.api.connectPanel();
        const max = 2147483647, delay = max + 1000;
        if (target === "catalog") {
            h.state.error = new PanelError("rate_limited", 429, delay); await h.api.reloadPanel(); h.state.error = null;
        } else {
            h.streams[0].fail(new PanelError("rate_limited", 429, delay)); await vi.advanceTimersByTimeAsync(0);
        }
        const wake = [...timers.mock.calls].reverse().find(([, ms]) => ms === max)![0] as () => void;
        const reads = h.clients[0].get.mock.calls.length, streams = h.streams.length;
        // Simulate the maximum platform timer expiring, without running 24 days of unrelated polls.
        const before = Date.now();
        vi.clearAllTimers(); vi.setSystemTime(before + max); wake();
        await vi.advanceTimersByTimeAsync(999);
        expect(h.clients[0].get).toHaveBeenCalledTimes(reads);
        expect(h.streams).toHaveLength(streams);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.clients[0].get).toHaveBeenCalledTimes(reads + (target === "catalog" ? 2 : 0));
        expect(h.streams).toHaveLength(streams + (target === "SSE" ? 1 : 0));
        h.api.disposePanel();
    });
    it("loads one profile/snapshot pair for a synchronous burst of 100 SSE changes", async () => {
        const h = harness(); await h.api.connectPanel();
        const active = h.clients[0]; active.get.mockClear();
        for (let i = 0; i < 100; i++) h.streams[0].emit({ type: "library.changed", data: {} });
        expect(h.access.get().ready).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(active.get.mock.calls.map(([path]) => path)).toEqual(["/me", "/snapshot"]);
        expect(h.access.get().ready).toBe(true);
        h.api.disposePanel();
    });

    it.each([429, 503])("keeps superseded HTTP %s backoff through SSE, focus and explicit reloads", async status => {
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const h = harness(); h.api.startPanel(); await vi.advanceTimersByTimeAsync(0); await h.api.connectPanel();
        const active = h.clients.at(-1)!; active.get.mockClear();
        const response = deferred<unknown>(); h.state.pendingSnapshot = response.promise;
        const reload = h.api.reloadPanel(); await vi.advanceTimersByTimeAsync(0);
        for (let i = 0; i < 100; i++) h.streams.at(-1)!.emit({ type: "library.changed", data: {} });
        h.state.pendingSnapshot = null;
        response.reject(new PanelError("rate_limited", status, 120000)); await reload;
        await vi.advanceTimersByTimeAsync(0);
        expect(active.get).toHaveBeenCalledTimes(2);
        for (let i = 0; i < 20; i++) { h.windowHandlers.get("focus")!(); await h.api.reloadPanel(); }
        await vi.advanceTimersByTimeAsync(119999);
        expect(active.get).toHaveBeenCalledTimes(2);
        expect(active.cancel).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(active.get).toHaveBeenCalledTimes(4);
        expect(h.api.panel.get().phase).toBe("ready");
        h.api.disposePanel();
    });

    it.each([new PanelError("transport_error"), new PanelError("http_error", 502)])("recovers transient %s without clearing credentials", async error => {
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const h = harness(); await h.api.connectPanel();
        h.state.error = error; await h.api.reloadPanel();
        expect(h.api.panel.get().phase).toBe("offline");
        expect(h.clients[0].cancel).not.toHaveBeenCalled();
        h.state.error = null; await vi.advanceTimersByTimeAsync(10000);
        expect(h.api.panel.get().phase).toBe("ready");
        h.api.disposePanel();
    });

    it.each(["EOF", "error"])("backs off repeated short SSE %s without extra snapshot loads", async mode => {
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const h = harness(); await h.api.connectPanel();
        for (const delay of [2000, 4000, 8000, 16000]) {
            const count = h.streams.length;
            if (mode === "EOF") h.streams.at(-1)!.end();
            else h.streams.at(-1)!.fail(new PanelError("network_error"));
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(h.streams).toHaveLength(count);
            await vi.advanceTimersByTimeAsync(1);
            expect(h.streams).toHaveLength(count + 1);
        }
        expect(h.clients[0].get).toHaveBeenCalledTimes(2);
        h.api.disposePanel();
        await vi.advanceTimersByTimeAsync(120000);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not let an obsolete SSE failure revoke a replacement session", async () => {
        const h = harness(); await h.api.connectPanel(); const old = h.streams[0];
        h.api.disposePanel(); await h.api.connectPanel();
        old.emit({ type: "session.revoked", data: {} }); old.fail(new PanelError("session_revoked", 401));
        await vi.advanceTimersByTimeAsync(0);
        expect(h.api.panel.get().phase).toBe("ready");
        expect(h.clients.at(-1)!.cancel).not.toHaveBeenCalled();
        expect(h.streams).toHaveLength(2);
        h.api.disposePanel();
    });

    it("still terminates on a revocation returned by an invalidated read", async () => {
        const h = harness(); await h.api.connectPanel();
        const response = deferred<unknown>(); h.state.pendingSnapshot = response.promise;
        const reload = h.api.reloadPanel(); await vi.advanceTimersByTimeAsync(0);
        h.streams[0].emit({ type: "library.changed", data: {} });
        response.reject(new PanelError("session_revoked", 401)); await reload;
        expect(h.clients[0].cancel).toHaveBeenCalledOnce();
        expect(h.store.templates).toEqual([]);
        await vi.advanceTimersByTimeAsync(120000);
        expect(vi.getTimerCount()).toBe(0);
    });
});

