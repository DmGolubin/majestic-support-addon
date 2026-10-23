/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Wire boundary for the delivered panel contract. No IO or token persistence here. */
export const PANEL_ORIGIN = "https://panel.majestic-rp.tech";
// Accept legacy server responses, but open confirmation on the canonical API host.
const PANEL_LOGIN_ORIGIN = "https://majestic-rp.tech";
export const PANEL_API_PATH = "/api/plugin/v1";
export const PANEL_CLIENT_ID = "support-templates";

export interface PanelMutation {
    path: string;
    method: "POST" | "PATCH" | "DELETE";
    body?: unknown;
    idempotencyKey?: string;
    version?: string;
}

/** Writes are limited to the personal library and Discord reminder settings. */
export function panelMutationScope(request: PanelMutation): "personal:write" | "folders:write" | "notifications:settings:write" {
    const notifications = request.path === "/notification-settings";
    const create = /^\/(personal-templates|folders)$/.exec(request.path);
    const entry = /^\/(personal-templates|folders)\/[1-9]\d{0,19}$/.exec(request.path);
    const restore = /^\/trash\/[1-9]\d{0,19}\/restore$/.test(request.path);
    if (notifications ? request.method !== "PATCH" : create ? request.method !== "POST" : entry ? !["PATCH", "DELETE"].includes(request.method) : !restore || request.method !== "POST") return invalid();
    if (create) {
        if (typeof request.idempotencyKey !== "string" || !/^[\x21-\x7e]{1,128}$/.test(request.idempotencyKey) || request.version !== undefined) return invalid();
    } else if (typeof request.version !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]{1,512}$/.test(request.version) || request.idempotencyKey !== undefined) return invalid();
    if (request.method === "DELETE" || restore) {
        if (request.body !== undefined) return invalid();
    } else if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) return invalid();
    else {
        const body = request.body as Record<string, unknown>;
        if (notifications) {
            const keys = Object.keys(body);
            if (!keys.length || keys.some(key => !["discordEnabled", "projects"].includes(key))
                || ("discordEnabled" in body && typeof body.discordEnabled !== "boolean")) return invalid();
            if ("projects" in body) {
                if (!Array.isArray(body.projects) || body.projects.length < 1 || body.projects.length > 2) return invalid();
                const seen = new Set<string>();
                for (const value of body.projects) {
                    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
                    const row = value as Record<string, unknown>;
                    if (Object.keys(row).length !== 2 || !Object.prototype.hasOwnProperty.call(row, "project")
                        || !Object.prototype.hasOwnProperty.call(row, "discordReminderMinutes")
                        || !["majestic", "russia-online"].includes(row.project as string) || seen.has(row.project as string)) return invalid();
                    const minutes = row.discordReminderMinutes;
                    if (minutes !== null && (!Number.isSafeInteger(minutes) || (minutes as number) < 1 || (minutes as number) > 120)) return invalid();
                    seen.add(row.project as string);
                }
            }
            return "notifications:settings:write";
        }
        const folder = (create?.[1] ?? entry?.[1]) === "folders";
        const fields = folder ? ["title", "position", ...(create ? ["project"] : [])]
            : ["title", "text", "project", "shared", "command", "color", "folderId"];
        if (!Object.keys(body).length || Object.keys(body).some(k => !fields.includes(k))) return invalid();
        if (create && (body.title === undefined || (!folder && body.text === undefined))) return invalid();
        for (const [key, value] of Object.entries(body)) {
            if (key === "title" || key === "text") {
                if (typeof value !== "string" || !value.trim() || value.length > (key === "text" ? 20000 : folder ? 120 : 160)
                    || (key === "text" ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) return invalid();
            } else if (key === "project") { if (!["majestic", "russia-online"].includes(value as string)) return invalid(); }
            else if (key === "shared") { if (typeof value !== "boolean") return invalid(); }
            else if (key === "position") { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100000) return invalid(); }
            else if (value !== null) {
                if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
                if (key === "command" && (value.length > 40 || /[\s/]/u.test(value))) return invalid();
                if (key === "folderId" && !/^[1-9]\d{0,19}$/.test(value)) return invalid();
                if (key === "color" && !/^[a-z][a-z0-9_-]{0,39}$/.test(value)) return invalid();
            }
        }
    }
    return (create?.[1] ?? entry?.[1]) === "folders" ? "folders:write" : "personal:write";
}

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
    const allowedOrigin = u.origin === trustedOrigin || (trustedOrigin === PANEL_ORIGIN && u.origin === PANEL_LOGIN_ORIGIN);
    if (!allowedOrigin || u.username || u.password || u.pathname !== "/connect" || u.hash) return invalid();
    // Deployed links use code; retain user_code compatibility. Exactly one matching code, no redirects/tokens.
    if ([...u.searchParams.keys()].some(k => k !== "user_code" && k !== "code")) return invalid();
    const codes = [...u.searchParams.getAll("user_code"), ...u.searchParams.getAll("code")];
    if (complete ? codes.length !== 1 || codes[0] !== userCode : codes.length !== 0) return invalid();
    return trustedOrigin + "/connect";
}

export function parseDeviceAuthorization(value: unknown, trustedOrigin = PANEL_ORIGIN): DeviceAuthorization {
    const r = record(value);
    const trusted = origin(trustedOrigin);
    const userCode = string(r.user_code, 128);
    const expiresIn = positive(r.expires_in);
    const interval = positive(r.interval);
    if (interval >= expiresIn) return invalid();
    const verificationUri = verification(r.verification_uri, trusted, userCode, false);
    // Validate even the legacy complete link before constructing our destination.
    // Never carry redirect parameters, tokens or an untrusted origin into the browser.
    if (r.verification_uri_complete !== undefined) verification(r.verification_uri_complete, trusted, userCode, true);
    const complete = new URL(verificationUri);
    complete.searchParams.set("code", userCode);
    return {
        deviceCode: string(r.device_code), userCode,
        verificationUri,
        verificationUriComplete: complete.href,
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
