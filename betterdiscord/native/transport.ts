// SPDX-License-Identifier: GPL-3.0-or-later
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { PANEL_API_PATH, PANEL_ORIGIN, panelEndpoint } from "../../src/core/panelProtocol";

/** Native HTTPS has no Discord cookies, renderer CSP, proxy credentials or redirects.
 * Keep streaming: the shared transports enforce JSON/SSE size and deadline bounds.
 * The request implementation is injectable solely for isolated tests.
 */
export function makePanelFetch(request: typeof httpsRequest = httpsRequest): typeof fetch {
    return (async (input: any, init: RequestInit = {}) => {
        const url = new URL(String(input));
        const path = url.pathname.slice(PANEL_API_PATH.length);
        if (url.origin !== PANEL_ORIGIN || url.username || url.password || url.search || url.hash
            || !url.pathname.startsWith(PANEL_API_PATH + "/") || panelEndpoint(path) !== url.href) throw new Error("Panel endpoint denied");
        const method = init.method ?? "GET";
        if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) throw new Error("Panel method denied");
        const headers: Record<string, string> = {};
        new Headers(init.headers).forEach((value, key) => {
            if (!["accept", "content-type", "authorization", "idempotency-key", "if-match"].includes(key)
                || /[\r\n]/.test(value)) throw new Error("Panel header denied");
            headers[key] = value;
        });
        if (init.body !== undefined && (typeof init.body !== "string" || Buffer.byteLength(init.body) > 1024 * 1024)) throw new Error("Panel body denied");
        if (init.signal?.aborted) throw new Error("Panel request aborted");
        return await new Promise<Response>((resolve, reject) => {
            let response: any;
            const fail = () => new Error("Panel network request failed");
            const req = request(url, { method, headers, agent: false, rejectUnauthorized: true }, incoming => {
                response = incoming;
                const status = incoming.statusCode ?? 0;
                if (status < 200 || status >= 300) {
                    if (status < 200 || status >= 300 && status < 400) {
                        incoming.destroy(); reject(fail()); return;
                    }
                }
                const resultHeaders = new Headers();
                for (const [key, value] of Object.entries(incoming.headers)) {
                    if (value !== undefined) resultHeaders.set(key, Array.isArray(value) ? value.join(", ") : String(value));
                }
                const body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
                // Leave no-content semantics to the shared protocol, including future DELETE contracts.
                const noBody = [204, 205, 304].includes(status);
                if (noBody) incoming.resume();
                try { resolve(new Response(noBody ? null : body, { status, headers: resultHeaders })); }
                catch { incoming.destroy(); reject(fail()); }
            });
            const abort = () => { response?.destroy(); req.destroy(fail()); };
            init.signal?.addEventListener("abort", abort, { once: true });
            req.once("error", () => reject(fail()));
            req.once("close", () => init.signal?.removeEventListener("abort", abort));
            if (init.signal?.aborted) { abort(); return; }
            req.end(init.body);
        });
    }) as typeof fetch;
}
export const panelFetch = makePanelFetch();
