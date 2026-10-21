import { describe, expect, it } from "vitest";

import { PANEL_ORIGIN, panelEndpoint, panelMutationScope, PanelMutation, parseDeviceAuthorization, parsePanelTokens, slowerPolling } from "../src/core/panelProtocol";

const device = {
    device_code: "test-device-secret", user_code: "ABCD12",
    verification_uri: PANEL_ORIGIN + "/connect",
    verification_uri_complete: PANEL_ORIGIN + "/connect?user_code=ABCD12",
    expires_in: 600, interval: 5
};
const tokens = { access_token: "test-access", refresh_token: "test-refresh", token_type: "Bearer", expires_in: 900,
    scope: "profile:read faq:read", connectionId: "11111111-2222-4333-8444-555555555555" };

describe("notification settings mutation boundary", () => {
    const request: PanelMutation = { path: "/notification-settings", method: "PATCH", version: "opaque-v1", body: { discordEnabled: true } };
    it.each([true, false])("permits only the versioned Discord delivery switch: %s", discordEnabled => {
        expect(panelMutationScope({ ...request, body: { discordEnabled } })).toBe("notifications:settings:write");
    });
    it.each([
        { method: "POST" }, { method: "DELETE" }, { path: "/tickets/assigned" }, { path: "/notification-settings/1" },
        { version: undefined }, { version: "" }, { version: '"quoted"' }, { version: "bad\r\nheader" }, { idempotencyKey: "extra" },
        { body: undefined }, { body: null }, { body: [] }, { body: {} }, { body: { discordEnabled: "true" } },
        { body: { discordEnabled: true, telegramEnabled: false } },
        { body: { discordEnabled: true, personalReminderMinutes: 5 } },
        { body: { discordEnabled: true, slow_reply_interval: 5 } },
        { body: { discordEnabled: true, thresholdSource: "telegram" } },
        { body: { discordEnabled: true, projects: [] } },
    ])("rejects unsupported writes %j", patch => {
        expect(() => panelMutationScope({ ...request, ...patch } as PanelMutation)).toThrow();
    });
});

describe("production panel protocol boundary", () => {
    it("keeps OAuth paths under the plugin API base", () => {
        expect(panelEndpoint("/oauth/token")).toBe(PANEL_ORIGIN + "/api/plugin/v1/oauth/token");
        expect(() => panelEndpoint("//evil.example/oauth/token")).toThrow();
        expect(() => panelEndpoint("/../oauth/token")).toThrow();
        expect(() => panelEndpoint("/oauth/token", "http://panel.majestic-rp.tech")).toThrow();
    });
    it("accepts a matching code and server-provided timing", () => {
        expect(parseDeviceAuthorization(device)).toMatchObject({ deviceCode: device.device_code, userCode: "ABCD12", interval: 5, expiresIn: 600 });
        expect(slowerPolling(slowerPolling(5))).toBe(15);
        expect(parseDeviceAuthorization({ ...device, verification_uri_complete: undefined }).verificationUriComplete).toBe(PANEL_ORIGIN + "/connect?code=ABCD12");
    });
    it.each([PANEL_ORIGIN, "https://majestic-rp.tech"])("opens the canonical panel code link for a validated response from %s", webOrigin => {
        const value = { ...device, user_code: "TEST123456", verification_uri: webOrigin + "/connect",
            verification_uri_complete: webOrigin + "/connect?code=TEST123456" };
        expect(parseDeviceAuthorization(value)).toMatchObject({ userCode: "TEST123456", verificationUri: PANEL_ORIGIN + "/connect", verificationUriComplete: PANEL_ORIGIN + "/connect?code=TEST123456" });
        expect(parseDeviceAuthorization({ ...value, verification_uri_complete: undefined }).verificationUriComplete).toBe(PANEL_ORIGIN + "/connect?code=TEST123456");
        expect(panelEndpoint("/oauth/token")).toBe(PANEL_ORIGIN + "/api/plugin/v1/oauth/token");
    });
    it("normalizes legacy query names and encodes the user code as one parameter", () => {
        expect(parseDeviceAuthorization(device).verificationUriComplete).toBe(PANEL_ORIGIN + "/connect?code=ABCD12");
        const user_code = "A+B &next=?/";
        const result = parseDeviceAuthorization({ ...device, user_code, verification_uri_complete: undefined });
        const url = new URL(result.verificationUriComplete);
        expect(url.origin).toBe(PANEL_ORIGIN);
        expect([...url.searchParams.entries()]).toEqual([["code", user_code]]);
    });
    it.each([
        "https://majestic-rp.tech/connect?code=OTHER",
        "https://majestic-rp.tech/connect?code=ABCD12&code=ABCD12",
        "https://majestic-rp.tech/connect?code=ABCD12&user_code=ABCD12",
        "https://majestic-rp.tech/connect?code=ABCD12&redirect=https://evil.example",
        "https://majestic-rp.tech/connect?code=ABCD12#fragment",
        "https://majestic-rp.tech/other?code=ABCD12",
        "http://majestic-rp.tech/connect?code=ABCD12",
        "https://majestic-rp.tech:8443/connect?code=ABCD12",
        "https://majestic-rp.tech.evil.example/connect?code=ABCD12",
        "https://user:pass@majestic-rp.tech/connect?code=ABCD12"
    ])("rejects unsafe deployed-format links %s", verification_uri_complete => {
        expect(() => parseDeviceAuthorization({ ...device, verification_uri_complete })).toThrow();
    });
    it("does not extend staging trust to production login sites", () => {
        const staging = "https://staging.example";
        const value = { ...device, verification_uri: staging + "/connect", verification_uri_complete: staging + "/connect?code=ABCD12" };
        expect(parseDeviceAuthorization(value, staging).verificationUriComplete).toBe(value.verification_uri_complete);
        expect(() => parseDeviceAuthorization(device, staging)).toThrow();
        expect(() => parseDeviceAuthorization({ ...value, verification_uri_complete: "https://majestic-rp.tech/connect?code=ABCD12" }, staging)).toThrow();
    });
    it.each([
        "https://evil.example/connect?user_code=ABCD12",
        PANEL_ORIGIN + "/connect?user_code=OTHER",
        PANEL_ORIGIN + "/connect?user_code=ABCD12&user_code=OTHER",
        PANEL_ORIGIN + "/connect?user_code=ABCD12&redirect=https://evil.example",
        PANEL_ORIGIN + "/connect?user_code=ABCD12#secret",
        "javascript:alert(1)",
        "https://user:pass@panel.majestic-rp.tech/connect?user_code=ABCD12"
    ])("rejects an unsafe verification destination %s", verification_uri_complete => {
        expect(() => parseDeviceAuthorization({ ...device, verification_uri_complete })).toThrow();
    });
    it("rejects absent/malformed timing and never echoes secrets in errors", () => {
        for (const patch of [{ interval: 0 }, { interval: 600 }, { expires_in: "600" }, { device_code: null }, { user_code: "\nsecret" }]) {
            expect(() => parseDeviceAuthorization({ ...device, ...patch })).toThrow("Некорректный ответ API панели");
        }
    });
    it("requires a complete valid token pair", () => {
        expect(parsePanelTokens(tokens)).toMatchObject({ accessToken: "test-access", scopes: ["profile:read", "faq:read"] });
        for (const patch of [{ refresh_token: null }, { expires_in: -1 }, { connectionId: "other" }, { token_type: "Basic" }, { access_token: "secret\r\nheader" }]) {
            expect(() => parsePanelTokens({ ...tokens, ...patch })).toThrow("Некорректный ответ API панели");
        }
    });
});
