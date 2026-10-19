import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store, STORE_KEY } from "../src/core/state";
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

describe("reminder lifecycle wiring", () => {
    it("retires timers, stream, catalog and freshness even when client disposal and reminder cleanup throw", async () => {
        const h = harness();
        const off = h.api.startPanel(); await h.api.connectPanel();
        expect(h.store.templates.length).toBeGreaterThan(0);
        expect(h.streams).toHaveLength(1);
        const active = h.clients[h.clients.length - 1];
        active.dispose.mockImplementationOnce(() => { throw new Error("dispose failure"); });
        h.reminders.stopTicketReminders.mockImplementationOnce(() => { throw new Error("reminder cleanup failure"); });
        expect(() => h.api.disposePanel()).not.toThrow();
        expect(h.handlers.size + h.windowHandlers.size + h.documentHandlers.size + h.accountHandlers.size).toBe(0);
        expect(h.streams[0].signal.aborted).toBe(true);
        expect(h.api.panelPersonal.get().catalog).toBeNull();
        expect(h.api.panel.get().phase).toBe("idle");
        expect(h.store.templates).toEqual([]); expect(h.access.get().ready).toBe(false);
        expect(await h.freshness()).toBe(false);
        await vi.advanceTimersByTimeAsync(120000);
        expect(vi.getTimerCount()).toBe(0);
        off(); h.api.disposePanel(); expect(active.dispose).toHaveBeenCalledOnce();
    });

    it("attempts preference flush and catalog clearing even when closing preference writes throws", async () => {
        const h = harness(); await h.api.connectPanel();
        const closing = vi.fn(() => { throw new Error("close preferences failed"); });
        const flush = vi.fn(async () => {});
        h.store.closePanelPreferences = closing; h.store.flush = flush;
        expect(() => h.api.disposePanel()).not.toThrow();
        expect(closing).toHaveBeenCalledOnce(); expect(flush).toHaveBeenCalledOnce();
        expect(h.store.templates).toEqual([]); expect(h.api.panelPersonal.get().catalog).toBeNull();
        expect(h.api.panel.get().phase).toBe("idle");
    });

    it("binds verified identity and projects, forwards ticket events and invalidates on disposal", async () => {
        const h = harness(); await h.api.connectPanel();
        const binding = h.reminders.syncTicketReminders.mock.calls.at(-1)![0];
        expect(binding).toMatchObject({ accountId: h.state.discordId, projects: ["majestic"], permissionsRevision: "1" });
        expect(binding.current()).toBe(true);
        for (const type of ["tickets.changed", "tickets.unavailable"]) {
            h.streams[0].emit({ type, data: {} });
            expect(h.reminders.invalidateTicketReminders).toHaveBeenCalledWith(type);
        }
        h.state.discordId = "223456789012345678";
        expect(binding.current()).toBe(false);
        h.api.disposePanel();
        expect(h.reminders.stopTicketReminders).toHaveBeenCalled();
    });
    it("requests reminder scopes explicitly while preserving a read-only personal session", async () => {
        const h = harness(); await h.api.connectPanel();
        await h.api.authorizePanelReminders();
        expect(h.clients.at(-1)!.options).toMatchObject({ reminderAccess: true, writeAccess: false });
        h.api.disposePanel();
    });
    it("restores without an implicit scope upgrade", async () => {
        const h = harness(); h.state.saved = true;
        await h.api.restorePanel();
        expect(h.clients.at(-1)!.options).toMatchObject({ reminderAccess: false, writeAccess: false });
        h.api.disposePanel();
    });
});

describe("personal write controller", () => {
    function setup(writeAccess = true) {
        const date = "2026-10-18T00:00:00.000Z";
        const profile = { schemaVersion: 1, accountId: "123456789012345678", connectionId: "12345678-1234-1234-1234-123456789abc",
            name: "Support", projects: ["majestic", "russia-online"], permissionsRevision: "p1", minimumPluginVersion: "1.0.0", serverTime: date,
            scopes: ["profile:read", "faq:read", "personal:read", "folders:read", "sync:read", ...(writeAccess ? ["personal:write", "folders:write"] : [])] };
        const row = { id: "7", version: "opaque-seven", title: "Original", text: "**Answer**\r\n[[greeting:end]]", format: "text",
            projects: ["majestic"], shared: false, command: null, color: "amber" as string | null, folderId: null, updatedAt: date };
        const folder = { id: "8", version: "folder-eight", title: "Folder", project: "russia-online", position: 3, updatedAt: date };
        const snapshot = { schemaVersion: 1, accountId: profile.accountId, revision: "r1", permissionsRevision: "p1", serverTime: date,
            projects: profile.projects, faq: [], personal: [row], folders: [folder], trash: [], limits: { colors: ["amber"] }, colorLabels: {} };
        const get = vi.fn(async (path: string): Promise<unknown> => structuredClone(path === "/me" ? profile : snapshot));
        const mutate = vi.fn(async (_request: PanelMutation): Promise<unknown> => ({ template: structuredClone(row) }));
        return { ...harness({ get, mutate }), get, mutate, profile, snapshot, row, folder };
    }
    const create = (): PanelMutation => ({ path: "/personal-templates", method: "POST", idempotencyKey: "b5b3fc76-7453-49b8-932f-e1eaa6338f9d",
        body: { title: "Draft", text: "Exact\r\n{{field}}", project: "majestic", shared: false, command: null, color: null, folderId: null } });
    const patch = (): PanelMutation => ({ path: "/personal-templates/7", method: "PATCH", version: "opaque-seven", body: { title: "Draft" } });

    it("publishes server metadata separately and never writes server records to local storage", async () => {
        const h = setup(); await h.api.connectPanel();
        expect(h.api.panelPersonal.get().catalog.personalRecords[0]).toMatchObject({ id: "7", version: "opaque-seven", color: "amber" });
        expect(h.api.panelPersonal.get().catalog.folderRecords[0]).toMatchObject({ version: "folder-eight", project: "ro", position: 3 });
        h.mutate.mockImplementation(async () => {
            h.row.title = "Server result"; h.row.version = "opaque-next"; h.snapshot.revision = "r2";
            return { template: structuredClone(h.row) };
        });
        await expect(h.api.preparePanelWrite(patch())()).resolves.toEqual({ refreshed: true });
        expect(h.api.panelPersonal.get().catalog.personalRecords[0].title).toBe("Server result");
        expect(h.store.templates[0].title).toBe("Server result"); expect(h.writes).not.toHaveBeenCalled();
        expect(JSON.stringify([...h.preferenceData.values()])).not.toContain("Server result");
        h.api.disposePanel();
    });
    it("retains immutable create JSON and key on a manual network retry", async () => {
        const h = setup(); await h.api.connectPanel(); const request = create();
        const action = h.api.preparePanelWrite(request), captured = JSON.stringify(request);
        (request.body as any).title = "Changed outside";
        h.mutate.mockRejectedValueOnce(new PanelError("network_error"));
        await expect(action()).rejects.toMatchObject({ code: "network_error" });
        expect(h.api.panelPersonal.get().catalog.personalRecords).toHaveLength(1);
        await action();
        expect(h.mutate.mock.calls.map(([sent]) => JSON.stringify(sent))).toEqual([captured, captured]); h.api.disposePanel();
    });
    it.each(["after-response", "sse-before-response"].flatMap(ordering => ["folder", "palette"].map(dependency => ({ ordering, dependency }))))(
        "keeps a successful create confirmed when its $dependency changes $ordering", async ({ ordering, dependency }) => {
        const h = setup(); h.folder.project = "majestic"; await h.api.connectPanel();
        const request = create(); Object.assign(request.body!, { folderId: "8", color: "amber" });
        const action = h.api.preparePanelWrite(request), wait = deferred<unknown>();
        h.mutate.mockReturnValueOnce(wait.promise);
        const saving = action(); await vi.advanceTimersByTimeAsync(0);
        const reply = { template: { ...structuredClone(h.row), folderId: "8" } };
        if (dependency === "folder") h.snapshot.folders = [];
        else { h.snapshot.limits.colors = []; h.row.color = null; }
        if (ordering === "sse-before-response") {
            h.streams[0].emit({ type: "library.changed", data: {} });
            await vi.advanceTimersByTimeAsync(0);
            expect(h.api.panelPersonal.get().catalog[dependency === "folder" ? "folderRecords" : "colors"]).toEqual([]);
        }
        wait.resolve(reply);
        await expect(saving).resolves.toEqual({ refreshed: true });
        expect(h.api.panelPersonal.get().catalog[dependency === "folder" ? "folderRecords" : "colors"]).toEqual([]);
        await expect(action()).resolves.toEqual({ refreshed: true });
        expect(h.mutate).toHaveBeenCalledTimes(1); h.api.disposePanel();
    });
    it("replays an uncertain create with the same JSON and UUID after folder and palette removal", async () => {
        const h = setup(); h.folder.project = "majestic"; await h.api.connectPanel();
        const request = create(); Object.assign(request.body!, { folderId: "8", color: "amber" });
        const action = h.api.preparePanelWrite(request), captured = JSON.stringify(request);
        const reply = { template: { ...structuredClone(h.row), folderId: "8" } };
        h.mutate.mockRejectedValueOnce(new PanelError("network_error")).mockResolvedValueOnce(reply);
        await expect(action()).rejects.toMatchObject({ code: "network_error" });
        h.snapshot.folders = []; h.snapshot.limits.colors = []; h.row.color = null;
        h.streams[0].emit({ type: "library.changed", data: {} }); await vi.advanceTimersByTimeAsync(0);
        await expect(action()).resolves.toEqual({ refreshed: true });
        expect(h.mutate.mock.calls.map(([sent]) => JSON.stringify(sent))).toEqual([captured, captured]);
        await action(); expect(h.mutate).toHaveBeenCalledTimes(2); h.api.disposePanel();
    });
    it.each(["folder", "color"])("still validates a removed %s before the first dispatch", async dependency => {
        const h = setup(); h.folder.project = "majestic"; await h.api.connectPanel();
        const request = create(); Object.assign(request.body!, { folderId: "8", color: "amber" });
        const action = h.api.preparePanelWrite(request);
        if (dependency === "folder") h.snapshot.folders = [];
        else { h.snapshot.limits.colors = []; h.row.color = null; }
        await h.api.reloadPanel();
        await expect(action()).rejects.toMatchObject({ code: "invalid_request" });
        expect(h.mutate).not.toHaveBeenCalled(); h.api.disposePanel();
    });
    it.each(["confirmed", "uncertain"])("still fences scopes, projects and session on a %s retry", async outcome => {
        const h = setup(); await h.api.connectPanel(); const request = create();
        const action = h.api.preparePanelWrite(request);
        if (outcome === "uncertain") {
            h.mutate.mockRejectedValueOnce(new PanelError("network_error"));
            await expect(action()).rejects.toMatchObject({ code: "network_error" });
        } else await action();
        const state = h.api.panelPersonal.get();
        h.api.panelPersonal.set({ scopes: [] });
        await expect(action()).rejects.toMatchObject({ code: "insufficient_scope", status: 403 });
        h.api.panelPersonal.set({ scopes: state.scopes, catalog: { ...state.catalog, projects: ["ro"] } });
        await expect(action()).rejects.toMatchObject({ code: "forbidden", status: 403 });
        h.api.panelPersonal.set({ catalog: state.catalog });
        h.streams[0].emit({ type: "session.revoked", data: {} });
        await expect(action()).rejects.toMatchObject({ code: "cancelled" });
        expect(h.mutate).toHaveBeenCalledTimes(1); h.api.disposePanel();
    });
    it("rejects a late success when write scope is revoked while awaiting the response", async () => {
        const h = setup(); await h.api.connectPanel(); const action = h.api.preparePanelWrite(create());
        const wait = deferred<unknown>(); h.mutate.mockReturnValueOnce(wait.promise);
        const saving = action(); await vi.advanceTimersByTimeAsync(0);
        h.api.panelPersonal.set({ scopes: [] }); wait.resolve({ template: structuredClone(h.row) });
        await expect(saving).rejects.toMatchObject({ code: "insufficient_scope", status: 403 });
        expect(h.mutate).toHaveBeenCalledTimes(1); h.api.disposePanel();
    });
    it("412 refreshes the server record, preserves request inputs, and permanently blocks that action", async () => {
        const h = setup(); await h.api.connectPanel(); const request = patch(), action = h.api.preparePanelWrite(request);
        h.mutate.mockImplementationOnce(async () => { h.row.title = "Other device"; h.row.version = "v2"; throw new PanelError("version_conflict", 412); });
        await expect(action()).rejects.toMatchObject({ status: 412 });
        expect(h.api.panelPersonal.get().catalog.personalRecords[0].title).toBe("Other device");
        expect(request).toEqual(patch());
        await expect(action()).rejects.toMatchObject({ status: 412 }); expect(h.mutate).toHaveBeenCalledTimes(1); h.api.disposePanel();
    });
    it("a failed post-conflict refresh does not present cached records as current", async () => {
        const h = setup(); await h.api.connectPanel(); const action = h.api.preparePanelWrite(patch());
        h.mutate.mockImplementationOnce(async () => { h.get.mockRejectedValue(new PanelError("network_error")); throw new PanelError("version_conflict", 412); });
        await expect(action()).rejects.toMatchObject({ status: 412 });
        expect(h.api.panel.get().phase).toBe("offline"); expect(h.api.panel.get().checkedAt).toBe(0);
        expect(h.access.get().ready).toBe(false); expect(h.api.panelPersonal.get().catalog.personalRecords[0].title).toBe("Original");
        h.api.disposePanel();
    });
    it.each(["vault_error", "connection_mismatch", "access_denied", "invalid_grant", "not_authenticated", "refresh_uncertain"])("clears all editor data immediately on terminal %s", async code => {
        const h = setup(); await h.api.connectPanel(); const generation = h.api.panelPersonal.get().generation;
        const action = h.api.preparePanelWrite(patch()); h.mutate.mockRejectedValueOnce(new PanelError(code));
        await expect(action()).rejects.toMatchObject({ code });
        expect(h.api.panelPersonal.get()).toMatchObject({ catalog: null, connectionId: "", busy: false });
        expect(h.api.panelPersonal.get().generation).toBeGreaterThan(generation);
        expect(h.access.get().ready).toBe(false); expect(h.store.templates).toEqual([]); h.api.disposePanel();
    });
    it("read-only restore remains usable until explicit upgrade and keeps management open for the code", async () => {
        const h = setup(false); h.state.saved = true; await h.api.restorePanel();
        const old = h.clients[0]; expect(old.options.writeAccess).toBe(false);
        expect(() => h.api.preparePanelWrite(patch())).toThrow(); expect(old.cancel).not.toHaveBeenCalled();
        expect(h.api.panel.get().phase).toBe("ready"); h.ui.set({ management: true });
        const wait = deferred<void>(); h.state.pendingLogin = wait.promise;
        const upgrade = h.api.authorizePanelEditing(); await vi.advanceTimersByTimeAsync(0);
        expect(h.api.panel.get().phase).toBe("pending"); expect(h.ui.get().management).toBe(true);
        expect(h.clients[1].options.writeAccess).toBe(true); expect(old.cancel).toHaveBeenCalledOnce();
        wait.resolve(); await upgrade; h.api.disposePanel();
    });
    it("fences stale account actions before send and ignores late mutation replies after revocation", async () => {
        const h = setup(); await h.api.connectPanel(); const action = h.api.preparePanelWrite(patch());
        h.state.discordId = "987654321098765432";
        await expect(action()).rejects.toMatchObject({ code: "cancelled" }); expect(h.mutate).not.toHaveBeenCalled();
        h.state.discordId = h.profile.accountId;
        const wait = deferred<unknown>(); h.mutate.mockReturnValueOnce(wait.promise);
        const saving = action().catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(0);
        h.streams[0].emit({ type: "session.revoked", data: {} }); wait.resolve({ template: h.row });
        expect(await saving).toMatchObject({ code: "cancelled" }); expect(h.api.panelPersonal.get().catalog).toBeNull(); h.api.disposePanel();
    });
    it("performs folder CRUD through server results and original If-Match", async () => {
        const h = setup(); await h.api.connectPanel();
        h.mutate.mockImplementation(async request => {
            if (request.method === "DELETE") { h.snapshot.folders = []; return { success: true }; }
            h.folder.title = "Renamed"; h.folder.version = "folder-next"; return { folder: structuredClone(h.folder) };
        });
        await h.api.preparePanelWrite({ path: "/folders/8", method: "PATCH", version: "folder-eight", body: { title: "Renamed", position: 3 } })();
        expect(h.api.panelPersonal.get().catalog.folderRecords[0].version).toBe("folder-next");
        await h.api.preparePanelWrite({ path: "/folders/8", method: "DELETE", version: "folder-next" })();
        expect(h.api.panelPersonal.get().catalog.folderRecords).toEqual([]); expect(h.writes).not.toHaveBeenCalled(); h.api.disposePanel();
    });
    it("rejects malformed success and makes no optimistic catalog change", async () => {
        const h = setup(); await h.api.connectPanel(); h.mutate.mockResolvedValueOnce({ success: true });
        await expect(h.api.preparePanelWrite(create())()).rejects.toMatchObject({ code: "invalid_response" });
        expect(h.api.panelPersonal.get().catalog.personalRecords).toHaveLength(1); h.api.disposePanel();
    });
});

describe("permission races through the controller and actual catalog parsers", () => {
    const date = "2026-10-18T00:00:00.000Z";
    const accountId = "123456789012345678";
    const profile = (permissionsRevision: string) => ({
        schemaVersion: 1, accountId, connectionId: "12345678-1234-1234-1234-123456789abc", name: "Support",
        projects: ["majestic"], scopes: ["profile:read", "faq:read", "personal:read", "folders:read", "sync:read"],
        permissionsRevision, minimumPluginVersion: "1.0.0", serverTime: date,
    });
    const snapshot = (permissionsRevision: string) => ({
        schemaVersion: 1, accountId, revision: permissionsRevision, permissionsRevision, serverTime: date, projects: ["majestic"],
        faq: [{ id: "majestic:7", version: "1", title: "FAQ", text: "<p>Answer</p>", format: "html", projects: ["majestic"],
            category: null, tags: [], status: "actual", updatedAt: date }],
        personal: [], folders: [], trash: [], colorLabels: {}, limits: { colors: [] },
    });
    function setup() {
        const get = vi.fn(async (path: string): Promise<unknown> => path === "/me" ? profile("1") : snapshot("1"));
        return { ...harness({ get }), get };
    }

    it("connects with the actual distribution version against the delivered API minimum", async () => {
        const { version } = JSON.parse(readFileSync(new URL("../distribution/config.json", import.meta.url), "utf8"));
        const h = harness({ get: async path => path === "/me" ? profile("1") : snapshot("1") }, version);
        await h.api.connectPanel();
        expect(h.api.panel.get().error).toBe("");
        expect(h.access.get().ready).toBe(true);
        expect(h.store.templates).toHaveLength(1);
        h.api.disposePanel();
    });

    it.each(["0.1.0-canary.16", "1.0.0-canary.17", "invalid"])("keeps rejecting %s below the delivered stable minimum", async version => {
        const h = harness({ get: async path => path === "/me" ? profile("1") : snapshot("1") }, version);
        await h.api.connectPanel();
        expect(h.access.get().ready).toBe(false);
        expect(h.api.panel.get().error).toContain("нужна новая версия");
        h.api.disposePanel();
    });

    it.each(["restorePanel", "connectPanel"])("overlaps initial reads during %s but publishes only after both validate", async action => {
        const h = setup(), me = deferred<unknown>(), data = deferred<unknown>();
        h.state.saved = true;
        h.get.mockImplementation(path => path === "/me" ? me.promise : data.promise);
        const starting = h.api[action](); await vi.advanceTimersByTimeAsync(0);
        expect(h.get.mock.calls.map(([path]) => path)).toEqual(["/me", "/snapshot"]);
        data.resolve(snapshot("1")); await vi.advanceTimersByTimeAsync(0);
        expect(h.access.get().ready).toBe(false); expect(h.store.templates).toEqual([]);
        expect(h.preferenceStorage.get).not.toHaveBeenCalled();
        me.resolve(profile("1")); await starting;
        expect(h.access.get().ready).toBe(true); expect(h.store.templates).toHaveLength(1);
        expect(h.get).toHaveBeenCalledTimes(2); h.api.disposePanel();
    });

    it.each(["/me", "/snapshot"])("does not hide delayed startup revocation on %s behind another read's network error", async route => {
        const h = setup(), revoked = deferred<unknown>();
        h.state.saved = true;
        h.get.mockImplementation(async path => {
            if (path === route) return revoked.promise;
            throw new PanelError("network_error");
        });
        const starting = h.api.restorePanel(); await vi.advanceTimersByTimeAsync(0);
        expect(h.access.get().ready).toBe(false);
        revoked.reject(new PanelError("session_revoked", 401)); await starting;
        expect(h.api.panel.get().phase).toBe("error"); expect(h.clients[0].cancel).toHaveBeenCalledOnce();
        expect(h.preferenceStorage.get).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(120000);
        expect(h.get).toHaveBeenCalledTimes(2); h.api.disposePanel();
    });

    it.each([
        { accountId: "987654321098765432" },
        { connectionId: "12345678-1234-1234-1234-123456789abd" },
        { scopes: ["profile:read"] },
        { minimumPluginVersion: "99.0.0" },
    ])("rejects an invalid startup profile despite a successful parallel snapshot: %j", async patch => {
        const h = setup(); h.state.saved = true;
        h.get.mockImplementation(async path => path === "/me" ? { ...profile("1"), ...patch } : snapshot("1"));
        await h.api.restorePanel();
        expect(h.api.panel.get().phase).toBe("error"); expect(h.access.get().ready).toBe(false);
        expect(h.store.templates).toEqual([]); expect(h.clients[0].cancel).toHaveBeenCalledOnce();
        expect(h.preferenceStorage.get).not.toHaveBeenCalled(); h.api.disposePanel();
    });

    it("retries a mismatched startup permissions pair before publishing", async () => {
        const h = setup(); h.state.saved = true;
        h.get.mockResolvedValueOnce(profile("1")).mockResolvedValueOnce(snapshot("2"))
            .mockResolvedValueOnce(profile("2")).mockResolvedValueOnce(snapshot("2"));
        await h.api.restorePanel();
        expect(h.get).toHaveBeenCalledTimes(4); expect(h.access.get().ready).toBe(true);
        expect(h.api.panelPersonal.get().catalog.permissionsRevision).toBe("2");
        expect(h.clients[0].cancel).not.toHaveBeenCalled(); h.api.disposePanel();
    });

    it.each(["logout", "account change"])("discards late initial reads after %s", async change => {
        const h = setup(), data = deferred<unknown>(); h.state.saved = true;
        h.get.mockImplementation(async path => path === "/me" ? profile("1") : data.promise);
        const starting = h.api.restorePanel(); await vi.advanceTimersByTimeAsync(0);
        if (change === "logout") await h.api.logoutPanel();
        else h.state.discordId = "987654321098765432";
        data.resolve(snapshot("1")); await starting;
        expect(h.access.get().ready).toBe(false); expect(h.store.templates).toEqual([]);
        expect(h.preferenceStorage.get).not.toHaveBeenCalled(); h.api.disposePanel();
    });

    it("blocks and clears the old catalog while retrying a fresh pair without cancelling auth", async () => {
        const h = setup(); await h.api.connectPanel();
        const wait = deferred<unknown>();
        h.get.mockResolvedValueOnce(profile("1")).mockResolvedValueOnce(snapshot("2"))
            .mockReturnValueOnce(wait.promise).mockResolvedValueOnce(snapshot("2"));
        const refresh = h.api.reloadPanel(); await vi.advanceTimersByTimeAsync(0);
        expect(h.access.get().ready).toBe(false); expect(h.store.templates).toEqual([]);
        expect(h.api.panel.get()).toMatchObject({ phase: "loading", checkedAt: 0 });
        expect(h.clients[0].cancel).not.toHaveBeenCalled();
        wait.resolve(profile("2")); await refresh;
        expect(h.get.mock.calls.map(([p]) => p)).toEqual(["/me", "/snapshot", "/me", "/snapshot", "/me", "/snapshot"]);
        expect(h.api.panel.get().phase).toBe("ready"); expect(h.access.get().ready).toBe(true);
        expect(h.store.templates).toHaveLength(1); expect(h.clients[0].cancel).not.toHaveBeenCalled();
        h.api.disposePanel();
    });

    it("stops after one retry, keeps access blocked and auth intact, and permits manual recovery", async () => {
        const h = setup(); await h.api.connectPanel();
        h.get.mockImplementation(async p => p === "/me" ? profile("1") : snapshot("2"));
        await h.api.reloadPanel();
        expect(h.get).toHaveBeenCalledTimes(6);
        expect(h.access.get()).toMatchObject({ ready: false, checkedAt: 0, projects: [] });
        expect(h.store.templates).toEqual([]); expect(h.api.panel.get().phase).toBe("offline");
        await vi.advanceTimersByTimeAsync(180000);
        expect(h.get).toHaveBeenCalledTimes(6); expect(h.clients[0].cancel).not.toHaveBeenCalled();
        expect(h.clients[0].logout).not.toHaveBeenCalled();
        h.get.mockImplementation(async p => p === "/me" ? profile("2") : snapshot("2"));
        await h.api.reloadPanel();
        expect(h.get).toHaveBeenCalledTimes(8); expect(h.api.panel.get().phase).toBe("ready");
        expect(h.access.get().ready).toBe(true); expect(h.clients[0].login).toHaveBeenCalledOnce();
        h.api.disposePanel();
    });

    it.each(["/me", "/snapshot"])("discards an invalidated %s response before the actual parser sees it", async route => {
        const h = setup(); await h.api.connectPanel();
        const wait = deferred<unknown>();
        if (route === "/snapshot") h.get.mockResolvedValueOnce(profile("1"));
        h.get.mockReturnValueOnce(wait.promise);
        const refresh = h.api.reloadPanel(); await vi.advanceTimersByTimeAsync(0);
        h.streams[0].emit({ type: "permissions.changed", data: {} });
        expect(h.access.get().ready).toBe(false);
        h.get.mockImplementation(async p => p === "/me" ? profile("2") : snapshot("2"));
        // Deliberately malformed: parsing this obsolete value would terminate the session.
        wait.resolve(null); await refresh; await vi.advanceTimersByTimeAsync(0);
        expect(h.api.panel.get().phase).toBe("ready"); expect(h.access.get().ready).toBe(true);
        expect(h.parsers.parseProfile).not.toHaveBeenCalledWith(null);
        expect(vi.mocked(h.parsers.parseSnapshot).mock.calls.some(([raw]) => raw === null)).toBe(false);
        expect(h.clients[0].cancel).not.toHaveBeenCalled(); h.api.disposePanel();
    });

    it.each([
        { code: "service_unavailable", status: 503, terminal: false },
        { code: "unauthorized", status: 401, terminal: true },
        { code: "session_revoked", status: 0, terminal: true },
        { code: "refresh_uncertain", status: 0, terminal: true },
    ])("handles delayed invalidated request errors: $code", async ({ code, status, terminal }) => {
        const h = setup(); await h.api.connectPanel();
        const wait = deferred<unknown>(); h.get.mockReturnValueOnce(wait.promise);
        const refresh = h.api.reloadPanel(); await vi.advanceTimersByTimeAsync(0);
        h.streams[0].emit({ type: "permissions.changed", data: {} });
        wait.reject(new PanelError(code, status));
        await refresh; await vi.advanceTimersByTimeAsync(0);
        expect(h.api.panel.get().phase).toBe(terminal ? "error" : "ready");
        expect(h.access.get().ready).toBe(!terminal);
        expect(h.clients[0].cancel).toHaveBeenCalledTimes(terminal ? 1 : 0);
        if (terminal) expect(h.store.templates).toEqual([]);
        h.api.disposePanel();
    });

    it.each([
        { accountId: "987654321098765432", permissionsRevision: "2" },
        { permissionsRevision: null },
    ])("does not classify identity/malformed snapshots as permission races: %j", async patch => {
        const h = setup(); await h.api.connectPanel();
        h.get.mockResolvedValueOnce(profile("1")).mockResolvedValueOnce({ ...snapshot("1"), ...patch });
        await h.api.reloadPanel();
        expect(h.get).toHaveBeenCalledTimes(4); expect(h.clients[0].cancel).toHaveBeenCalledOnce();
        expect(h.access.get().ready).toBe(false); expect(h.store.templates).toEqual([]);
        h.api.disposePanel();
    });

    it.each(["connect", "restore", "refresh"])("recovers malformed authenticated snapshot during %s without a new login", async mode => {
        // Fractional jitter must not let the timeout fire before the retryAt guard.
        vi.spyOn(Math, "random").mockReturnValue(0.50001);
        const h = setup();
        if (mode === "refresh") await h.api.connectPanel();
        h.state.saved = true;
        h.get.mockImplementation(async path => path === "/me" ? profile("1") : { ...snapshot("1"), faq: null });
        await h.api[mode === "connect" ? "connectPanel" : mode === "restore" ? "restorePanel" : "reloadPanel"]();
        expect(h.api.panel.get().phase).toBe("offline");
        expect(h.clients[0].cancel).not.toHaveBeenCalled();
        expect(h.clients[0].logout).not.toHaveBeenCalled();
        expect(h.access.get().ready).toBe(false);
        expect(await h.freshness()).toBe(false);
        expect(h.api.panel.get().persistent).toBe(true);
        const calls = h.get.mock.calls.length;
        await h.api.reloadPanel(); await h.api.reloadPanel();
        await vi.advanceTimersByTimeAsync(7999);
        expect(h.get).toHaveBeenCalledTimes(calls);
        h.get.mockImplementation(async path => path === "/me" ? profile("1") : snapshot("1"));
        await vi.advanceTimersByTimeAsync(4002);
        expect(h.get).toHaveBeenCalledTimes(calls + 2);
        expect(h.api.panel.get()).toMatchObject({ phase: "ready", error: "" });
        expect(await h.freshness()).toBe(true);
        expect(h.store.templates).toHaveLength(1);
        expect(h.clients).toHaveLength(1);
        expect(h.clients[0].login).toHaveBeenCalledTimes(mode === "restore" ? 0 : 1);
        h.api.disposePanel();
    });
});

describe("host permission before panel requests", () => {
    it.each(["required", "restart", "unavailable"])("does not start login or SSE when permission is %s", async result => {
        const h = harness(); h.permission.mockResolvedValue(result);
        await h.api.connectPanel();
        expect(h.permission).toHaveBeenCalledWith(true);
        expect(h.clients).toHaveLength(0); expect(h.open).not.toHaveBeenCalled();
        expect(h.streamReader).not.toHaveBeenCalled(); expect(h.access.get().ready).toBe(false);
        expect(h.api.panel.get().phase).toBe("error"); h.api.disposePanel();
    });
    it("leaves first launch idle without a permission prompt", async () => {
        const h = harness(); h.permission.mockResolvedValue("required");
        await h.api.restorePanel();
        expect(h.permission).toHaveBeenCalledWith(false);
        expect(h.api.panel.get().phase).toBe("idle"); expect(h.api.panel.get().error).toBe("");
        expect(h.clients).toHaveLength(0); h.api.disposePanel();
    });
    it("does not start login when the pending permission was cancelled by another action", async () => {
        const h = harness(), pending = deferred<string>();
        h.permission.mockReturnValue(pending.promise);
        const login = h.api.connectPanel(); await vi.advanceTimersByTimeAsync(0);
        await h.api.cancelPanelLogin(); pending.resolve("ready"); await login;
        expect(h.clients).toHaveLength(0); expect(h.open).not.toHaveBeenCalled(); h.api.disposePanel();
    });
});

describe("account preferences through the real panel controller", () => {
    it("restores favorites, bindings, ranking and list settings only with a fresh catalog after restart", async () => {
        const h = harness(); await h.api.connectPanel();
        h.store.toggleFavorite(template.id); h.store.setBind(template.id, "Ctrl+KeyQ"); h.store.markUsed(template.id);
        h.store.setTechProject("ro"); h.store.setPreviewOpen(true); h.store.setPrefix("!");
        await h.store.flush(); h.api.disposePanel();
        expect(h.store.templates).toEqual([]);
        h.state.saved = true; h.state.templates = [{ ...template, text: "Fresh answer" }];
        await h.api.restorePanel();
        expect(h.store.data.favorites).toEqual([template.id]);
        expect(h.store.bindFor(template.id)).toBe("Ctrl+KeyQ");
        expect(h.store.data.recent).toEqual([template.id]); expect(h.store.data.usage[template.id].n).toBe(1);
        expect(h.store.data.techProject).toBe("ro"); expect(h.store.data.previewOpen).toBe(true); expect(h.store.data.prefix).toBe("!");
        expect(h.store.templates[0].text).toBe("Fresh answer");
        await h.store.flush();
        const saved = JSON.stringify([...h.preferenceData.values()]);
        expect(saved).not.toContain("Answer"); expect(saved).not.toContain("Fresh answer");
        expect(saved).not.toContain('"personal"'); expect(saved).not.toContain('"raw"');
        expect(h.writes).not.toHaveBeenCalled(); h.api.disposePanel();
    });

    it("keeps preferences separate for two accounts even if their FAQ IDs match", async () => {
        const h = harness(); await h.api.connectPanel(); h.store.toggleFavorite(template.id); await h.store.flush();
        await h.api.logoutPanel(); h.state.discordId = h.state.profileId = "987654321098765432";
        await h.api.connectPanel(); expect(h.store.data.favorites).toEqual([]);
        h.store.setPrefix("!"); await h.store.flush(); await h.api.logoutPanel();
        h.state.discordId = h.state.profileId = "123456789012345678"; await h.api.connectPanel();
        expect(h.store.data.favorites).toEqual([template.id]); expect(h.store.data.prefix).toBe(";");
        expect(h.preferenceData.size).toBe(2); h.api.disposePanel();
    });

    it("ignores new settings edits in the retired store after logout or account switch", async () => {
        const h = harness(); await h.api.connectPanel();
        h.store.toggleFavorite(template.id); h.store.setBind(template.id, "Ctrl+KeyQ"); await h.store.flush();
        await h.api.logoutPanel(); h.store.setPrefix("!"); await h.store.flush();
        h.state.discordId = h.state.profileId = "987654321098765432";
        h.store.setTechProject("ro"); await h.store.flush();
        await h.api.connectPanel(); expect(h.store.data.favorites).toEqual([]); await h.api.logoutPanel();
        h.state.discordId = h.state.profileId = "123456789012345678"; await h.api.connectPanel();
        expect(h.store.data.favorites).toEqual([template.id]); expect(h.store.bindFor(template.id)).toBe("Ctrl+KeyQ");
        expect(h.store.data.prefix).toBe(";"); expect(h.store.data.techProject).toBe("mj"); h.api.disposePanel();
    });

    it("does not erase preferences during a permissions refresh that temporarily hides text", async () => {
        const h = harness(); await h.api.connectPanel(); h.store.toggleFavorite(template.id); await h.store.flush();
        const wait = deferred<unknown>(); h.state.pendingSnapshot = wait.promise;
        h.streams[0].emit({ type: "permissions.changed", data: {} }); await vi.advanceTimersByTimeAsync(0);
        expect(h.store.templates).toEqual([]); expect(h.access.get().ready).toBe(false);
        wait.resolve({ accountId: h.state.profileId, revision: "2", templates: [template], personal: [], folders: [] });
        await vi.advanceTimersByTimeAsync(0);
        expect(h.store.data.favorites).toEqual([template.id]);
        expect(h.access.get().ready).toBe(true); h.api.disposePanel();
    });

    it("permanently drops deleted references after a complete authoritative snapshot", async () => {
        const h = harness(); await h.api.connectPanel(); h.store.toggleFavorite(template.id);
        h.store.setBind(template.id, "Ctrl+KeyQ"); h.store.markUsed(template.id); await h.store.flush();
        h.state.templates = []; h.state.revision = "2"; await h.api.reloadPanel(); await h.store.flush();
        await h.api.logoutPanel(); h.state.templates = [template]; h.state.revision = "3";
        await h.api.connectPanel();
        expect(h.store.data.favorites).toEqual([]); expect(h.store.data.recent).toEqual([]);
        expect(h.store.data.binds).toEqual({}); expect(h.store.data.usage).toEqual({}); h.api.disposePanel();
    });

    it("never exposes saved references or text when session restoration is denied", async () => {
        const h = harness(); await h.api.connectPanel(); h.store.toggleFavorite(template.id); await h.store.flush();
        h.api.disposePanel(); h.state.restoreError = new PanelError("session_revoked", 401);
        h.preferenceStorage.get.mockClear(); await h.api.restorePanel();
        expect(h.store.templates).toEqual([]); expect(h.store.data.favorites).toEqual([]);
        expect(h.preferenceStorage.get).not.toHaveBeenCalled(); expect(h.access.get().ready).toBe(false);
    });

    it("does not overwrite saved preferences if reading storage fails", async () => {
        const h = harness(); await h.api.connectPanel(); h.store.toggleFavorite(template.id); await h.store.flush();
        h.api.disposePanel(); const before = structuredClone([...h.preferenceData]); h.io.readError = true;
        await h.api.connectPanel(); h.store.setPrefix("!"); await h.store.flush();
        expect(h.api.panel.get().phase).toBe("ready"); expect(h.api.panel.get().preferencesError).toBe("read");
        expect([...h.preferenceData]).toEqual(before);
        h.io.readError = false; await h.api.logoutPanel(); await h.api.connectPanel();
        expect(h.store.data.favorites).toEqual([template.id]); expect(h.api.panel.get().preferencesError).toBe("");
        h.api.disposePanel();
    });

    it("shows a write failure and retries unsaved edits without logging out", async () => {
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const h = harness(); await h.api.connectPanel(); await h.store.flush(); h.io.writeError = true;
            h.store.toggleFavorite(template.id); await expect(h.store.flush()).rejects.toThrow();
            expect(h.api.panel.get().preferencesError).toBe("write");
            h.io.writeError = false; await h.api.retryPanelPreferences();
            expect(h.api.panel.get().preferencesError).toBe("");
            await h.api.logoutPanel(); await h.api.connectPanel();
            expect(h.store.data.favorites).toEqual([template.id]); h.api.disposePanel();
        } finally { log.mockRestore(); }
    });

    it("discards a slow preference read after logout instead of republishing the catalog", async () => {
        const h = harness(); const wait = deferred<void>(); h.io.pendingRead = wait.promise;
        const login = h.api.connectPanel(); await vi.advanceTimersByTimeAsync(0);
        expect(h.preferenceStorage.get).toHaveBeenCalledOnce(); await h.api.logoutPanel();
        wait.resolve(); await login;
        expect(h.store.templates).toEqual([]); expect(h.access.get().ready).toBe(false);
        expect(h.preferenceStorage.set).not.toHaveBeenCalled();
    });

    it("waits for the last queued preference write before re-opening the same account", async () => {
        const h = harness(); await h.api.connectPanel(); await h.store.flush();
        const wait = deferred<void>(); h.io.pendingWrite = wait.promise;
        h.store.toggleFavorite(template.id); h.api.disposePanel();
        const reopen = h.api.connectPanel(); await vi.advanceTimersByTimeAsync(0);
        expect(h.access.get().ready).toBe(false);
        wait.resolve(); await reopen;
        expect(h.store.data.favorites).toEqual([template.id]); h.api.disposePanel();
    });
});

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
        const task = h.api.reloadPanel(); await h.api.logoutPanel(); late.resolve({ accountId: "123456789012345678" }); await task;
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
        const h = harness(); h.state.discordId = "987654321098765432"; await h.api.connectPanel();
        expect(h.api.panel.get().phase).toBe("error"); expect(h.store.templates).toEqual([]);
        expect(h.clients[0].get.mock.calls.map(([path]) => path)).toEqual(["/me", "/snapshot"]);
        expect(h.access.get().ready).toBe(false); expect(h.clients[0].cancel).toHaveBeenCalledOnce();
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
        old.resolve({ accountId: "123456789012345678", revision: "2", templates: [{ ...template, text: "Old answer" }], personal: [], folders: [] });
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
        h.reminders.stopTicketReminders.mockClear(); h.reminders.syncTicketReminders.mockClear();
        h.streams[0].emit({ type: "token.expired", data: {} }); h.streams[0].end();
        expect(h.reminders.stopTicketReminders).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(250);
        expect(h.clients[0].refreshForStream).toHaveBeenCalledOnce(); expect(h.streams).toHaveLength(2);
        expect(h.reminders.syncTicketReminders).toHaveBeenCalledOnce();
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
        expect(h.documentHandlers.size).toBe(0);
    });

    it("drops the previous account immediately on a UserStore change", async () => {
        const h = harness(); const off = h.api.startPanel(); await vi.advanceTimersByTimeAsync(0); await h.api.connectPanel();
        h.state.discordId = "987654321098765432"; for (const listener of h.accountHandlers) listener();
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
        const active = h.clients.at(-1)!; h.state.discordId = "987654321098765432";
        for (const listener of h.accountHandlers) listener();
        expect(h.api.panel.get().code).toBe(""); expect(active.logout).toHaveBeenCalledOnce();
        wait.resolve(); await connecting; expect(active.get).not.toHaveBeenCalled(); off();
    });
});
