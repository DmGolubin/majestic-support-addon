/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PanelError, type PanelTransport } from "./panelClient";
import { diagnosticJournal as journal } from "./diagnosticJournal";
import { PANEL_ORIGIN, panelEndpoint, panelMutationScope } from "./panelProtocol";

const TIMEOUT_MS = 15_000;
const SMALL_LIMIT = 1024 * 1024;
const SNAPSHOT_LIMIT = 16 * SMALL_LIMIT;
// Never expose arbitrary server text, even in the machine-readable error code.
const SERVER_CODES = new Set([
    "authorization_pending", "slow_down", "access_denied", "expired_token",
    "invalid_request", "invalid_client", "invalid_grant", "invalid_scope", "invalid_token",
    "session_revoked", "plugin_disabled", "unauthorized", "forbidden", "insufficient_scope",
    "rate_limited", "not_found", "version_required", "version_conflict",
    "idempotency_conflict", "name_exists", "ticket_state_unavailable"
]);

function retryAfter(value: string | null): number | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
        const ms = Number(trimmed) * 1000;
        return Number.isSafeInteger(ms) ? ms : undefined;
    }
    // Do not let Date.parse interpret malformed numeric delays as calendar dates.
    if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) return undefined;
    const ms = Date.parse(trimmed) - Date.now();
    return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

function fallbackCode(status: number): string {
    if (status === 429) return "rate_limited";
    if (status === 503) return "service_unavailable";
    if (status === 401) return "unauthorized";
    if (status === 403) return "forbidden";
    return "http_error";
}

/** JSON requests only. SSE and schema validation belong to separate protocol layers.
 * trustedOrigin is trusted application configuration, never a user/API-provided URL.
 * A failed request is never retried here: a refresh token may already have rotated.
 */
export function createPanelTransport(fetchImpl = globalThis.fetch, trustedOrigin = PANEL_ORIGIN): PanelTransport {
    try { panelEndpoint("/me", trustedOrigin); }
    catch { throw new PanelError("invalid_request"); }

    return async (path, options = {}) => {
        let url: string;
        let body: string | undefined;
        try {
            url = panelEndpoint(path, trustedOrigin);
            // These endpoints never accept an implicit POST body (OAuth endpoints still do).
            if ((path === "/tickets/assigned" || path === "/notification-settings")
                && options.body !== undefined && options.method === undefined) throw new Error();
            if (options.method !== undefined || options.idempotencyKey !== undefined || options.version !== undefined) {
                if (!options.method || !options.token) throw new Error();
                panelMutationScope({ ...options, path, method: options.method });
            }
            if (options.body !== undefined) {
                body = JSON.stringify(options.body);
                if (body === undefined) throw new Error();
            }
            if (options.token !== undefined && (!options.token || options.token.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(options.token))) throw new Error();
        } catch { throw new PanelError("invalid_request"); }
        if (options.signal?.aborted) throw new PanelError("aborted");

        const controller = new AbortController();
        let cancellation: PanelError | undefined;
        let reader: {
            read(): Promise<{ done: boolean; value?: Uint8Array }>;
            cancel(): Promise<void>;
            releaseLock(): void;
        } | undefined;
        let rejectCancellation!: (error: PanelError) => void;
        const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
        const abort = (code: string) => {
            if (cancellation) return;
            cancellation = new PanelError(code);
            rejectCancellation(cancellation);
            // Do not propagate the caller's arbitrary abort reason (it may contain secrets).
            controller.abort();
            void reader?.cancel().catch(() => {});
        };
        const callerAbort = () => abort("aborted");
        options.signal?.addEventListener("abort", callerAbort, { once: true });
        const timer = setTimeout(() => abort("timeout"), TIMEOUT_MS);
        let status = 0;
        let delay: number | undefined;
        const started = Date.now();
        const requestId = journal.record("request.start", { route: path, method: options.method ?? (body === undefined ? "GET" : "POST") });

        const request = async (): Promise<unknown> => {
            let response: Response;
            try {
                // Node's fetch types omit some browser RequestInit fields used by Electron.
                const init: RequestInit & { cache: "no-store"; referrerPolicy: "no-referrer" } = {
                    method: options.method ?? (body === undefined ? "GET" : "POST"),
                    body,
                    headers: {
                        Accept: "application/json",
                        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                        ...(options.token === undefined ? {} : { Authorization: "Bearer " + options.token }),
                        ...(options.idempotencyKey === undefined ? {} : { "Idempotency-Key": options.idempotencyKey }),
                        ...(options.version === undefined ? {} : { "If-Match": '"' + options.version + '"' })
                    },
                    credentials: "omit",
                    redirect: "error",
                    cache: "no-store",
                    referrerPolicy: "no-referrer",
                    signal: controller.signal
                };
                response = await fetchImpl(url, init);
            } catch { throw cancellation ?? new PanelError("network_error"); }

            const discard = () => { void response.body?.cancel().catch(() => {}); };
            if (cancellation) { discard(); throw cancellation; }
            status = response.status;
            delay = retryAfter(response.headers.get("Retry-After"));
            if (response.redirected || (status >= 300 && status < 400) || (response.url && response.url !== url)) {
                discard();
                throw new PanelError("redirect_not_allowed", status);
            }
            const limit = path === "/snapshot" ? SNAPSHOT_LIMIT : SMALL_LIMIT;
            const length = response.headers.get("Content-Length");
            if (length && /^\d+$/.test(length.trim()) && Number(length) > limit) {
                discard();
                throw new PanelError("response_too_large", status, delay);
            }
            const mime = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
            if (mime !== "application/json" || !response.body) {
                discard();
                throw new PanelError("invalid_response", status, delay);
            }

            const decoder = new TextDecoder("utf-8", { fatal: true });
            const pieces: string[] = [];
            let bytes = 0;
            reader = response.body.getReader();
            try {
                while (true) {
                    let chunk: Awaited<ReturnType<typeof reader.read>>;
                    try { chunk = await reader.read(); }
                    catch { throw cancellation ?? new PanelError("network_error", status, delay); }
                    if (cancellation) throw cancellation;
                    if (chunk.done) break;
                    if (!chunk.value) throw new PanelError("invalid_response", status, delay);
                    bytes += chunk.value.byteLength;
                    if (bytes > limit) throw new PanelError("response_too_large", status, delay);
                    try { pieces.push(decoder.decode(chunk.value, { stream: true })); }
                    catch { throw new PanelError("invalid_response", status, delay); }
                }
                let value: unknown;
                try {
                    pieces.push(decoder.decode());
                    value = JSON.parse(pieces.join(""));
                } catch { throw new PanelError("invalid_response", status, delay); }
                if (!value || typeof value !== "object" || Array.isArray(value)) throw new PanelError("invalid_response", status, delay);
                if (!response.ok) {
                    const { code } = value as Record<string, unknown>;
                    throw new PanelError(typeof code === "string" && SERVER_CODES.has(code) ? code : fallbackCode(status), status, delay);
                }
                return value;
            } finally {
                // Best effort cancellation must not delay timeout/error delivery.
                void reader.cancel().catch(() => {});
                reader.releaseLock();
                reader = undefined;
            }
        };

        try {
            const value = await Promise.race([request(), cancelled]);
            journal.record("request.success", { requestId, route: path, status, durationMs: Date.now() - started });
            return value;
        }
        catch (error) {
            journal.record("request.failure", { requestId, route: path, status, durationMs: Date.now() - started,
                code: cancellation?.code ?? (error instanceof PanelError ? error.code : "invalid_response"), retryAfterMs: delay }, true);
            if (cancellation) throw cancellation;
            if (error instanceof PanelError) throw error;
            throw new PanelError("invalid_response", status, delay);
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", callerAbort);
        }
    };
}
