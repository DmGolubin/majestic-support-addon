/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    DeviceAuthorization, PANEL_CLIENT_ID, PANEL_ORIGIN, panelEndpoint, PanelTokens,
parseDeviceAuthorization, parsePanelTokens, slowerPolling,
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
    /** Reuse the same vault object across clients sharing one persisted slot. */
    vault?: PanelVault;
    /** Expected Discord snowflake; required whenever a vault is supplied. */
    accountId?: string;
}

interface PanelSessionBinding {
    version: 1;
    origin: string;
    clientId: string;
    accountId: string;
}

export type PanelSessionRecord = PanelSessionBinding & (
    | { state: "ready"; tokens: PanelTokens; expiresAt: number; }
    | { state: "rotating"; }
);

/** Implementations must atomically replace the record and resolve only after durable storage. */
export interface PanelVault {
    load(): Promise<unknown | null>;
    save(record: PanelSessionRecord): Promise<void>;
    clear(): Promise<void>;
}

interface VaultQueue {
    tail: Promise<void>;
    owner: symbol | null;
    interrupt: (() => void) | null;
    failed: boolean;
}

// Shared by successive clients, not just by operations within one client. Native adapters
// that create distinct wrappers for one slot must provide their own generation fencing.
const vaultQueues = new WeakMap<PanelVault, VaultQueue>();

const SCOPES = ["profile:read", "faq:read", "personal:read", "folders:read", "sync:read"] as const;
const safeError = (error: unknown): PanelError => error instanceof PanelError
    ? new PanelError(error.code, error.status, error.retryAfterMs)
    : new PanelError("transport_error");

interface Session {
    controller: AbortController;
    streamController: AbortController;
    deviceCode: string | null;
    tokens: PanelTokens | null;
    expiresAt: number;
    refresh: Promise<void> | null;
    closing: boolean;
    lease: symbol | null;
    streamToken: string | null;
}

/** The transport owns HTTP, an optional secure vault owns persistence, and this class owns session lifetime. */
export class PanelClient {
    #transport: PanelTransport;
    #now: () => number;
    #deviceName: string;
    #origin: string;
    #timeout: number;
    #session: Session | null = null;
    #vault?: PanelVault;
    #vaultQueue?: VaultQueue;
    #accountId?: string;
    #lease: symbol | null = null;

    constructor(transport: PanelTransport, options: PanelClientOptions = {}) {
        this.#transport = transport;
        this.#now = options.now ?? Date.now;
        this.#deviceName = options.deviceName ?? "Discord — SupportTemplates";
        this.#origin = options.trustedOrigin ?? PANEL_ORIGIN;
        this.#timeout = options.requestTimeoutMs ?? 15_000;
        if (!Number.isSafeInteger(this.#timeout) || this.#timeout <= 0 || this.#timeout > 2_147_483_647
            || !this.#deviceName.trim() || this.#deviceName.length > 80) throw new PanelError("invalid_options");
        this.#validatePath("/me");
        this.#origin = new URL(this.#origin).origin;
        if (options.vault && (!options.accountId || !/^[1-9][0-9]{16,19}$/.test(options.accountId)
            || BigInt(options.accountId) > 18446744073709551615n)) throw new PanelError("invalid_options");
        this.#vault = options.vault;
        this.#accountId = options.accountId;
        if (this.#vault) {
            let queue = vaultQueues.get(this.#vault);
            if (!queue) {
                queue = { tail: Promise.resolve(), owner: null, interrupt: null, failed: false };
                vaultQueues.set(this.#vault, queue);
            }
            this.#vaultQueue = queue;
        }
    }

    get connectionId(): string | null {
        const session = this.#session;
        return session && !session.closing && !session.controller.signal.aborted ? session.tokens?.connectionId ?? null : null;
    }

    /** Restores only a validated local binding; the controller must still verify /me. No network IO. */
    async restore(): Promise<boolean> {
        this.dispose();
        const session = this.#begin();
        if (!this.#vault) return false;
        try {
            const raw = await this.#queueVault(async () => {
                this.#assert(session);
                if (this.#vaultQueue!.failed) {
                    await this.#vault!.clear();
                    this.#vaultQueue!.failed = false;
                    return null;
                }
                return this.#vault!.load();
            });
            this.#assert(session);
            if (raw === null) return false;
            const record = this.#parseSaved(raw);
            if (!record) {
                await this.#clearVault(session.lease);
                this.#assert(session);
                return false;
            }
            session.tokens = record.tokens;
            session.expiresAt = record.expiresAt;
            return true;
        } catch (error) {
            await this.#terminate(session);
            throw safeError(error);
        }
    }

    async login(onDevice: (device: DeviceAuthorization) => void): Promise<void> {
        const previousCode = this.#session?.deviceCode;
        this.dispose();
        const session = this.#begin();
        try {
            await this.#clearVault(session.lease);
            this.#assert(session);
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
            let { interval } = device;
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
                    await this.#publish(session, this.#parseTokens(result), exchangedAt);
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
            await this.#terminate(session);
            throw safeError(error);
        }
    }

    async get(path: string): Promise<unknown> {
        this.#validatePath(path);
        const session = this.#session;
        if (!session?.tokens || session.closing || session.controller.signal.aborted) throw new PanelError("not_authenticated", 401);
        const result = await this.#authorized(session, token => {
            if (session.closing) throw new PanelError("cancelled");
            return this.#request(session, path, { token });
        });
        this.#assert(session);
        if (session.closing) throw new PanelError("cancelled");
        return result;
    }

    /** The operation owns stream parsing; its lifetime is bounded by the session, not an HTTP timeout. */
    async streamAuthorized<T>(operation: (token: string, signal: AbortSignal) => Promise<T>): Promise<T> {
        const session = this.#active();
        const result = await this.#authorized(session, token => this.#stream(session, token, operation));
        this.#assert(session);
        if (session.closing) throw new PanelError("cancelled");
        return result;
    }

    async refreshForStream(): Promise<void> {
        const session = this.#active();
        // An event from an old stream must not rotate a pair already refreshed by a GET.
        await this.#refresh(session, session.streamToken ?? session.tokens!.accessToken);
        this.#assert(session);
        if (session.closing) throw new PanelError("cancelled");
    }

    /** Clears locally immediately. Failure to cancel on the server rejects, including after exchange. */
    async cancel(): Promise<void> {
        const code = this.#session?.deviceCode;
        this.dispose();
        const cleanup = this.#begin(false);
        const clearing = this.#clearVault(cleanup.lease);
        try {
            let failure: unknown;
            try { await clearing; } catch (error) { failure = error; }
            try { if (code) await this.#request(cleanup, "/device-requests/cancel", { body: { device_code: code } }); }
            catch (error) { failure ??= error; }
            if (failure) throw failure;
        }
        finally { if (this.#session === cleanup) this.dispose(); }
    }

    /** Revocation may need a single rotation first. Failure is visible; local credentials are always cleared. */
    async logout(): Promise<void> {
        const session = this.#session;
        if (!session?.tokens) return this.cancel();
        if (session.closing) throw new PanelError("logout_in_progress");
        session.closing = true;
        session.streamController.abort();
        // Queue this synchronously, before remote IO. No cleanup after revocation may erase
        // a replacement client's session. Rotations while closing are never persisted.
        const clearing = this.#clearVault(session.lease);
        try {
            try { await clearing; }
            catch (error) {
                // Do not rotate with an uncleared reusable pair on disk. Still try revocation.
                try { await this.#request(session, "/oauth/revoke", { token: session.tokens?.accessToken, body: {} }); } catch {}
                throw error;
            }
            await this.#authorized(session, token => this.#request(session, "/oauth/revoke", { token, body: {} }));
        }
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
        session.streamToken = null;
        session.controller.abort();
        session.streamController.abort();
    }

    #begin(claim = true): Session {
        if (claim) {
            this.#lease = Symbol();
            this.#vaultQueue?.interrupt?.();
            if (this.#vaultQueue) this.#vaultQueue.owner = this.#lease;
        }
        const session: Session = { controller: new AbortController(), streamController: new AbortController(), deviceCode: null, tokens: null,
            expiresAt: 0, refresh: null, closing: false, lease: this.#lease, streamToken: null };
        this.#session = session;
        if (claim && this.#vaultQueue) this.#vaultQueue.interrupt = () => this.#drop(session);
        return session;
    }

    #assert(session: Session) {
        if (this.#session !== session || session.controller.signal.aborted
            || (this.#vaultQueue && this.#vaultQueue.owner !== session.lease)) throw new PanelError("cancelled");
    }

    #active(): Session {
        const session = this.#session;
        if (!session?.tokens || session.closing || session.controller.signal.aborted) throw new PanelError("not_authenticated", 401);
        this.#assert(session);
        return session;
    }

    async #terminate(session: Session): Promise<void> {
        const current = this.#session === session && !session.controller.signal.aborted;
        this.#drop(session);
        if (current && !session.closing) await this.#clearVault(session.lease);
    }

    #drop(session: Session) {
        // Keep the device code available for an explicit cancel after an uncertain exchange.
        session.tokens = null;
        session.expiresAt = 0;
        session.streamToken = null;
        session.controller.abort();
        session.streamController.abort();
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

    async #authorized<T>(session: Session, operation: (token: string) => Promise<T>): Promise<T> {
        this.#assert(session);
        if (session.refresh) await session.refresh;
        if (this.#now() >= session.expiresAt) await this.#refresh(session);
        this.#assert(session);
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = session.tokens?.accessToken;
            if (!token) throw new PanelError("not_authenticated", 401);
            try { return await operation(token); }
            catch (error) {
                this.#assert(session);
                const failure = safeError(error);
                if (failure.code === "session_revoked") { await this.#terminate(session); throw failure; }
                if (failure.status !== 401) throw failure;
                if (attempt) { await this.#terminate(session); throw failure; }
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
            // Durable write-ahead marker: a restart can never retry this single-use pair.
            await this.#saveVault(session, { ...this.#binding(), state: "rotating" });
            const raw = await this.#request(session, "/oauth/token", { body: {
                client_id: PANEL_CLIENT_ID, grant_type: "refresh_token", refresh_token: previous.refreshToken,
            } });
            this.#assert(session);
            const next = this.#parseTokens(raw);
            if (next.connectionId !== previous.connectionId) throw new PanelError("connection_mismatch");
            if (next.accessToken === previous.accessToken || next.refreshToken === previous.refreshToken) throw new PanelError("invalid_response");
            await this.#publish(session, next, started);
        } catch (error) {
            const failure = safeError(error);
            const interrupted = this.#session !== session || session.controller.signal.aborted;
            await this.#terminate(session);
            if (interrupted) throw new PanelError("cancelled");
            if (["session_revoked", "access_denied", "connection_mismatch", "vault_error"].includes(failure.code)) throw failure;
            // Any other failure may have consumed the refresh token. This is a terminal client
            // state, not a retryable HTTP failure (even when the original status was 429/503).
            throw new PanelError("refresh_uncertain");
        }
    }

    #binding(): PanelSessionBinding {
        return { version: 1, origin: this.#origin, clientId: PANEL_CLIENT_ID, accountId: this.#accountId! };
    }

    #parseSaved(raw: unknown): (PanelSessionBinding & { state: "ready"; tokens: PanelTokens; expiresAt: number; }) | null {
        try {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
            const r = raw as Record<string, unknown>;
            if (r.version !== 1 || r.state !== "ready" || r.origin !== this.#origin
                || r.clientId !== PANEL_CLIENT_ID || r.accountId !== this.#accountId
                || typeof r.expiresAt !== "number" || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= 0) return null;
            if (!r.tokens || typeof r.tokens !== "object" || Array.isArray(r.tokens)) return null;
            const t = r.tokens as Record<string, unknown>;
            if (!Array.isArray(t.scopes) || !t.scopes.every(scope => typeof scope === "string")) return null;
            const tokens = this.#parseTokens({ access_token: t.accessToken, refresh_token: t.refreshToken,
                token_type: "Bearer", expires_in: t.expiresIn, scope: t.scopes.join(" "), connectionId: t.connectionId });
            if (!Number.isSafeInteger(tokens.expiresIn * 1000) || r.expiresAt > this.#now() + tokens.expiresIn * 1000) return null;
            return { ...this.#binding(), state: "ready", tokens, expiresAt: r.expiresAt };
        } catch { return null; }
    }

    #queueVault<T>(operation: () => Promise<T>): Promise<T> {
        const queue = this.#vaultQueue!;
        const task = queue.tail.then(operation).catch(error => {
            if (error instanceof PanelError && error.code === "cancelled") throw error;
            queue.failed = true;
            throw new PanelError("vault_error");
        });
        queue.tail = task.then(() => {}, () => {});
        return task;
    }

    async #clearVault(lease: symbol | null): Promise<void> {
        // Fence when enqueuing. Once accepted, this clear must precede a later owner's
        // restore/save even if that owner claims the slot before native IO starts.
        if (!this.#vault || this.#vaultQueue!.owner !== lease) return;
        await this.#queueVault(async () => {
            await this.#vault!.clear();
            this.#vaultQueue!.failed = false;
        });
    }

    async #saveVault(session: Session, record: PanelSessionRecord): Promise<void> {
        if (!this.#vault || session.closing) return;
        await this.#queueVault(async () => {
            this.#assert(session);
            if (session.closing) return;
            try { await this.#vault!.save(record); }
            catch {
                // A rejecting native write may still have partially committed. Cleanup
                // stays in this queue slot, including when the caller was disposed.
                await this.#vault!.clear();
                throw new PanelError("vault_error");
            }
            // We hold the queue until cleanup completes: a newer owner's save cannot be
            // overwritten by this cleanup, even if disposal happened during native IO.
            if (this.#session !== session || session.controller.signal.aborted || session.closing
                || this.#vaultQueue!.owner !== session.lease) {
                await this.#vault!.clear();
                this.#assert(session);
            }
        });
    }

    async #publish(session: Session, tokens: PanelTokens, started: number): Promise<void> {
        const expiresAt = started + tokens.expiresIn * 1000;
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new PanelError("invalid_response");
        // A vault receives its own copy, never a reference to the live credential pair.
        await this.#saveVault(session, { ...this.#binding(), state: "ready",
            tokens: { ...tokens, scopes: [...tokens.scopes] }, expiresAt });
        this.#assert(session);
        session.tokens = tokens;
        session.expiresAt = expiresAt;
    }

    async #stream<T>(session: Session, token: string, operation: (token: string, signal: AbortSignal) => Promise<T>): Promise<T> {
        this.#assert(session);
        if (session.closing) throw new PanelError("cancelled");
        const { signal } = session.streamController;
        let abort = () => {};
        try {
            const result = await new Promise<T>((resolve, reject) => {
                abort = () => reject(new PanelError("cancelled"));
                signal.addEventListener("abort", abort, { once: true });
                Promise.resolve().then(() => {
                    this.#assert(session);
                    if (signal.aborted) throw new PanelError("cancelled");
                    session.streamToken = token;
                    return operation(token, signal);
                }).then(resolve, reject);
            });
            this.#assert(session);
            return result;
        } catch (error) {
            this.#assert(session);
            throw safeError(error);
        } finally { signal.removeEventListener("abort", abort); }
    }

    #sleep(session: Session, ms: number): Promise<void> {
        this.#assert(session);
        return new Promise((resolve, reject) => {
            const { signal } = session.controller;
            const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new PanelError("cancelled")); };
            const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.min(ms, 2_147_483_647));
            signal.addEventListener("abort", abort, { once: true });
        });
    }

    async #request(session: Session, path: string, options: { body?: unknown; token?: string; }, timeout = this.#timeout): Promise<unknown> {
        this.#assert(session);
        const controller = new AbortController();
        const { signal } = session.controller;
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
