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
        pendingLogout: null as Promise<void> | null, nowServer: "time-a", projects: ["mj"], permissions: "1", pendingSnapshot: null as Promise<unknown> | null };
    const clients: FakeClient[] = [];
    class FakeClient {
        connectionId = "connection";
        disposed = false;
        constructor() { clients.push(this); }
        login = vi.fn(async (device: (v: unknown) => void) => {
            device({ userCode: "ABCD", verificationUriComplete: "https://panel.majestic-rp.tech/connect?user_code=ABCD" });
            if (state.pendingLogin) await state.pendingLogin;
        });
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
    const deps: Record<string, unknown> = {
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: state.discordId }) }, FluxDispatcher: {
            subscribe: (name: string, fn: () => void) => handlers.set(name, fn), unsubscribe: (name: string) => handlers.delete(name) } },
        "../buildInfo": { PLUGIN_VERSION: "1.0.0" }, "../core/state": { Store },
        "../core/panelCatalog": { parseProfile: (v: unknown) => v, parseSnapshot: (v: unknown) => v },
        "../core/panelClient": { PanelClient: FakeClient, PanelError },
        "../core/panelProtocol": { PANEL_ORIGIN: "https://panel.majestic-rp.tech" },
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
    runInNewContext(compiled, { module, exports: module.exports, Date, setTimeout, clearTimeout, Math, window: { open },
        require: (name: string) => { if (!(name in deps)) throw new Error("Unexpected import " + name); return deps[name]; } });
    return { api: module.exports, store: routed.store, realStore, state, ui, access, clients, writes, open, handlers,
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
        const task = h.api.connectPanel(); await h.api.cancelPanelLogin(); wait.resolve(); await task;
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
        await h.api.connectPanel(); delayed.resolve(); await leaving;
        expect(h.api.panel.get().enabled).toBe(true); expect(h.api.panel.get().phase).toBe("ready");
        expect(h.store.catalogReadOnly).toBe(true);
    });
});
