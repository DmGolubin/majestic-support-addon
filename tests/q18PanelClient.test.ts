import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelClient, PanelError, type PanelTransport } from "../src/core/panelClient";
import { PANEL_ORIGIN } from "../src/core/panelProtocol";

const MAX_TIMER = 2_147_483_647;
const interval = Math.ceil(MAX_TIMER / 1000) + 10;
const tokenResponse = {
    access_token: "q18-fixture-access", refresh_token: "q18-fixture-refresh", token_type: "Bearer", expires_in: 900,
    scope: "profile:read faq:read personal:read folders:read sync:read", connectionId: "12345678-1234-1234-1234-123456789abc",
};
function fixture(retryAfter: boolean) {
    const polls: number[] = [];
    const transport = vi.fn<PanelTransport>(async path => {
        if (path === "/oauth/device_authorization") return {
            device_code: "q18-fixture-device", user_code: "Q18-CODE", verification_uri: PANEL_ORIGIN + "/connect",
            expires_in: interval + 100, interval: retryAfter ? 5 : interval,
        };
        if (path === "/oauth/token") {
            polls.push(Date.now());
            if (retryAfter && polls.length === 1) throw new PanelError("authorization_pending", 400, interval * 1000);
            return tokenResponse;
        }
        return {};
    });
    return { client: new PanelClient(transport), transport, polls };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("Q18 device polling timer boundaries", () => {
    it.each([false, true])("preserves a server wait beyond the platform timer limit (Retry-After=%s)", async retryAfter => {
        const h = fixture(retryAfter);
        const outcome = h.client.login(() => {}).then(() => null, error => error);
        await vi.advanceTimersByTimeAsync(retryAfter ? 5000 : 0);
        const before = h.polls.length;
        await vi.advanceTimersByTimeAsync(MAX_TIMER);
        const earlyPolls = h.polls.length;
        await vi.advanceTimersByTimeAsync(interval * 1000 - MAX_TIMER);
        const result = await outcome;
        h.client.dispose();
        expect(earlyPolls).toBe(before);
        expect(h.polls).toHaveLength(before + 1);
        expect(h.polls.at(-1)).toBe((retryAfter ? 5000 : 0) + interval * 1000);
        expect(result).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("cancels a rearmed long device wait without leaving another timer or token request", async () => {
        const h = fixture(false);
        const outcome = h.client.login(() => {}).then(() => null, error => error);
        await vi.advanceTimersByTimeAsync(MAX_TIMER);
        h.client.dispose();
        const result = await outcome;
        await vi.advanceTimersByTimeAsync(interval * 1000);
        expect(result).toMatchObject({ code: "cancelled" });
        expect(h.polls).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });
});
