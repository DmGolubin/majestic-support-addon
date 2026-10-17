import { describe, expect, it } from "vitest";

import { PANEL_ORIGIN, panelEndpoint, parseDeviceAuthorization, parsePanelTokens, slowerPolling } from "../src/core/panelProtocol";

const device = {
    device_code: "test-device-secret", user_code: "ABCD12",
    verification_uri: PANEL_ORIGIN + "/connect",
    verification_uri_complete: PANEL_ORIGIN + "/connect?user_code=ABCD12",
    expires_in: 600, interval: 5
};
const tokens = { access_token: "test-access", refresh_token: "test-refresh", token_type: "Bearer", expires_in: 900,
    scope: "profile:read faq:read", connectionId: "11111111-2222-4333-8444-555555555555" };

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
        expect(parseDeviceAuthorization({ ...device, verification_uri_complete: undefined }).verificationUriComplete).toBe(device.verification_uri);
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
