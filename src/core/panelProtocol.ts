/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Wire boundary for the delivered panel contract. No IO or token persistence here. */
export const PANEL_ORIGIN = "https://panel.majestic-rp.tech";
export const PANEL_API_PATH = "/api/plugin/v1";
export const PANEL_CLIENT_ID = "support-templates";

export interface DeviceAuthorization {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
}

export interface PanelTokens {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    scopes: string[];
    connectionId: string;
}

/** Never include response values in validation errors: they can contain credentials. */
function invalid(): never { throw new Error("Некорректный ответ API панели"); }

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    return value as Record<string, unknown>;
}

function string(value: unknown, max = 4096): string {
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
    return value;
}

function positive(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return invalid();
    return value;
}

function origin(value: string): string {
    let u: URL;
    try { u = new URL(value); } catch { return invalid(); }
    if (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash) return invalid();
    return u.origin;
}

/** Test/staging origins must be provided explicitly by trusted configuration, never an API body. */
export function panelEndpoint(path: string, trustedOrigin = PANEL_ORIGIN): string {
    if (!/^\/[a-z][a-z0-9/_-]*$/.test(path) || path.includes("//")) return invalid();
    return origin(trustedOrigin) + PANEL_API_PATH + path;
}

function verification(value: unknown, trustedOrigin: string, userCode: string, complete: boolean): string {
    let u: URL;
    try { u = new URL(string(value)); } catch { return invalid(); }
    if (u.origin !== trustedOrigin || u.username || u.password || u.pathname !== "/connect" || u.hash) return invalid();
    // Local allowlist, to verify against staging: do not accept arbitrary redirect/token parameters.
    if ([...u.searchParams.keys()].some(k => k !== "user_code")) return invalid();
    const codes = u.searchParams.getAll("user_code");
    if (complete ? codes.length !== 1 || codes[0] !== userCode : codes.length !== 0) return invalid();
    return u.href;
}

export function parseDeviceAuthorization(value: unknown, trustedOrigin = PANEL_ORIGIN): DeviceAuthorization {
    const r = record(value);
    const trusted = origin(trustedOrigin);
    const userCode = string(r.user_code, 128);
    const expiresIn = positive(r.expires_in);
    const interval = positive(r.interval);
    if (interval >= expiresIn) return invalid();
    return {
        deviceCode: string(r.device_code), userCode,
        verificationUri: verification(r.verification_uri, trusted, userCode, false),
        // OpenAPI permits omitting the complete link; use the base page and show the code.
        verificationUriComplete: r.verification_uri_complete === undefined
            ? verification(r.verification_uri, trusted, userCode, false)
            : verification(r.verification_uri_complete, trusted, userCode, true),
        expiresIn, interval
    };
}

export function parsePanelTokens(value: unknown): PanelTokens {
    const r = record(value);
    if (r.token_type !== "Bearer") return invalid();
    const accessToken = string(r.access_token);
    const refreshToken = string(r.refresh_token);
    if (/\s/.test(accessToken) || /\s/.test(refreshToken)) return invalid();
    const connectionId = string(r.connectionId, 128);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectionId)) return invalid();
    return { accessToken, refreshToken, expiresIn: positive(r.expires_in), scopes: [...new Set(string(r.scope).split(/ +/))], connectionId };
}

/** Call only for slow_down. Pending polling keeps the server's current interval. */
export function slowerPolling(intervalSeconds: number): number {
    const interval = positive(intervalSeconds);
    if (!Number.isSafeInteger(interval + 5)) return invalid();
    return interval + 5;
}
