import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { diagnosticJournal as journal } from "../src/core/diagnosticJournal";
import { PanelClient, PanelError, PanelTransport } from "../src/core/panelClient";
import { PANEL_ORIGIN } from "../src/core/panelProtocol";
import { createPanelTransport } from "../src/core/panelTransport";

beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(1792480000000);
    journal.start({ read: () => null, write() {} }, { continuous: true });
    journal.clear();
});
afterEach(() => { journal.stop(); vi.useRealTimers(); });

it("explains an authentication rejection and invalidation without storing credentials", async () => {
    const transport: PanelTransport = async path => {
        if (path === "/oauth/device_authorization") return { device_code: "PRIVATE_DEVICE", user_code: "PRIVATE_CODE",
            verification_uri: PANEL_ORIGIN + "/connect", expires_in: 600, interval: 5 };
        if (path === "/oauth/token") return { access_token: "PRIVATE_ACCESS", refresh_token: "PRIVATE_REFRESH", token_type: "Bearer",
            expires_in: 900, scope: "profile:read faq:read personal:read folders:read sync:read",
            connectionId: "12345678-1234-1234-1234-123456789abc" };
        throw new PanelError("session_revoked", 401);
    };
    const client = new PanelClient(transport);
    const login = client.login(() => {});
    await vi.advanceTimersByTimeAsync(5000); await login;
    await expect(client.get("/me")).rejects.toMatchObject({ code: "session_revoked" });
    const events = journal.snapshot().events;
    expect(events).toContainEqual(expect.objectContaining({ event: "auth.rejected", data: expect.objectContaining({ code: "session_revoked", status: 401, attempt: 0 }) }));
    expect(events).toContainEqual(expect.objectContaining({ event: "auth.invalidate", data: expect.objectContaining({ active: true }) }));
    expect(client.connectionId).toBeNull();
    expect(JSON.stringify(journal.snapshot())).not.toContain("PRIVATE");
    client.dispose();
});

it("correlates safe API request metadata and retry delay without response text or personal IDs", async () => {
    const transport = createPanelTransport(async () => new Response(JSON.stringify({ code: "rate_limited", message: "PRIVATE_BODY" }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "30" } }));
    await expect(transport("/me", { token: "PRIVATE_ACCESS" })).rejects.toMatchObject({ status: 429 });
    const events = journal.snapshot().events;
    const start = events.find(e => e.event === "request.start")!;
    expect(start.data).toMatchObject({ method: "GET", route: "/me" });
    expect(events.find(e => e.event === "request.failure")?.data).toMatchObject({
        requestId: start.seq, route: "/me", status: 429, retryAfterMs: 30000, code: "rate_limited"
    });
    expect(JSON.stringify(events)).not.toContain("PRIVATE");
});
