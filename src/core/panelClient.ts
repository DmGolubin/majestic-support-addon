/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    DeviceAuthorization, PANEL_CLIENT_ID, PANEL_ORIGIN, PanelTokens,
    panelEndpoint, parseDeviceAuthorization, parsePanelTokens, slowerPolling,
} from "./panelProtocol";

export type PanelTransport = (path: string, options: {
    body?: unknown;
    token?: string;
    signal?: AbortSignal;
}) => Promise<unknown>;

/** No server body, token, URL or underlying exception message belongs in this error. */
export class PanelError extends Error {
    constructor(public readonly code: string, public readonly status = 0, public readonly retryAfterMs?: number) {
        super("Panel request failed.");
        this.name = "PanelError";
    }
}

export interface PanelClientOptions {
    /** Milliseconds; injected clocks must advance together with timers. */
    now?: () => number;
    deviceName?: string;
    trustedOrigin?: string;
    requestTimeoutMs?: number;
}

const SCOPES = ["profile:read", "faq:read", "personal:read", "folders:read", "sync:read"] as const;
const safeError = (error: unknown): PanelError => error instanceof PanelError
    ? new PanelError(error.code, error.status, error.retryAfterMs)
    : new PanelError("transport_error");

interface Session {
    controller: AbortController;
    deviceCode: string | null;
    tokens: PanelTokens | null;
    expiresAt: number;
    refresh: Promise<void> | null;
    closing: boolean;
}

/** Memory-only device-flow client. The transport owns HTTP; this class owns session lifetime. */
export class PanelClient {
    #transport: PanelTransport;
    #now: () => number;
    #deviceName: string;
    #origin: string;
    #timeout: number;
    #session: Session | null = null;

    constructor(transport: PanelTransport, options: PanelClientOptions = {}) {
        this.#transport = transport;
        this.#now = options.now ?? Date.now;
        this.#deviceName = options.deviceName ?? "Discord — SupportTemplates";
        this.#origin = options.trustedOrigin ?? PANEL_ORIGIN;
        this.#timeout = options.requestTimeoutMs ?? 15_000;
        if (!Number.isSafeInteger(this.#timeout) || this.#timeout <= 0 || this.#timeout > 2_147_483_647
            || !this.#deviceName.trim() || this.#deviceName.length > 80) throw new PanelError("invalid_options");
        this.#validatePath("/me");
    }

    get connectionId(): string | null {
        const session = this.#session;
        return session && !session.closing && !session.controller.signal.aborted ? session.tokens?.connectionId ?? null : null;
    }

    async login(onDevice: (device: DeviceAuthorization) => void): Promise<void> {
        const previousCode = this.#session?.deviceCode;
        this.dispose();
        const session = this.#begin();
        try {
            // Also cancels an exchanged previous attempt; cancellation is bound to its device code.
            if (previousCode) await this.#request(session, "/device-requests/cancel", { body: { device_code: previousCode } });
            const started = this.#now();
            const raw = await this.#request(session, "/oauth/device_authorization", { body: {
                client_id: PANEL_CLIENT_ID, device_name: this.#deviceName, scope: SCOPES.join(" "),
            } });
            let device: DeviceAuthorization;
            try { device = parseDeviceAuthorization(raw, this.#origin); }
            catch { throw new PanelError("invalid_response"); }
            session.deviceCode = device.deviceCode;
            const deadline = started + device.expiresIn * 1000;
            let interval = device.interval;
            let retryAfter = 0;
            if (this.#now() >= deadline) throw new PanelError("expired_token", 400);
            try { onDevice({ ...device }); }
            catch { throw new PanelError("callback_failed"); }
            for (;;) {
                this.#assert(session);
                const remaining = deadline - this.#now();
                if (remaining <= 0) throw new PanelError("expired_token", 400);
                await this.#sleep(session, Math.min(remaining, Math.max(interval * 1000, retryAfter)));
                if (this.#now() >= deadline) throw new PanelError("expired_token", 400);
                const exchangedAt = this.#now();
                try {
                    const result = await this.#request(session, "/oauth/token", { body: {
                        client_id: PANEL_CLIENT_ID, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.deviceCode,
                    } }, deadline - this.#now());
                    this.#assert(session);
                    if (this.#now() >= deadline) throw new PanelError("expired_token", 400);
                    session.tokens = this.#parseTokens(result);
                    session.expiresAt = exchangedAt + session.tokens.expiresIn * 1000;
                    return;
                } catch (error) {
                    this.#assert(session);
                    const failure = safeError(error);
                    if (this.#now() >= deadline) throw new PanelError("expired_token", 400);
                    if (failure.status !== 400 || !["authorization_pending", "slow_down"].includes(failure.code)) throw failure;
                    if (failure.code === "slow_down") interval = slowerPolling(interval);
                    retryAfter = Number.isFinite(failure.retryAfterMs) ? Math.max(0, failure.retryAfterMs!) : 0;
                }
            }
        } catch (error) {
            this.#drop(session);
            throw safeError(error);
        }
    }

    async get(path: string): Promise<unknown> {
        this.#validatePath(path);
        const session = this.#session;
        if (!session?.tokens || session.closing || session.controller.signal.aborted) throw new PanelError("not_authenticated", 401);
        const result = await this.#authorized(session, path);
        this.#assert(session);
        if (session.closing) throw new PanelError("cancelled");
        return result;
    }

    /** Clears locally immediately. Failure to cancel on the server rejects, including after exchange. */
    async cancel(): Promise<void> {
        const code = this.#session?.deviceCode;
        this.dispose();
        if (!code) return;
        const cleanup = this.#begin();
        try { await this.#request(cleanup, "/device-requests/cancel", { body: { device_code: code } }); }
        finally { if (this.#session === cleanup) this.dispose(); }
    }

    /** Revocation may need a single rotation first. Failure is visible; local credentials are always cleared. */
    async logout(): Promise<void> {
        const session = this.#session;
        if (!session?.tokens) return this.cancel();
        if (session.closing) throw new PanelError("logout_in_progress");
        session.closing = true;
        try { await this.#authorized(session, "/oauth/revoke", {}); }
        finally { if (this.#session === session) this.dispose(); }
    }

    /** Local teardown only: no remote request and no UI/mode selection. */
    dispose(): void {
        const session = this.#session;
        this.#session = null;
        if (!session) return;
        session.tokens = null;
        session.deviceCode = null;
        session.expiresAt = 0;
        session.controller.abort();
    }

    #begin(): Session {
        return this.#session = { controller: new AbortController(), deviceCode: null, tokens: null, expiresAt: 0, refresh: null, closing: false };
    }

    #assert(session: Session) {
        if (this.#session !== session || session.controller.signal.aborted) throw new PanelError("cancelled");
    }

    #drop(session: Session) {
        // Keep the device code available for an explicit cancel after an uncertain exchange.
        session.tokens = null;
        session.expiresAt = 0;
        session.controller.abort();
    }

    #validatePath(path: string) {
        try { panelEndpoint(path, this.#origin); }
        catch { throw new PanelError("invalid_path"); }
    }

    #parseTokens(raw: unknown): PanelTokens {
        try {
            const tokens = parsePanelTokens(raw);
            if (tokens.scopes.length !== SCOPES.length || !SCOPES.every(scope => tokens.scopes.includes(scope))) throw new Error();
            return tokens;
        } catch { throw new PanelError("invalid_response"); }
    }

    async #authorized(session: Session, path: string, body?: unknown): Promise<unknown> {
        this.#assert(session);
        if (session.refresh) await session.refresh;
        if (this.#now() >= session.expiresAt) await this.#refresh(session);
        this.#assert(session);
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = session.tokens?.accessToken;
            if (!token) throw new PanelError("not_authenticated", 401);
            try { return await this.#request(session, path, { token, ...(body === undefined ? {} : { body }) }); }
            catch (error) {
                this.#assert(session);
                const failure = safeError(error);
                if (failure.code === "session_revoked") { this.#drop(session); throw failure; }
                if (failure.status !== 401) throw failure;
                if (attempt) { this.#drop(session); throw failure; }
                // A delayed 401 for the previous access token must not rotate the new pair again.
                await this.#refresh(session, token);
            }
        }
        throw new PanelError("not_authenticated", 401);
    }

    async #refresh(session: Session, rejectedToken?: string): Promise<void> {
        this.#assert(session);
        if (session.refresh) return session.refresh;
        if (rejectedToken && session.tokens?.accessToken !== rejectedToken) return;
        const rotating = this.#rotate(session);
        session.refresh = rotating;
        try { await rotating; }
        finally { if (session.refresh === rotating) session.refresh = null; }
    }

    async #rotate(session: Session): Promise<void> {
        const previous = session.tokens;
        if (!previous) throw new PanelError("not_authenticated", 401);
        const started = this.#now();
        try {
            const raw = await this.#request(session, "/oauth/token", { body: {
                client_id: PANEL_CLIENT_ID, grant_type: "refresh_token", refresh_token: previous.refreshToken,
            } });
            this.#assert(session);
            const next = this.#parseTokens(raw);
            if (next.connectionId !== previous.connectionId) throw new PanelError("connection_mismatch");
            if (next.accessToken === previous.accessToken || next.refreshToken === previous.refreshToken) throw new PanelError("invalid_response");
            // Publish both credentials together before any blocked request is allowed to retry.
            session.tokens = next;
            session.expiresAt = started + next.expiresIn * 1000;
        } catch (error) {
            const failure = safeError(error);
            const interrupted = this.#session !== session || session.controller.signal.aborted;
            this.#drop(session);
            if (interrupted) throw new PanelError("cancelled");
            if (["session_revoked", "access_denied", "connection_mismatch"].includes(failure.code)) throw failure;
            // Any other failure may have consumed the refresh token. This is a terminal client
            // state, not a retryable HTTP failure (even when the original status was 429/503).
            throw new PanelError("refresh_uncertain");
        }
    }

    #sleep(session: Session, ms: number): Promise<void> {
        this.#assert(session);
        return new Promise((resolve, reject) => {
            const signal = session.controller.signal;
            const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new PanelError("cancelled")); };
            const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.min(ms, 2_147_483_647));
            signal.addEventListener("abort", abort, { once: true });
        });
    }

    async #request(session: Session, path: string, options: { body?: unknown; token?: string; }, timeout = this.#timeout): Promise<unknown> {
        this.#assert(session);
        const controller = new AbortController();
        const signal = session.controller.signal;
        let timer: ReturnType<typeof setTimeout>;
        let abort = () => {};
        try {
            const result = await new Promise<unknown>((resolve, reject) => {
                abort = () => { clearTimeout(timer); controller.abort(); reject(new PanelError("cancelled")); };
                signal.addEventListener("abort", abort, { once: true });
                timer = setTimeout(() => { controller.abort(); reject(new PanelError("request_timeout")); }, Math.min(timeout, this.#timeout));
                // Race cancellation even when an injected transport ignores AbortSignal.
                Promise.resolve().then(() => {
                    this.#assert(session);
                    return this.#transport(path, { ...options, signal: controller.signal });
                }).then(resolve, reject);
            });
            this.#assert(session);
            return result;
        } catch (error) {
            this.#assert(session);
            throw safeError(error);
        } finally {
            clearTimeout(timer!);
            signal.removeEventListener("abort", abort);
        }
    }
}
