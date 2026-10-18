import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelClient, PanelError, PanelTransport } from "../src/core/panelClient";
import { PANEL_ORIGIN } from "../src/core/panelProtocol";
import { Store } from "../src/core/state";
import { createPanelVault } from "../src/vencord/panelVault";

const account = "123456789012345678";
const connection = "12345678-1234-1234-1234-123456789abc";
const scopes = "profile:read faq:read personal:read folders:read sync:read";
const compiled = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/panel.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
};
function observable<T extends object>(value: T) {
    return { get: () => value, set: (patch: Partial<T>) => { value = { ...value, ...patch }; } };
}

// Real client and renderer vault adapter; only IPC, HTTP and Discord UI are replaced.
// No OS storage, production requests, or synthetic secrets are printed.
function harness() {
    let saved: unknown = null;
    const state = { saveWait: null as Promise<void> | null, revokeWait: null as Promise<void> | null };
    const native = {
        panelVaultAvailable: vi.fn(async () => true),
        panelVaultLoad: vi.fn(async () => structuredClone(saved)),
        panelVaultSave: vi.fn(async (_account: string, record: unknown) => {
            if (state.saveWait) await state.saveWait;
            saved = structuredClone(record);
        }),
        panelVaultClear: vi.fn(async () => { saved = null; })
    };
    vi.stubGlobal("VencordNative", { pluginHelpers: { SupportTemplates: native } });
    const transport = vi.fn<PanelTransport>(async path => {
        if (path === "/oauth/device_authorization") return {
            device_code: "fixture-device", user_code: "TEST-CODE", verification_uri: PANEL_ORIGIN + "/connect",
            verification_uri_complete: PANEL_ORIGIN + "/connect?user_code=TEST-CODE", expires_in: 600, interval: 5
        };
        if (path === "/oauth/token") return {
            access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer",
            expires_in: 900, scope: scopes, connectionId: connection
        };
        if (path === "/oauth/revoke") { if (state.revokeWait) await state.revokeWait; return {}; }
        if (path === "/device-requests/cancel") return {};
        if (path === "/me") return { accountId: account, connectionId: connection, minimumPluginVersion: "1.0.0",
            projects: ["mj"], scopes: scopes.split(" "), permissionsRevision: "1", name: "Fixture" };
        if (path === "/snapshot") return { accountId: account, revision: "1", permissionsRevision: "1",
            templates: [], personal: [], folders: [] };
        throw new Error("Unexpected mock endpoint");
    });
    const access = observable({ ready: false, checkedAt: 0 });
    const local = new Store({ get: async () => undefined, set: async () => {} });
    let selected = local;
    const events = new Map<string, () => void>();
    const windowEvents = new Map<string, () => void>();
    const deps: Record<string, unknown> = {
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: account }), addChangeListener() {}, removeChangeListener() {} },
            FluxDispatcher: { subscribe: (n: string, fn: () => void) => events.set(n, fn), unsubscribe: (n: string) => events.delete(n) } },
        "../buildInfo": { PLUGIN_VERSION: "1.0.0" }, "../core/state": { Store },
        "../core/panelClient": { PanelClient, PanelError }, "../core/panelProtocol": { PANEL_ORIGIN },
        "../panelVault": { createPanelVault }, "../core/panelTransport": { createPanelTransport: () => transport },
        "../core/panelCatalog": { parseProfile: (v: unknown) => v, parseSnapshot: (v: unknown) => v },
        "../panelHtml": { htmlToDiscordText: () => "" },
        "../core/panelEvents": { createPanelEventStream: () => async (_token: string, signal: AbortSignal) => {
            if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        } },
        "./demo": { disableDemo() {}, enableDemo() {} },
        "./flow": { confirmedForeign: new Set(), supersede() {} }, "./observable": { createObservable: observable },
        "./op": { nextGeneration() {}, captureWindowTarget() {}, windowEditor: () => null },
        "./uiState": { panelAccess: access, realStore: local, selectStore: (s: Store) => { selected = s; },
            ui: observable({}), setFreshnessCheck() {},
            libraryIsFresh: () => access.get().ready && Date.now() - access.get().checkedAt <= 30000 }
    };
    const module = { exports: {} as any };
    runInNewContext(compiled, { module, exports: module.exports, Date, Math, AbortController, setTimeout, clearTimeout,
        window: { open() {}, addEventListener: (n: string, fn: () => void) => windowEvents.set(n, fn),
            removeEventListener: (n: string) => windowEvents.delete(n) },
        require: (name: string) => { if (!(name in deps)) throw new Error("Unexpected import " + name); return deps[name]; } });
    return { api: module.exports, state, native, transport, windowEvents, localSelected: () => selected === local,
        saved: () => saved };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-18T00:00:00Z")); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("session boundaries across real controller, auth client and renderer vault", () => {
    it("keeps an unfinished device login alive when Discord regains focus", async () => {
        const h = harness(); const off = h.api.startPanel(); await vi.advanceTimersByTimeAsync(0);
        const login = h.api.connectPanel(); await vi.advanceTimersByTimeAsync(0);
        expect(h.api.panel.get().phase).toBe("pending");
        h.windowEvents.get("focus")!(); await vi.advanceTimersByTimeAsync(0);
        const phase = h.api.panel.get().phase;
        await h.api.cancelPanelLogin(); await login; off();
        expect(phase).toBe("pending");
    });

    it("completes an explicit local-library switch despite focus during remote logout", async () => {
        const h = harness(); const login = h.api.connectPanel(); await vi.advanceTimersByTimeAsync(5000); await login;
        const off = h.api.startPanel();
        const revoke = deferred<void>(); h.state.revokeWait = revoke.promise;
        const switching = h.api.useLocalLibrary(); await vi.advanceTimersByTimeAsync(0);
        h.windowEvents.get("focus")!(); await vi.advanceTimersByTimeAsync(0);
        revoke.resolve(); await switching; await vi.advanceTimersByTimeAsync(0);
        const selected = h.localSelected(), enabled = h.api.panel.get().enabled;
        off(); h.api.disposePanel();
        expect(selected).toBe(true); expect(enabled).toBe(false);
    });

    it("does not restore an unfinished login write after stop and a fresh vault handle", async () => {
        const h = harness(); const save = deferred<void>(); h.state.saveWait = save.promise;
        const login = h.api.connectPanel(); await vi.advanceTimersByTimeAsync(5000);
        expect(h.native.panelVaultSave).toHaveBeenCalledOnce();
        h.api.disposePanel();
        const restoring = h.api.restorePanel(); await vi.advanceTimersByTimeAsync(0);
        save.resolve(); await login; await restoring; await vi.advanceTimersByTimeAsync(0);
        const phase = h.api.panel.get().phase, saved = h.saved();
        h.api.disposePanel();
        expect(phase).toBe("idle"); expect(saved).toBeNull();
    });
});
