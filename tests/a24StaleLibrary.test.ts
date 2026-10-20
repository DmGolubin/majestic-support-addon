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
            libraryIsFresh: () => access.get().ready && Date.now() >= access.get().checkedAt && ((access.get() as any).staleUntil ? Date.now() < (access.get() as any).staleUntil : Date.now() - access.get().checkedAt <= 30000),
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

function setup() {
    const date = "2026-10-18T00:00:00.000Z";
    const profile = { schemaVersion: 1, accountId: "123456789012345678", connectionId: "12345678-1234-1234-1234-123456789abc",
        name: "Support", projects: ["majestic", "russia-online"], permissionsRevision: "p1", minimumPluginVersion: "1.0.0", serverTime: date,
        scopes: ["profile:read", "faq:read", "personal:read", "folders:read", "sync:read", "personal:write", "folders:write"] };
    const row = { id: "7", version: "v1", title: "Personal", text: "PRIVATE_FAQ_NEVER_PERSISTED", format: "text",
        projects: ["majestic"], shared: false, command: null, color: null, folderId: null, updatedAt: date };
    const snapshot = { schemaVersion: 1, accountId: profile.accountId, revision: "r1", permissionsRevision: "p1", serverTime: date,
        projects: profile.projects, faq: [], personal: [row], folders: [], trash: [], limits: { colors: [] }, colorLabels: {} };
    const get = vi.fn(async (path: string): Promise<unknown> => structuredClone(path === "/me" ? profile : snapshot));
    const mutate = vi.fn(async (): Promise<unknown> => ({ template: row }));
    const h = harness({ get, mutate });
    const restore = () => get.mockImplementation(async path => structuredClone(path === "/me" ? profile : snapshot));
    return { ...h, profile, snapshot, get, mutate, restore };
}
const patch = (): PanelMutation => ({ path: "/personal-templates/7", method: "PATCH", version: "v1", body: { title: "Draft" } });

describe("A24 same-session stale library", () => {
    it.each(["network_error", "transport_error", "timeout", "request_timeout", "503", "429"])(
        "retains read/insert access and editor targets on %s, stops reminders, keeps credentials", async code => {
            const h = setup(); await h.api.connectPanel();
            const templates = [...h.store.templates], generation = h.generation(), version = h.store.setVersion;
            const until = Date.now() + 15 * 60 * 1000;
            h.ui.set({ compose: [templates[0].id], menu: { id: templates[0].id } as any });
            h.get.mockRejectedValue(new PanelError(code, code === "503" ? 503 : code === "429" ? 429 : 0));
            vi.setSystemTime(Date.now() + 31000);
            await h.api.reloadPanel();
            expect(h.api.panel.get()).toMatchObject({ phase: "ready", stale: true, staleUntil: until });
            expect(h.access.get()).toMatchObject({ ready: true, staleUntil: until });
            expect(await h.freshness()).toBe(true);
            expect(h.generation()).toBe(generation); expect(h.store.setVersion).toBe(version);
            expect(h.store.templates).toEqual(templates);
            expect(h.ui.get()).toMatchObject({ windowOpen: true, compose: [templates[0].id], menu: { id: templates[0].id } });
            expect(h.reminders.stopTicketReminders).toHaveBeenCalled();
            expect(h.reminders.syncTicketReminders.mock.calls.at(-1)![0].current()).toBe(false);
            expect(h.clients[0].cancel).not.toHaveBeenCalled();
            expect(() => h.api.preparePanelWrite(patch())).toThrow(expect.objectContaining({ code: "stale_library" }));
            expect(JSON.stringify([...h.preferenceData.values()])).not.toContain("PRIVATE_FAQ_NEVER_PERSISTED");
            h.api.disposePanel(); expect(vi.getTimerCount()).toBe(0);
        });
    it("blocks a captured write until a validated retry, then restores writes and reminders", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const h = setup(); await h.api.connectPanel();
        const action = h.api.preparePanelWrite(patch());
        h.get.mockRejectedValue(new PanelError("network_error"));
        await h.api.reloadPanel();
        await expect(action()).rejects.toMatchObject({ code: "stale_library" });
        expect(h.mutate).not.toHaveBeenCalled();
        h.restore(); await vi.advanceTimersByTimeAsync(10000);
        expect(h.api.panel.get()).toMatchObject({ phase: "ready", stale: false, staleUntil: 0, error: "" });
        expect(h.reminders.syncTicketReminders.mock.calls.at(-1)![0].current()).toBe(true);
        await expect(action()).resolves.toEqual({ refreshed: true });
        expect(h.mutate).toHaveBeenCalledOnce();
        h.api.disposePanel();
    });
    it("keeps the retained window and draft mounted throughout a pending reload", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const h = setup(); await h.api.connectPanel();
        h.get.mockRejectedValue(new PanelError("network_error")); await h.api.reloadPanel();
        const generation = h.generation(), pending = deferred<unknown>();
        const draft = { kind: "fields" } as any;
        h.ui.set({ dialog: draft, compose: [h.store.templates[0].id] });
        h.restore(); h.get.mockReturnValueOnce(pending.promise);
        await vi.advanceTimersByTimeAsync(10000);
        expect(h.api.panel.get()).toMatchObject({ phase: "ready", stale: true });
        expect(h.ui.get().dialog).toBe(draft);
        expect(h.ui.get().windowOpen).toBe(true); expect(h.generation()).toBe(generation);
        pending.resolve(h.profile); await vi.advanceTimersByTimeAsync(0);
        expect(h.api.panel.get()).toMatchObject({ phase: "ready", stale: false });
        expect(h.ui.get().dialog).toBe(draft); expect(h.generation()).toBe(generation);
        h.api.disposePanel();
    });
    it("never carries the lease into a new login whose host permission is denied", async () => {
        const h = setup(); await h.api.connectPanel();
        h.get.mockRejectedValue(new PanelError("network_error")); await h.api.reloadPanel();
        h.permission.mockResolvedValue("required");
        await h.api.connectPanel();
        expect(h.access.get().ready).toBe(false); expect(h.store.templates).toEqual([]);
        expect(h.api.panel.get()).toMatchObject({ phase: "error", stale: false, staleUntil: 0 });
        expect(h.clients[0].cancel).toHaveBeenCalledOnce(); h.api.disposePanel();
    });
    it("never extends the deadline through retries or use; expires even during a long Retry-After", async () => {
        const h = setup(); await h.api.connectPanel();
        const start = Date.now();
        h.get.mockRejectedValue(new PanelError("rate_limited", 429, 2 * 60 * 60 * 1000));
        await h.api.reloadPanel();
        const calls = h.get.mock.calls.length;
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1);
        expect(await h.freshness()).toBe(true);
        expect(h.api.panel.get().staleUntil).toBe(start + 15 * 60 * 1000);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.access.get().ready).toBe(false); expect(await h.freshness()).toBe(false);
        expect(h.store.templates).toEqual([]);
        expect(h.api.panel.get()).toMatchObject({ phase: "offline", stale: false, staleUntil: 0 });
        expect(h.get).toHaveBeenCalledTimes(calls);
        expect(h.clients[0].cancel).not.toHaveBeenCalled();
        h.api.disposePanel();
    });
    it.each([new PanelError("network_error"), new PanelError("service_unavailable", 503)])(
        "does not grant stale access on startup failure", async error => {
            const h = setup(); h.get.mockRejectedValue(error); await h.api.connectPanel();
            expect(h.api.panel.get()).toMatchObject({ phase: "offline", stale: false });
            expect(h.access.get().ready).toBe(false); expect(await h.freshness()).toBe(false);
            expect(h.store.templates).toEqual([]); h.api.disposePanel();
        });
    it.each([
        new PanelError("unauthorized", 401), new PanelError("forbidden", 403),
        new PanelError("session_revoked"), new PanelError("refresh_uncertain"), new PanelError("invalid_grant"),
        new PanelError("invalid_token"), new PanelError("reauthentication_required"), new PanelError("account_mismatch"),
    ])("auth failures always remove stale access: %j", async error => {
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const h = setup(); await h.api.connectPanel();
        h.get.mockRejectedValue(new PanelError("network_error")); await h.api.reloadPanel();
        h.get.mockRejectedValue(error); await vi.advanceTimersByTimeAsync(10000);
        expect(h.api.panel.get()).toMatchObject({ phase: "error", stale: false, staleUntil: 0 });
        expect(h.access.get().ready).toBe(false); expect(h.store.templates).toEqual([]);
        expect(h.clients[0].cancel).toHaveBeenCalledOnce(); h.api.disposePanel();
    });
    it.each(["permissions", "projects", "scopes"])("changed %s before a failed snapshot cannot reuse old data", async change => {
        const h = setup(); await h.api.connectPanel();
        if (change === "permissions") h.profile.permissionsRevision = "p2";
        if (change === "projects") h.profile.projects = ["russia-online"];
        if (change === "scopes") h.profile.scopes = h.profile.scopes.filter(s => s !== "personal:write");
        h.get.mockImplementation(async path => {
            if (path === "/me") return structuredClone(h.profile);
            throw new PanelError("network_error");
        });
        await h.api.reloadPanel();
        expect(h.api.panel.get()).toMatchObject({ phase: "offline", stale: false });
        expect(h.store.templates).toEqual([]); expect(await h.freshness()).toBe(false);
        h.api.disposePanel();
    });
    it.each(["permissions.changed", "library.changed", "resync.required", "session.revoked", "token.expired"])(
        "stream %s invalidates a retained lease synchronously", async type => {
            const h = setup(); await h.api.connectPanel();
            h.get.mockRejectedValue(new PanelError("network_error")); await h.api.reloadPanel();
            h.streams[0].emit({ type, data: {} });
            expect(h.access.get().ready).toBe(false);
            expect(h.api.panel.get()).toMatchObject({ stale: false, staleUntil: 0 });
            expect(await h.freshness()).toBe(false); h.api.disposePanel();
        });
    it.each(["logout", "account", "dispose"])("never carries retained data across %s", async action => {
        const h = setup(); h.api.startPanel(); await h.api.connectPanel();
        h.get.mockRejectedValue(new PanelError("network_error")); await h.api.reloadPanel();
        if (action === "logout") await h.api.logoutPanel();
        if (action === "account") {
            h.state.discordId = "223456789012345678";
            for (const listener of h.accountHandlers) listener();
        }
        if (action === "dispose") h.api.disposePanel();
        expect(h.access.get().ready).toBe(false);
        expect(h.store.templates).toEqual([]);
        expect(h.api.panel.get()).toMatchObject({ stale: false, staleUntil: 0 });
        h.api.disposePanel();
    });
    it("a corrupt catalog remains fail-closed rather than reusing the last valid data", async () => {
        const h = setup(); await h.api.connectPanel();
        h.get.mockImplementation(async path => {
            if (path === "/me") return h.profile;
            throw new PanelCatalogValidationError("data");
        });
        await h.api.reloadPanel();
        expect(h.api.panel.get()).toMatchObject({ phase: "offline", stale: false });
        expect(h.access.get().ready).toBe(false); expect(await h.freshness()).toBe(false);
        h.api.disposePanel();
    });
    it.each(["network_error", "request_timeout", "service_unavailable", "eof"])(
        "SSE %s preserves the fresh GET reminder fallback and library binding", async failure => {
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const h = setup(); await h.api.connectPanel();
        const gen = h.generation(), binding = h.reminders.syncTicketReminders.mock.calls.at(-1)![0];
        h.reminders.stopTicketReminders.mockClear();
        h.reminders.invalidateTicketReminders.mockClear();
        h.reminders.syncTicketReminders.mockClear();
        h.get.mockClear();
        if (failure === "eof") h.streams[0].end();
        else h.streams[0].fail(new PanelError(failure, failure === "service_unavailable" ? 503 : 0));
        await vi.advanceTimersByTimeAsync(0);
        expect(h.api.panel.get()).toMatchObject({ phase: "ready", stale: false, staleUntil: 0, sync: "retrying" });
        expect(h.generation()).toBe(gen);
        expect(binding.current()).toBe(true);
        expect(h.reminders.stopTicketReminders).not.toHaveBeenCalled();
        expect(h.reminders.invalidateTicketReminders).not.toHaveBeenCalled();
        expect(h.reminders.syncTicketReminders).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(60000);
        expect(h.get.mock.calls.map(([path]) => path)).toEqual(["/me", "/snapshot"]);
        expect(binding.current()).toBe(true);
        expect(h.reminders.stopTicketReminders).not.toHaveBeenCalled();
        // Actual library transport failure still pauses reminders immediately.
        h.get.mockRejectedValue(new PanelError("network_error"));
        await h.api.reloadPanel();
        expect(h.api.panel.get().stale).toBe(true);
        expect(h.reminders.stopTicketReminders).toHaveBeenCalledOnce();
        expect(h.reminders.syncTicketReminders.mock.calls.at(-1)![0].current()).toBe(false);
        h.api.disposePanel();
    });
});

describe("A24 actual synchronous insertion gates", () => {
    it("inserts through the actual flow after a transient refresh failure, but refuses after expiry", async () => {
        const h = setup(); await h.api.connectPanel();
        const template = h.store.templates[0];
        h.get.mockRejectedValue(new PanelError("network_error"));
        vi.setSystemTime(Date.now() + 31000);
        const source = ts.createSourceFile("flow.ts", readFileSync(new URL("../src/vencord/ui/flow.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
        const names = ["snapNow", "stillCurrent", "scopeHere", "prepareText", "insertTemplate"];
        const selected = source.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && !!s.name && names.includes(s.name.text));
        const code = ts.transpileModule(selected.map(s => s.getText(source)).join("\n"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText;
        const insertText = vi.fn(() => true);
        const fresh = () => {
            const p = h.access.get() as any, age = Date.now() - p.checkedAt;
            return p.ready && age >= 0 && (p.staleUntil ? Date.now() < p.staleUntil : age <= 30000);
        };
        const api = runInNewContext(code + "\n({ insertTemplate })", { exports: {}, preparationSequence: 0, dialogSequence: 0,
            store: h.store, ui: h.ui, generationNow: h.generation, currentChannel: () => ({ id: "channel" }),
            activeScope: () => h.access.get().ready ? "mj" : null, currentMode: () => "mj",
            targetNow: () => ({ editor: { isConnected: true, textContent: "draft" }, selection: "" }),
            libraryIsFresh: fresh, ensureLibraryFresh: h.freshness, guard: async (t: unknown) => t,
            stripMarker: (text: string) => text, fillFields: async (_title: string, text: string) => text,
            focusTarget: vi.fn(), insertText, dlog: vi.fn(), toast: vi.fn() });
        await api.insertTemplate(template);
        expect(insertText).toHaveBeenCalledExactlyOnceWith(template.text);
        expect(h.api.panel.get().stale).toBe(true);
        vi.setSystemTime(h.api.panel.get().staleUntil);
        await api.insertTemplate(template);
        expect(insertText).toHaveBeenCalledTimes(1);
        h.api.disposePanel();
    });
    it("checks retained deadline, account and project even if the expiry timer was suspended", () => {
        const file = "../src/vencord/ui/uiState.ts";
        const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
        const names = ["libraryIsFresh", "activeScope"];
        const functions = source.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && !!s.name && names.includes(s.name.text));
        const code = ts.transpileModule(functions.map(s => s.getText(source)).join("\n"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText;
        const access = { enabled: true, ready: true, accountId: "123", projects: ["mj"], checkedAt: 1000, staleUntil: 901000 };
        let now = 100000, id = "123", mode = "mj";
        const api = runInNewContext(code + "\n({ libraryIsFresh, activeScope })", { exports: {}, Date: { now: () => now },
            panelAccess: { get: () => access }, UserStore: { getCurrentUser: () => ({ id }) },
            currentMode: () => mode, demoAccess: { get: () => ({ enabled: false }) } });
        expect(api.libraryIsFresh()).toBe(true); expect(api.activeScope()).toBe("mj");
        mode = "ro"; expect(api.activeScope()).toBeNull(); mode = "mj";
        id = "456"; expect(api.libraryIsFresh()).toBe(false); expect(api.activeScope()).toBeNull(); id = "123";
        now = 901000; expect(api.libraryIsFresh()).toBe(false); expect(api.activeScope()).toBeNull();
        now = 999; expect(api.libraryIsFresh()).toBe(false); expect(api.activeScope()).toBeNull();
        now = 100000; access.ready = false; expect(api.libraryIsFresh()).toBe(false);
    });
});

