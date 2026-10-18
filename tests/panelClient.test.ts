import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelClient, PanelClientOptions, PanelError, PanelTransport, PanelVault } from "../src/core/panelClient";
import { PANEL_ORIGIN } from "../src/core/panelProtocol";

const scopes = "profile:read faq:read personal:read folders:read sync:read";
const connection = "12345678-1234-1234-1234-123456789abc";
const device = (overrides = {}) => ({
    device_code: "test-device", user_code: "TEST-CODE", verification_uri: PANEL_ORIGIN + "/connect",
    verification_uri_complete: PANEL_ORIGIN + "/connect?user_code=TEST-CODE", expires_in: 600, interval: 5, ...overrides,
});
const tokens = (overrides = {}) => ({
    access_token: "test-access-A", refresh_token: "test-refresh-A", token_type: "Bearer", expires_in: 900,
    scope: scopes, connectionId: connection, ...overrides,
});
const rotated = () => tokens({ access_token: "test-access-B", refresh_token: "test-refresh-B" });
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (value: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const outcome = (promise: Promise<unknown>) => promise.then(value => ({ value, error: null }), error => ({ value: undefined, error }));
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const grant = (options: Parameters<PanelTransport>[1]) => (options.body as { grant_type?: string } | undefined)?.grant_type;

function harness(overrides: { device?: unknown; tokens?: unknown; timeout?: number; options?: PanelClientOptions } = {}) {
    const transport = vi.fn<PanelTransport>(async (path, options) => {
        if (path === "/oauth/device_authorization") return overrides.device ?? device();
        if (path === "/oauth/token") return grant(options) === "refresh_token" ? rotated() : overrides.tokens ?? tokens();
        if (path === "/me") return { accountId: "test-account", connectionId: connection };
        return { success: true };
    });
    const client = new PanelClient(transport, { requestTimeoutMs: overrides.timeout, ...overrides.options });
    const onDevice = vi.fn();
    const login = async () => {
        const result = client.login(onDevice);
        await tick(5000);
        await result;
    };
    const refreshCalls = () => transport.mock.calls.filter(([path, options]) => path === "/oauth/token" && grant(options) === "refresh_token");
    return { client, transport, onDevice, login, refreshCalls };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("PanelClient device login", () => {
    it("opens the deployed public-site code link and continues polling through the API transport", async () => {
        const h = harness({ device: device({ verification_uri: "https://majestic-rp.tech/connect",
            verification_uri_complete: "https://majestic-rp.tech/connect?code=TEST-CODE" }) });
        await h.login();
        expect(h.onDevice).toHaveBeenCalledWith(expect.objectContaining({
            verificationUriComplete: "https://majestic-rp.tech/connect?code=TEST-CODE"
        }));
        expect(h.transport.mock.calls.map(([path]) => path)).toEqual(["/oauth/device_authorization", "/oauth/token"]);
        expect(h.client.connectionId).toBe(connection);
    });
    it("requests only read scopes, waits the advertised interval, then authorizes GET", async () => {
        const h = harness();
        expect(h.client.connectionId).toBeNull();
        const pending = h.client.login(h.onDevice);
        await tick();
        expect(h.transport).toHaveBeenCalledTimes(1);
        expect(h.transport.mock.calls[0]).toEqual(["/oauth/device_authorization", {
            body: { client_id: "support-templates", device_name: "Discord — SupportTemplates", scope: scopes }, signal: expect.any(AbortSignal),
        }]);
        expect(h.onDevice).toHaveBeenCalledWith(expect.objectContaining({ userCode: "TEST-CODE", interval: 5, expiresIn: 600 }));
        await tick(4999);
        expect(h.transport).toHaveBeenCalledTimes(1);
        await tick(1); await pending;
        expect(h.client.connectionId).toBe(connection);
        expect(await h.client.get("/me")).toEqual({ accountId: "test-account", connectionId: connection });
        expect(h.transport).toHaveBeenLastCalledWith("/me", { token: "test-access-A", signal: expect.any(AbortSignal) });
        expect(JSON.stringify(h.client)).toBe("{}");
    });

    it("keeps the pending interval, increases slow_down by five seconds, and honors Retry-After", async () => {
        const h = harness();
        const times: number[] = [];
        h.transport.mockImplementation(async (path) => {
            if (path === "/oauth/device_authorization") return device();
            times.push(Date.now());
            if (times.length === 1) throw new PanelError("authorization_pending", 400);
            if (times.length === 2) throw new PanelError("slow_down", 400);
            if (times.length === 3) throw new PanelError("slow_down", 400, 20_000);
            return tokens();
        });
        const pending = h.client.login(h.onDevice);
        await tick(39_999);
        expect(times).toEqual([5000, 10000, 20000]);
        await tick(1); await pending;
        expect(times).toEqual([5000, 10000, 20000, 40000]);
    });

    it.each(["access_denied", "expired_token"])("terminates on %s without polling again", async code => {
        const h = harness();
        h.transport.mockImplementation(async path => {
            if (path === "/oauth/device_authorization") return device();
            throw new PanelError(code, 400);
        });
        const result = outcome(h.client.login(h.onDevice));
        await tick(5000);
        expect((await result).error).toMatchObject({ code, status: 400 });
        await tick(60_000);
        expect(h.transport).toHaveBeenCalledTimes(2);
        expect(h.client.connectionId).toBeNull();
    });

    it("expires locally at the deadline without making another token request", async () => {
        const h = harness();
        h.transport.mockImplementation(async path => {
            if (path === "/oauth/device_authorization") return device({ expires_in: 12 });
            throw new PanelError("authorization_pending", 400);
        });
        const result = outcome(h.client.login(h.onDevice));
        await tick(12_000);
        expect((await result).error).toMatchObject({ code: "expired_token" });
        expect(h.transport).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not let the callback mutate the private device request", async () => {
        const h = harness();
        const pending = h.client.login(d => { d.deviceCode = "mutated"; d.interval = 1; });
        await tick(5000); await pending;
        expect(h.transport.mock.calls[1][1].body).toMatchObject({ device_code: "test-device" });
    });

    it("cancels a pending attempt and an already exchanged attempt through the device endpoint", async () => {
        const h = harness();
        const result = outcome(h.client.login(h.onDevice));
        await tick();
        await h.client.cancel();
        expect((await result).error).toMatchObject({ code: "cancelled" });
        expect(h.transport).toHaveBeenLastCalledWith("/device-requests/cancel", { body: { device_code: "test-device" }, signal: expect.any(AbortSignal) });
        expect(vi.getTimerCount()).toBe(0);
        await h.login();
        const cancel = h.client.cancel();
        expect(h.client.connectionId).toBeNull();
        await cancel;
        expect(h.transport).toHaveBeenLastCalledWith("/device-requests/cancel", expect.any(Object));
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "not_authenticated" });
    });

    it("aborts an in-flight exchange and rejects late success even if transport ignores abort", async () => {
        const h = harness();
        const exchange = deferred<unknown>();
        h.transport.mockImplementation(async path => path === "/oauth/device_authorization" ? device() : path === "/oauth/token" ? exchange.promise : {});
        const result = outcome(h.client.login(h.onDevice));
        await tick(5000);
        const signal = h.transport.mock.calls[1][1].signal!;
        await h.client.cancel();
        expect(signal.aborted).toBe(true);
        exchange.resolve(tokens()); await tick();
        expect((await result).error).toMatchObject({ code: "cancelled" });
        expect(h.client.connectionId).toBeNull();
    });

    it("a new login cancels the old attempt and ignores its late response", async () => {
        const h = harness();
        const exchange = deferred<unknown>();
        let tokenCalls = 0;
        h.transport.mockImplementation(async path => {
            if (path === "/oauth/device_authorization") return device();
            if (path === "/oauth/token") return ++tokenCalls === 1 ? exchange.promise : tokens({ connectionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
            return {};
        });
        const old = outcome(h.client.login(h.onDevice)); await tick(5000);
        const next = h.client.login(h.onDevice); await tick(5000); await next;
        exchange.resolve(tokens()); await tick();
        expect((await old).error).toMatchObject({ code: "cancelled" });
        expect(h.client.connectionId).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        expect(h.transport.mock.calls.some(([path]) => path === "/device-requests/cancel")).toBe(true);
    });

    it("dispose interrupts timers locally without making a cancellation request", async () => {
        const h = harness();
        const result = outcome(h.client.login(h.onDevice)); await tick();
        h.client.dispose();
        expect((await result).error).toMatchObject({ code: "cancelled" });
        expect(vi.getTimerCount()).toBe(0);
        expect(h.transport).toHaveBeenCalledTimes(1);
    });

    it("cancel reports remote failure while keeping local auth cleared", async () => {
        const h = harness(); await h.login();
        h.transport.mockRejectedValueOnce(new PanelError("plugin_disabled", 503, 10000));
        await expect(h.client.cancel()).rejects.toMatchObject({ code: "plugin_disabled", status: 503, retryAfterMs: 10000 });
        expect(h.client.connectionId).toBeNull();
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "not_authenticated" });
    });

    it("rejects invalid responses without leaking raw exception messages", async () => {
        const h = harness({ tokens: tokens({ access_token: "invalid token SECRET" }) });
        const result = outcome(h.client.login(h.onDevice)); await tick(5000);
        const error = (await result).error;
        expect(error).toMatchObject({ code: "invalid_response", message: "Panel request failed." });
        expect(JSON.stringify(error)).not.toContain("SECRET");
        expect(h.client.connectionId).toBeNull();
    });
});

const discordAccount = "123456789012345678";
function memoryVault(initial: unknown = null) {
    let record = structuredClone(initial);
    const put = (value: unknown) => { record = structuredClone(value); };
    const vault = {
        load: vi.fn<PanelVault["load"]>(async () => structuredClone(record)),
        save: vi.fn<PanelVault["save"]>(async value => { put(value); }),
        clear: vi.fn<PanelVault["clear"]>(async () => { record = null; }),
    };
    return { vault, put, read: () => structuredClone(record), options: { vault, accountId: discordAccount } };
}

describe("PanelClient durable session vault", () => {
    it("publishes a login only after the complete bound pair is durable", async () => {
        const v = memoryVault(), h = harness({ options: v.options }), saved = deferred<void>();
        v.vault.save.mockImplementationOnce(async record => { await saved.promise; v.put(record); });
        const login = h.client.login(h.onDevice); await tick(5000);
        expect(h.client.connectionId).toBeNull();
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "not_authenticated" });
        expect(v.read()).toBeNull();
        saved.resolve(); await login;
        expect(v.read()).toEqual({ version: 1, state: "ready", origin: PANEL_ORIGIN, clientId: "support-templates",
            accountId: discordAccount, expiresAt: 905000, tokens: {
                accessToken: "test-access-A", refreshToken: "test-refresh-A", expiresIn: 900,
                connectionId: connection, scopes: scopes.split(" "),
            } });
        expect(h.client.connectionId).toBe(connection);
    });

    it("preserves saved auth on ordinary disposal and restores without network IO or exposed credentials", async () => {
        const v = memoryVault(), h = harness({ options: v.options }); await h.login();
        const saved = v.read(); h.client.dispose(); expect(v.read()).toEqual(saved);
        const next = harness({ options: v.options });
        expect(await next.client.restore()).toBe(true);
        expect(next.transport).not.toHaveBeenCalled();
        expect(next.client.connectionId).toBe(connection);
        expect(JSON.stringify(next.client)).toBe("{}");
        await next.client.get("/me");
        expect(next.transport).toHaveBeenLastCalledWith("/me", expect.objectContaining({ token: "test-access-A" }));
    });

    it("restores an expired access token but rotates once before authorized use", async () => {
        const v = memoryVault(), h = harness({ options: v.options, tokens: tokens({ expires_in: 1 }) });
        await h.login(); h.client.dispose(); await tick(1000);
        const next = harness({ options: v.options });
        expect(await next.client.restore()).toBe(true);
        expect(next.transport).not.toHaveBeenCalled();
        await Promise.all([next.client.get("/me"), next.client.get("/snapshot")]);
        expect(next.refreshCalls()).toHaveLength(1);
        expect(v.read()).toMatchObject({ state: "ready", tokens: { refreshToken: "test-refresh-B" } });
    });

    it.each([
        { version: 2 }, { origin: "https://example.invalid" }, { clientId: "other" },
        { accountId: "987654321098765432" }, { state: "rotating" }, { expiresAt: Infinity },
        { expiresAt: -1 }, { expiresAt: 10_000_000 }, { tokens: {} }, { tokens: null },
    ])("discards invalid or mismatched persisted records %j", async patch => {
        const v = memoryVault(), h = harness({ options: v.options }); await h.login(); h.client.dispose();
        v.put({ ...(v.read() as object), ...patch });
        const next = harness({ options: v.options });
        expect(await next.client.restore()).toBe(false);
        expect(v.read()).toBeNull(); expect(next.client.connectionId).toBeNull();
        expect(next.transport).not.toHaveBeenCalled();
    });

    it("requires a string snowflake with a vault and treats an absent vault as memory-only", async () => {
        const v = memoryVault();
        for (const accountId of [undefined, "", "account", "0", "1", "1e18", "123 456", "18446744073709551616"]) {
            expect(() => new PanelClient(vi.fn(), { vault: v.vault, accountId })).toThrow(PanelError);
        }
        expect(await harness().client.restore()).toBe(false);
        expect(await harness({ options: v.options }).client.restore()).toBe(false);
    });

    it("waits for a durable token-free rotating marker before POST and a durable pair before retrying GET", async () => {
        const v = memoryVault(), h = harness({ options: v.options, tokens: tokens({ expires_in: 1 }) });
        await h.login(); await tick(1000);
        const marker = deferred<void>(), pair = deferred<void>(), events: string[] = [];
        v.vault.save.mockImplementation(async record => {
            events.push("save:" + record.state);
            await (record.state === "rotating" ? marker.promise : pair.promise);
            v.put(record);
        });
        h.transport.mockImplementation(async (_path, options) => {
            if (grant(options) === "refresh_token") {
                events.push("refresh");
                expect(v.read()).toEqual({ version: 1, state: "rotating", origin: PANEL_ORIGIN,
                    clientId: "support-templates", accountId: discordAccount });
                return rotated();
            }
            events.push("get"); return options.token;
        });
        const a = h.client.get("/me"), b = h.client.get("/snapshot"); await tick();
        expect(events).toEqual(["save:rotating"]); expect(h.refreshCalls()).toHaveLength(0);
        marker.resolve(); await tick();
        expect(events).toEqual(["save:rotating", "refresh", "save:ready"]);
        pair.resolve(); expect(await a).toBe("test-access-B"); expect(await b).toBe("test-access-B");
        expect(events.slice(-2)).toEqual(["get", "get"]); expect(h.refreshCalls()).toHaveLength(1);
    });

    it.each(["rotating", "ready"])("fails closed on %s persistence failure during refresh", async failing => {
        const v = memoryVault(), h = harness({ options: v.options, tokens: tokens({ expires_in: 1 }) });
        await h.login(); await tick(1000);
        v.vault.save.mockImplementation(async record => {
            if (record.state === failing) { v.put(record); throw new Error("SECRET native failure"); }
            v.put(record);
        });
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "vault_error", message: "Panel request failed." });
        expect(h.refreshCalls()).toHaveLength(failing === "rotating" ? 0 : 1);
        expect(v.read()).toBeNull(); expect(h.client.connectionId).toBeNull();
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "not_authenticated" });
    });

    it("does not fall back to memory after an initial save or load failure", async () => {
        const v = memoryVault(), h = harness({ options: v.options });
        v.vault.save.mockRejectedValueOnce(new Error("SECRET"));
        const login = outcome(h.client.login(h.onDevice)); await tick(5000);
        expect((await login).error).toMatchObject({ code: "vault_error" });
        expect(h.client.connectionId).toBeNull(); expect(v.read()).toBeNull();
        v.vault.load.mockRejectedValueOnce(new Error("SECRET"));
        await expect(h.client.restore()).rejects.toMatchObject({ code: "vault_error" });
        expect(h.client.connectionId).toBeNull();
    });

    it("a crash marker is never reusable on restore", async () => {
        const v = memoryVault(), h = harness({ options: v.options, tokens: tokens({ expires_in: 1 }) });
        await h.login(); await tick(1000);
        const response = deferred<unknown>(); h.transport.mockImplementationOnce(() => response.promise);
        const result = outcome(h.client.get("/me")); await tick();
        expect(v.read()).toMatchObject({ state: "rotating" });
        h.client.dispose(); expect((await result).error).toMatchObject({ code: "cancelled" });
        const next = harness({ options: v.options });
        expect(await next.client.restore()).toBe(false); expect(v.read()).toBeNull();
        expect(next.transport).not.toHaveBeenCalled();
        response.resolve(rotated()); await tick(); expect(v.read()).toBeNull();
    });

    it.each(["network_error", "timeout", "session_revoked"])("clears durable auth on terminal refresh failure %s", async code => {
        const v = memoryVault(), h = harness({ options: v.options, tokens: tokens({ expires_in: 1 }) });
        await h.login(); await tick(1000); h.transport.mockRejectedValueOnce(new PanelError(code, code === "session_revoked" ? 401 : 0));
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: code === "session_revoked" ? code : "refresh_uncertain" });
        expect(v.read()).toBeNull();
    });

    it("clears a restored session on cancel even without a device code", async () => {
        const v = memoryVault(), h = harness({ options: v.options }); await h.login(); h.client.dispose();
        const next = harness({ options: v.options }); expect(await next.client.restore()).toBe(true);
        await next.client.cancel(); expect(v.read()).toBeNull(); expect(next.client.connectionId).toBeNull();
        expect(next.transport).not.toHaveBeenCalled();
    });

    it("clears on explicit server revocation and reports vault deletion failure without retaining local auth", async () => {
        const v = memoryVault(), h = harness({ options: v.options }); await h.login();
        h.transport.mockRejectedValueOnce(new PanelError("session_revoked", 401));
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "session_revoked" });
        expect(v.read()).toBeNull();
        await h.login(); v.vault.clear.mockRejectedValueOnce(new Error("SECRET"));
        await expect(h.client.logout()).rejects.toMatchObject({ code: "vault_error" });
        expect(h.client.connectionId).toBeNull();
        expect(h.transport).toHaveBeenLastCalledWith("/oauth/revoke", expect.objectContaining({ token: "test-access-A" }));
        // A failed deletion poisons the local slot until a later successful clear.
        const next = harness({ options: v.options }); expect(await next.client.restore()).toBe(false);
        expect(v.read()).toBeNull();
    });

    it.each(["cancel", "logout"] as const)("%s clears before remote cleanup and never erases a newer client's login", async method => {
        const v = memoryVault(), h = harness({ options: v.options }); await h.login();
        const remote = deferred<unknown>();
        h.transport.mockImplementationOnce(async () => { expect(v.read()).toBeNull(); return remote.promise; });
        const old = outcome(h.client[method]()); await tick(); expect(v.read()).toBeNull();
        const next = harness({ options: v.options }); await next.login();
        const saved = v.read(); remote.resolve({}); await old; await tick();
        expect(v.read()).toEqual(saved); expect(next.client.connectionId).toBe(connection);
    });

    it("a synchronously queued logout clear precedes another client's restore", async () => {
        const v = memoryVault(), h = harness({ options: v.options }); await h.login();
        const old = outcome(h.client.logout());
        const next = harness({ options: v.options });
        expect(await next.client.restore()).toBe(false);
        await old; expect(v.read()).toBeNull();
    });

    it.each(["dispose", "cancel", "new client", "failed save"])("does not resurrect a delayed initial save after %s", async mode => {
        const v = memoryVault(), h = harness({ options: v.options });
        const write = deferred<void>();
        v.vault.save.mockImplementationOnce(async record => {
            await write.promise; v.put(record);
            if (mode === "failed save") throw new Error("SECRET");
        });
        const login = outcome(h.client.login(h.onDevice)); await tick(5000);
        let cleanup: Promise<unknown> | undefined;
        let next: ReturnType<typeof harness> | undefined;
        if (mode === "cancel") cleanup = h.client.cancel();
        else if (mode === "new client") {
            next = harness({ options: v.options }); cleanup = next.client.login(next.onDevice);
        } else h.client.dispose();
        write.resolve(); await tick(5000); await cleanup;
        expect((await login).error).toBeInstanceOf(PanelError);
        if (next) {
            expect(v.read()).toMatchObject({ state: "ready" }); expect(next.client.connectionId).toBe(connection);
        } else expect(v.read()).toBeNull();
        expect(h.client.connectionId).toBeNull();
    });

    it("logout joining refresh never writes a ready record after its early clear", async () => {
        const v = memoryVault(), h = harness({ options: v.options, tokens: tokens({ expires_in: 1 }) });
        await h.login(); await tick(1000);
        const response = deferred<unknown>(); h.transport.mockImplementationOnce(() => response.promise);
        const read = outcome(h.client.get("/me")); await tick();
        const logout = h.client.logout(); await tick(); expect(v.read()).toBeNull();
        response.resolve(rotated()); await logout;
        expect((await read).error).toMatchObject({ code: "cancelled" });
        expect(v.read()).toBeNull(); expect(h.refreshCalls()).toHaveLength(1);
        expect(v.vault.save.mock.calls.map(([r]) => r.state)).toEqual(["ready", "rotating"]);
    });

    it.each(["cancel", "dispose"] as const)("cleans a delayed rotated pair after %s before any reader can reuse it", async method => {
        const v = memoryVault(), h = harness({ options: v.options, tokens: tokens({ expires_in: 1 }) });
        await h.login(); await tick(1000); const write = deferred<void>();
        v.vault.save.mockImplementation(async record => {
            if (record.state === "ready") await write.promise;
            v.put(record);
        });
        const read = outcome(h.client.get("/me")); await tick();
        expect(v.read()).toMatchObject({ state: "rotating" });
        const cleanup = h.client[method](); write.resolve(); await cleanup; await read;
        const next = harness({ options: v.options });
        expect(await next.client.restore()).toBe(false); expect(v.read()).toBeNull();
        expect(h.refreshCalls()).toHaveLength(1);
    });

    it("a cancelled slow restore cannot publish or clear a replacement client's saved login", async () => {
        const v = memoryVault(), h = harness({ options: v.options }); await h.login(); h.client.dispose();
        const saved = v.read(), loaded = deferred<unknown>();
        v.vault.load.mockImplementationOnce(() => loaded.promise);
        const restoring = outcome(h.client.restore()); await tick();
        const next = harness({ options: v.options }); const login = next.client.login(next.onDevice);
        loaded.resolve(saved); await tick(5000); await login;
        expect((await restoring).error).toMatchObject({ code: "cancelled" });
        expect(v.read()).toMatchObject({ state: "ready" }); expect(next.client.connectionId).toBe(connection);
    });

    it("a new client restore waits for a disposed client's unfinished save and cleanup", async () => {
        const v = memoryVault(), h = harness({ options: v.options }), write = deferred<void>();
        v.vault.save.mockImplementationOnce(async record => { await write.promise; v.put(record); });
        const login = outcome(h.client.login(h.onDevice)); await tick(5000); h.client.dispose();
        const next = harness({ options: v.options }); const restoring = next.client.restore();
        await tick(); expect(v.vault.load).not.toHaveBeenCalled();
        write.resolve(); expect(await restoring).toBe(false);
        expect((await login).error).toMatchObject({ code: "cancelled" });
        expect(v.read()).toBeNull(); expect(next.client.connectionId).toBeNull();
    });

    it("does not POST refresh when logout cannot clear persisted credentials", async () => {
        const v = memoryVault(), h = harness({ options: v.options, tokens: tokens({ expires_in: 1 }) });
        await h.login(); await tick(1000); v.vault.clear.mockRejectedValueOnce(new Error("SECRET"));
        await expect(h.client.logout()).rejects.toMatchObject({ code: "vault_error" });
        expect(h.refreshCalls()).toHaveLength(0); expect(h.client.connectionId).toBeNull();
        expect(h.transport).toHaveBeenLastCalledWith("/oauth/revoke", expect.objectContaining({ token: "test-access-A" }));
    });

    it("still attempts device cancellation if durable deletion fails, but reports the vault failure", async () => {
        const v = memoryVault(), h = harness({ options: v.options }); await h.login();
        v.vault.clear.mockRejectedValueOnce(new Error("SECRET"));
        await expect(h.client.cancel()).rejects.toMatchObject({ code: "vault_error" });
        expect(h.transport).toHaveBeenLastCalledWith("/device-requests/cancel", expect.anything());
        expect(h.client.connectionId).toBeNull();
    });
});

describe("PanelClient authorized streams", () => {
    it("allows a long stream beyond the request timeout and aborts promptly on disposal", async () => {
        const h = harness({ timeout: 1000 }); await h.login();
        const stream = deferred<string>();
        const operation = vi.fn(async (_token: string, _signal: AbortSignal) => stream.promise);
        const result = outcome(h.client.streamAuthorized(operation)); await tick(60_000);
        expect(operation).toHaveBeenCalledOnce();
        const signal = operation.mock.calls[0][1]; expect(signal.aborted).toBe(false);
        h.client.dispose(); expect(signal.aborted).toBe(true);
        expect((await result).error).toMatchObject({ code: "cancelled" });
        stream.resolve("late"); await tick(); expect(h.client.connectionId).toBeNull();
    });

    it("refreshes once after stream 401 and passes the new pair only after persistence", async () => {
        const v = memoryVault(), h = harness({ options: v.options }); await h.login();
        const operation = vi.fn(async (token: string) => {
            if (token === "test-access-A") throw new PanelError("token_expired", 401);
            expect(v.read()).toMatchObject({ state: "ready", tokens: { accessToken: token } });
            return "complete";
        });
        expect(await h.client.streamAuthorized(operation)).toBe("complete");
        expect(operation).toHaveBeenCalledTimes(2); expect(h.refreshCalls()).toHaveLength(1);
    });

    it.each(["session_revoked", "invalid_token"])("clears saved auth when a stream terminates with %s", async code => {
        const v = memoryVault(), h = harness({ options: v.options }); await h.login();
        const operation = vi.fn(async () => { throw new PanelError(code, 401); });
        await expect(h.client.streamAuthorized(operation)).rejects.toMatchObject({ code });
        expect(operation).toHaveBeenCalledTimes(code === "session_revoked" ? 1 : 2);
        expect(v.read()).toBeNull(); expect(h.client.connectionId).toBeNull();
    });

    it("singleflights token.expired events with expired GETs and ignores an old stream's later expiry", async () => {
        const h = harness({ tokens: tokens({ expires_in: 1 }) }); await h.login();
        await h.client.streamAuthorized(async () => "token.expired"); await tick(1000);
        const response = deferred<unknown>(); h.transport.mockImplementationOnce(() => response.promise);
        const eventA = h.client.refreshForStream(), eventB = h.client.refreshForStream(), get = h.client.get("/me");
        await tick(); expect(h.refreshCalls()).toHaveLength(1);
        response.resolve(rotated()); await Promise.all([eventA, eventB, get]);
        await h.client.refreshForStream(); expect(h.refreshCalls()).toHaveLength(1);
        const operation = vi.fn(async (token: string) => token);
        expect(await h.client.streamAuthorized(operation)).toBe("test-access-B");
    });

    it("rejects a late stream result after a newer login", async () => {
        const h = harness(); await h.login(); const stream = deferred<string>();
        const result = outcome(h.client.streamAuthorized(async () => stream.promise)); await tick();
        await h.login(); stream.resolve("previous-account");
        expect((await result).error).toMatchObject({ code: "cancelled" });
        expect(h.client.connectionId).toBe(connection);
    });

    it("aborts streams immediately while remote logout remains pending", async () => {
        const h = harness(); await h.login(); const stream = deferred<void>(), revoked = deferred<unknown>();
        let signal!: AbortSignal;
        const result = outcome(h.client.streamAuthorized(async (_token, current) => { signal = current; return stream.promise; }));
        await tick(); h.transport.mockImplementationOnce(() => revoked.promise);
        const logout = h.client.logout();
        expect(signal.aborted).toBe(true); expect((await result).error).toMatchObject({ code: "cancelled" });
        revoked.resolve({}); await logout; stream.resolve();
    });

    it("does not start a queued stream callback after logout has already aborted its signal", async () => {
        const h = harness(); await h.login(); const operation = vi.fn(async () => "late");
        const stream = outcome(h.client.streamAuthorized(operation));
        await h.client.logout();
        expect((await stream).error).toMatchObject({ code: "cancelled" });
        expect(operation).not.toHaveBeenCalled();
    });

    it("does not replay or erase a valid session for an ordinary stream network failure", async () => {
        const v = memoryVault(), h = harness({ options: v.options }); await h.login(); const saved = v.read();
        const operation = vi.fn(async () => { throw new PanelError("network_error"); });
        await expect(h.client.streamAuthorized(operation)).rejects.toMatchObject({ code: "network_error" });
        expect(operation).toHaveBeenCalledOnce(); expect(h.refreshCalls()).toHaveLength(0);
        expect(v.read()).toEqual(saved); expect(h.client.connectionId).toBe(connection);
    });
});

describe("PanelClient authorized reads and rotation", () => {
    it("singleflights concurrent expired GETs and stores the rotated pair before resuming them", async () => {
        const h = harness({ tokens: tokens({ expires_in: 1 }) }); await h.login();
        await tick(1000);
        const rotation = deferred<unknown>();
        h.transport.mockImplementation(async (path, options) => grant(options) === "refresh_token" ? rotation.promise : { path, token: options.token });
        const a = h.client.get("/me"), b = h.client.get("/snapshot"); await tick();
        expect(h.refreshCalls()).toHaveLength(1);
        rotation.resolve(rotated());
        expect(await a).toEqual({ path: "/me", token: "test-access-B" });
        expect(await b).toEqual({ path: "/snapshot", token: "test-access-B" });
        expect(h.client.connectionId).toBe(connection);
    });

    it("a late 401 for the old access token reuses the new token without a second refresh", async () => {
        const h = harness(); await h.login();
        const slow = deferred<unknown>();
        h.transport.mockImplementation(async (path, options) => {
            if (grant(options) === "refresh_token") return rotated();
            if (options.token === "test-access-A") {
                if (path === "/snapshot") return slow.promise;
                throw new PanelError("token_expired", 401);
            }
            return options.token;
        });
        const b = h.client.get("/snapshot"), a = h.client.get("/me");
        expect(await a).toBe("test-access-B");
        slow.reject(new PanelError("token_expired", 401));
        expect(await b).toBe("test-access-B");
        expect(h.refreshCalls()).toHaveLength(1);
    });

    it.each(["network", "timeout", "invalid response"])("never retries an uncertain rotation after %s", async mode => {
        const h = harness({ tokens: tokens({ expires_in: 1 }), timeout: 1000 }); await h.login(); await tick(1000);
        h.transport.mockImplementation(async () => {
            if (mode === "network") throw new Error("SECRET response body");
            if (mode === "timeout") return new Promise(() => {});
            return { access_token: "SECRET" };
        });
        const a = outcome(h.client.get("/me")), b = outcome(h.client.get("/snapshot"));
        await tick(1000);
        expect((await a).error).toMatchObject({ code: "refresh_uncertain", message: "Panel request failed." });
        expect((await b).error).toMatchObject({ code: "refresh_uncertain" });
        expect(h.client.connectionId).toBeNull();
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "not_authenticated" });
        expect(h.refreshCalls()).toHaveLength(1);
    });

    it("refuses a refresh response bound to another connection", async () => {
        const h = harness({ tokens: tokens({ expires_in: 1 }) }); await h.login(); await tick(1000);
        h.transport.mockResolvedValueOnce(tokens({ connectionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }));
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "connection_mismatch" });
        expect(h.client.connectionId).toBeNull();
    });

    it.each([
        ["network_error", 0], ["network_error", 200], ["timeout", 0], ["aborted", 0],
        ["invalid_response", 200], ["response_too_large", 200], ["redirect_not_allowed", 302],
        ["plugin_disabled", 503], ["rate_limited", 429],
    ])("normalizes transport rotation failure %s/%s to terminal refresh_uncertain", async (code, status) => {
        const h = harness({ tokens: tokens({ expires_in: 1 }) }); await h.login(); await tick(1000);
        h.transport.mockRejectedValueOnce(new PanelError(String(code), Number(status), 10_000));
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "refresh_uncertain", status: 0, retryAfterMs: undefined });
        expect(h.client.connectionId).toBeNull();
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "not_authenticated" });
        expect(h.refreshCalls()).toHaveLength(1);
    });

    it("preserves explicit revocation during refresh", async () => {
        const h = harness({ tokens: tokens({ expires_in: 1 }) }); await h.login(); await tick(1000);
        h.transport.mockRejectedValueOnce(new PanelError("session_revoked", 401));
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "session_revoked", status: 401 });
        expect(h.client.connectionId).toBeNull();
        expect(h.refreshCalls()).toHaveLength(1);
    });

    it("rejects a response that reuses the previous refresh token", async () => {
        const h = harness({ tokens: tokens({ expires_in: 1 }) }); await h.login(); await tick(1000);
        h.transport.mockResolvedValueOnce(tokens({ access_token: "test-access-B" }));
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "refresh_uncertain" });
        expect(h.client.connectionId).toBeNull();
        expect(h.refreshCalls()).toHaveLength(1);
    });

    it("a late rotation cannot replace or clear a newer login", async () => {
        const h = harness({ tokens: tokens({ expires_in: 1 }) }); await h.login(); await tick(1000);
        const late = deferred<unknown>();
        h.transport.mockImplementationOnce(() => late.promise);
        const oldGet = outcome(h.client.get("/me")); await tick();
        await h.login();
        late.resolve(rotated()); await tick();
        expect((await oldGet).error).toMatchObject({ code: "cancelled" });
        expect(h.client.connectionId).toBe(connection);
        await h.client.get("/me");
        expect(h.transport).toHaveBeenLastCalledWith("/me", expect.objectContaining({ token: "test-access-A" }));
    });

    it("session_revoked terminates auth without trying refresh", async () => {
        const h = harness(); await h.login();
        h.transport.mockRejectedValueOnce(new PanelError("session_revoked", 401));
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "session_revoked" });
        expect(h.client.connectionId).toBeNull();
        expect(h.refreshCalls()).toHaveLength(0);
    });

    it("retries a protected read at most once after 401", async () => {
        const h = harness(); await h.login();
        h.transport.mockImplementation(async (_path, options) => {
            if (grant(options) === "refresh_token") return rotated();
            throw new PanelError("invalid_token", 401);
        });
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "invalid_token", status: 401 });
        expect(h.refreshCalls()).toHaveLength(1);
        expect(h.client.connectionId).toBeNull();
    });

    it.each(["dispose", "new login"])("does not return an old GET result after %s", async action => {
        const h = harness(); await h.login();
        const late = deferred<unknown>();
        h.transport.mockImplementationOnce(() => late.promise);
        const result = outcome(h.client.get("/snapshot")); await tick();
        const signal = h.transport.mock.lastCall![1].signal!;
        if (action === "dispose") h.client.dispose(); else await h.login();
        late.resolve({ accountId: "old-account" }); await tick();
        expect((await result).error).toMatchObject({ code: "cancelled" });
        expect(signal.aborted).toBe(true);
        expect(h.client.connectionId).toBe(action === "dispose" ? null : connection);
    });

    it("rejects absolute URLs before sending credentials", async () => {
        const h = harness(); await h.login();
        const count = h.transport.mock.calls.length;
        await expect(h.client.get("https://example.invalid/me")).rejects.toMatchObject({ code: "invalid_path" });
        expect(h.transport).toHaveBeenCalledTimes(count);
    });
});

describe("PanelClient logout", () => {
    it("revokes with the current access token and immediately hides binding from callers", async () => {
        const h = harness(); await h.login();
        const logout = h.client.logout();
        expect(h.client.connectionId).toBeNull();
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "not_authenticated" });
        await logout;
        expect(h.transport).toHaveBeenLastCalledWith("/oauth/revoke", { body: {}, token: "test-access-A", signal: expect.any(AbortSignal) });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("refreshes an expired access token before revoking", async () => {
        const h = harness({ tokens: tokens({ expires_in: 1 }) }); await h.login(); await tick(1000);
        await h.client.logout();
        expect(h.refreshCalls()).toHaveLength(1);
        expect(h.transport).toHaveBeenLastCalledWith("/oauth/revoke", expect.objectContaining({ token: "test-access-B", body: {} }));
        expect(h.client.connectionId).toBeNull();
    });

    it("rejects failed server revocation but always clears local credentials", async () => {
        const h = harness(); await h.login();
        h.transport.mockRejectedValueOnce(new Error("SECRET network payload"));
        await expect(h.client.logout()).rejects.toMatchObject({ code: "transport_error", message: "Panel request failed." });
        expect(h.client.connectionId).toBeNull();
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "not_authenticated" });
    });

    it("joins an existing rotation before logout rather than replaying its refresh token", async () => {
        const h = harness({ tokens: tokens({ expires_in: 1 }) }); await h.login(); await tick(1000);
        const rotation = deferred<unknown>();
        h.transport.mockImplementationOnce(() => rotation.promise);
        const read = outcome(h.client.get("/me")); await tick();
        const logout = h.client.logout();
        rotation.resolve(rotated()); await logout;
        expect((await read).error).toMatchObject({ code: "cancelled" });
        expect(h.refreshCalls()).toHaveLength(1);
        expect(h.transport.mock.calls.some(([path, options]) => path === "/oauth/revoke" && options.token === "test-access-B")).toBe(true);
        expect(h.client.connectionId).toBeNull();
    });

    it("an old logout completion cannot clear a new login", async () => {
        const h = harness(); await h.login();
        const revoke = deferred<unknown>();
        h.transport.mockImplementationOnce(() => revoke.promise);
        const oldLogout = outcome(h.client.logout()); await tick();
        await h.login();
        revoke.resolve({ success: true }); await tick();
        expect((await oldLogout).error).toMatchObject({ code: "cancelled" });
        expect(h.client.connectionId).toBe(connection);
    });
});
