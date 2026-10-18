import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelClient, PanelError, PanelTransport } from "../src/core/panelClient";
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

function harness(overrides: { device?: unknown; tokens?: unknown; timeout?: number } = {}) {
    const transport = vi.fn<PanelTransport>(async (path, options) => {
        if (path === "/oauth/device_authorization") return overrides.device ?? device();
        if (path === "/oauth/token") return grant(options) === "refresh_token" ? rotated() : overrides.tokens ?? tokens();
        if (path === "/me") return { accountId: "test-account", connectionId: connection };
        return { success: true };
    });
    const client = new PanelClient(transport, { requestTimeoutMs: overrides.timeout });
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
