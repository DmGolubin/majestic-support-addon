import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelClient, PanelError, type PanelSessionRecord, type PanelTransport, type PanelVault } from "../src/core/panelClient";
import { PANEL_ORIGIN, PANEL_CLIENT_ID } from "../src/core/panelProtocol";

// All credentials, HTTP and persistence here are synthetic. Restore avoids device URL concerns.
const accountId = "123456789012345678";
const connectionId = "12345678-1234-1234-1234-123456789abc";
const scopes = ["profile:read", "faq:read", "personal:read", "folders:read", "sync:read"];
const tokens = (n: number) => ({ accessToken: `fixture-access-${n}`, refreshToken: `fixture-refresh-${n}`,
    expiresIn: 900, connectionId, scopes });
const wireTokens = (n: number) => ({ access_token: tokens(n).accessToken, refresh_token: tokens(n).refreshToken,
    expires_in: 900, token_type: "Bearer", connectionId, scope: scopes.join(" ") });
function deferred<T>() {
    let resolve!: (v: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function fixture() {
    let saved: PanelSessionRecord | null = { version: 1, origin: PANEL_ORIGIN, clientId: PANEL_CLIENT_ID, accountId,
        state: "ready", tokens: tokens(0), expiresAt: Date.now() + 900000 };
    const vault: PanelVault = { load: vi.fn(async () => structuredClone(saved)),
        save: vi.fn(async record => { saved = structuredClone(record); }), clear: vi.fn(async () => { saved = null; }) };
    let rotations = 0;
    const transport = vi.fn<PanelTransport>(async (path, options) => {
        if (path === "/oauth/token") return wireTokens(++rotations);
        return { path, token: options.token };
    });
    const client = new PanelClient(transport, { vault, accountId });
    expect(await client.restore()).toBe(true);
    return { client, transport, vault, saved: () => saved,
        refreshes: () => transport.mock.calls.filter(([path]) => path === "/oauth/token") };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-19T00:00:00Z")); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("synthetic auth/session request budgets", () => {
    it("runs six simulated hours: 720 protected reads and exactly 24 durable rotations", async () => {
        const h = await fixture();
        for (let minute = 1; minute <= 360; minute++) {
            await vi.advanceTimersByTimeAsync(60000);
            const results = await Promise.all([h.client.get("/me"), h.client.get("/snapshot")]);
            expect(results).toEqual([
                { path: "/me", token: tokens(Math.floor(minute / 15)).accessToken },
                { path: "/snapshot", token: tokens(Math.floor(minute / 15)).accessToken },
            ]);
        }
        expect(h.refreshes()).toHaveLength(24);
        expect(h.transport).toHaveBeenCalledTimes(744);
        expect(h.vault.save).toHaveBeenCalledTimes(48); // write-ahead marker + replacement pair
        expect(h.vault.clear).not.toHaveBeenCalled();
        h.client.dispose(); expect(vi.getTimerCount()).toBe(0);
    });

    it("shares one rotation between 100 reads and a stream after concurrent 401s", async () => {
        const h = await fixture(), rotate = deferred<unknown>(), late = deferred<unknown>();
        h.transport.mockImplementation(async (path, options) => {
            if (path === "/oauth/token") return rotate.promise;
            if (options.token === tokens(0).accessToken) {
                if (path === "/snapshot") return late.promise;
                throw new PanelError("token_expired", 401);
            }
            return options.token;
        });
        const stream = vi.fn(async (token: string) => {
            if (token === tokens(0).accessToken) throw new PanelError("token_expired", 401);
            return token;
        });
        const reads = Array.from({ length: 100 }, (_, i) => h.client.get(i % 2 ? "/snapshot" : "/me"));
        const streamed = h.client.streamAuthorized(stream);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.refreshes()).toHaveLength(1);
        expect(h.saved()?.state).toBe("rotating");
        rotate.resolve(wireTokens(1)); await vi.advanceTimersByTimeAsync(0);
        late.reject(new PanelError("token_expired", 401));
        expect(await Promise.all(reads)).toEqual(Array(100).fill(tokens(1).accessToken));
        expect(await streamed).toBe(tokens(1).accessToken);
        expect(h.transport).toHaveBeenCalledTimes(201); expect(stream).toHaveBeenCalledTimes(2);
        expect(h.refreshes()).toHaveLength(1); expect(h.saved()?.state).toBe("ready");
        h.client.dispose();
    });

    it.each([new Error("synthetic offline"), new PanelError("network_error"), new PanelError("rate_limited", 429, 120000)])(
        "never retries an uncertain rotating pair (%s)", async error => {
            const h = await fixture(); await vi.advanceTimersByTimeAsync(900000);
            h.transport.mockRejectedValue(error);
            const results = await Promise.allSettled(Array.from({ length: 100 }, () => h.client.get("/me")));
            expect(results.every(r => r.status === "rejected" && r.reason.code === "refresh_uncertain")).toBe(true);
            expect(h.transport).toHaveBeenCalledOnce(); expect(h.saved()).toBeNull();
            await vi.advanceTimersByTimeAsync(3600000);
            await expect(h.client.get("/me")).rejects.toMatchObject({ code: "not_authenticated" });
            expect(h.transport).toHaveBeenCalledOnce();
        },
    );

    it("keeps ordinary GET network failures durable but clears a genuine concurrent revocation", async () => {
        const h = await fixture();
        h.transport.mockRejectedValueOnce(new Error("offline"));
        await expect(h.client.get("/me")).rejects.toMatchObject({ code: "transport_error" });
        expect(h.saved()?.state).toBe("ready"); expect(h.vault.clear).not.toHaveBeenCalled();
        h.transport.mockRejectedValueOnce(new PanelError("http_error", 502));
        await expect(h.client.get("/snapshot")).rejects.toMatchObject({ status: 502 });
        expect(h.saved()?.state).toBe("ready"); expect(h.vault.clear).not.toHaveBeenCalled();
        expect(await h.client.get("/me")).toMatchObject({ token: tokens(0).accessToken });
        const revoked = deferred<unknown>();
        h.transport.mockImplementation(async path => {
            if (path === "/snapshot") return revoked.promise;
            throw new PanelError("network_error");
        });
        const results = Promise.allSettled([h.client.get("/me"), h.client.get("/snapshot")]);
        await vi.advanceTimersByTimeAsync(0); revoked.reject(new PanelError("session_revoked", 401));
        expect((await results)[1]).toMatchObject({ status: "rejected", reason: { code: "session_revoked" } });
        expect(h.saved()).toBeNull(); expect(h.refreshes()).toHaveLength(0);
        expect(h.client.connectionId).toBeNull();
    });
});
