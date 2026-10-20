/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PanelError } from "./panelClient";
import { diagnosticJournal as journal } from "./diagnosticJournal";
import { networkFailureReason } from "./networkDiagnostic";
import { PANEL_ORIGIN, panelEndpoint } from "./panelProtocol";
import { createPanelTransport } from "./panelTransport";

export interface PanelEvent { type: string; data: unknown; }
export type PanelEventStream = (token: string, signal: AbortSignal, onEvent: (event: PanelEvent) => void) => Promise<void>;

const HANDSHAKE_MS = 15_000;
const FRAME_LIMIT = 64 * 1024;
const EVENT_TYPES = new Set([
    "library.changed", "permissions.changed", "resync.required", "tickets.changed",
    "tickets.unavailable", "token.expired", "session.revoked"
]);

/** Parse ASCII SSE framing before decoding bounded UTF-8 lines. No chunk-sized string
 * allocation, replay IDs, reconnection delays or assumptions about payload fields.
 */
function eventParser(emit: (event: PanelEvent) => boolean) {
    const line = new Uint8Array(FRAME_LIMIT);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let length = 0;
    let frameBytes = 0;
    let skipLF = false;
    let firstLine = true;
    let type = "";
    let data: string[] = [];

    function decodeLine() {
        let text: string;
        try { text = decoder.decode(line.subarray(0, length)); }
        catch { throw new PanelError("invalid_response", 200); }
        length = 0;
        if (firstLine) {
            firstLine = false;
            if (text.startsWith("\uFEFF")) text = text.slice(1);
        }
        return text;
    }

    function endLine(): boolean {
        const text = decodeLine();
        if (text === "") {
            const eventType = type;
            const payload = data;
            type = "";
            data = [];
            frameBytes = 0;
            // SSE frames without data do not dispatch. Unknown events are forward-compatible.
            if (!payload.length || !EVENT_TYPES.has(eventType)) return false;
            const opaque = payload.join("\n");
            let value: unknown = opaque;
            // The delivered contract specifies event names, not a JSON data schema.
            // Empty/plain-text payloads still carry actionable control events.
            try { value = JSON.parse(opaque); } catch { /* Keep opaque SSE data. */ }
            return emit({ type: eventType, data: value });
        }
        if (text.startsWith(":")) return false;
        const colon = text.indexOf(":");
        const field = colon < 0 ? text : text.slice(0, colon);
        let value = colon < 0 ? "" : text.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") type = value;
        else if (field === "data") data.push(value);
        // id/retry and other fields intentionally do not affect the controller.
        return false;
    }

    return {
        push(bytes: Uint8Array): boolean {
            for (const byte of bytes) {
                if (skipLF) {
                    skipLF = false;
                    if (byte === 10) continue;
                }
                if (++frameBytes > FRAME_LIMIT) throw new PanelError("response_too_large", 200);
                if (byte === 10 || byte === 13) {
                    skipLF = byte === 13;
                    if (endLine()) return true;
                } else line[length++] = byte;
            }
            return false;
        },
        finish() {
            // EOF is not an SSE dispatch delimiter. Discard incomplete events, but still
            // reject a truncated/malformed UTF-8 sequence in the final unterminated line.
            if (length) decodeLine();
        }
    };
}

/** Opens exactly one connection. EOF/terminal events resolve; abort/failures reject.
 * The delivered contract promises no heartbeat, so there is no speculative idle timeout.
 * The controller owns reconnect, fresh snapshots, refresh and revocation decisions.
 */
export function createPanelEventStream(fetchImpl = globalThis.fetch, trustedOrigin = PANEL_ORIGIN): PanelEventStream {
    let url: string;
    try { url = panelEndpoint("/sync/events", trustedOrigin); }
    catch { throw new PanelError("invalid_request"); }

    return async (token, signal, onEvent) => {
        if (typeof token !== "string" || !token || token.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(token)) throw new PanelError("invalid_request");
        if (signal.aborted) throw new PanelError("aborted");
        const controller = new AbortController();
        let reader: {
            read(): Promise<{ done: boolean; value?: Uint8Array }>;
            cancel(): Promise<void>;
            releaseLock(): void;
        } | undefined;
        let cancellation: PanelError | undefined;
        let terminal = false;
        let status = 0;
        let phase = "headers", reason = "unknown_failure", bytesReceived = 0;
        const started = Date.now();
        let rejectCancellation!: (error: PanelError) => void;
        const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
        const abort = (code: string) => {
            if (cancellation || terminal) return;
            cancellation = new PanelError(code);
            rejectCancellation(cancellation);
            controller.abort();
            void reader?.cancel().catch(() => {});
        };
        const callerAbort = () => abort("aborted");
        signal.addEventListener("abort", callerAbort, { once: true });
        const timer = setTimeout(() => abort("timeout"), HANDSHAKE_MS);

        const request = async () => {
            let response: Response;
            try {
                const init: RequestInit & { cache: "no-store"; referrerPolicy: "no-referrer" } = {
                    method: "GET",
                    headers: { Accept: "text/event-stream", Authorization: "Bearer " + token },
                    credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
                    signal: controller.signal
                };
                response = await fetchImpl(url, init);
            } catch (error) { reason = networkFailureReason(error); throw cancellation ?? new PanelError("network_error"); }
            const discard = () => { void response.body?.cancel().catch(() => {}); };
            if (cancellation) { discard(); throw cancellation; }
            status = response.status;
            phase = "validation";
            journal.record("stream.http", { route: "/sync/events", status });
            if (response.redirected || (status >= 300 && status < 400) || (response.url && response.url !== url)) {
                discard();
                throw new PanelError("redirect_not_allowed", status);
            }
            if (!response.ok) {
                // Reuse the JSON transport's bounded error parsing, code allowlist and
                // Retry-After handling, consuming this response without another request.
                await createPanelTransport(async () => response, trustedOrigin)("/sync/events", { signal: controller.signal });
                return;
            }
            const mime = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
            if (status !== 200 || mime !== "text/event-stream" || !response.body) {
                discard();
                throw new PanelError("invalid_response", status);
            }
            clearTimeout(timer);
            const parser = eventParser(event => {
                if (cancellation) throw cancellation;
                terminal = event.type === "token.expired" || event.type === "session.revoked";
                try { onEvent(event); }
                catch { throw new PanelError("callback_failed", status); }
                if (cancellation) throw cancellation;
                return terminal;
            });
            reader = response.body.getReader();
            phase = "body";
            try {
                while (true) {
                    let chunk: Awaited<ReturnType<typeof reader.read>>;
                    try { chunk = await reader.read(); }
                    catch (error) { reason = networkFailureReason(error); throw cancellation ?? new PanelError("network_error", status); }
                    if (cancellation) throw cancellation;
                    if (chunk.done) { parser.finish(); return; }
                    if (!chunk.value) throw new PanelError("invalid_response", status);
                    bytesReceived += chunk.value.byteLength;
                    if (parser.push(chunk.value)) return;
                }
            } finally {
                void reader.cancel().catch(() => {});
                reader.releaseLock();
                reader = undefined;
            }
        };

        try { await Promise.race([request(), cancelled]); }
        catch (error) {
            journal.record("stream.transport_failure", { route: "/sync/events", status, phase, bytesReceived,
                durationMs: Date.now() - started,
                code: cancellation?.code ?? (error instanceof PanelError ? error.code : "invalid_response"),
                reason: cancellation?.code === "timeout" ? "host_timeout" : cancellation ? "host_aborted" : reason }, true);
            if (cancellation) throw cancellation;
            if (error instanceof PanelError) throw error;
            throw new PanelError("invalid_response", status);
        } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", callerAbort);
            controller.abort();
        }
    };
}
