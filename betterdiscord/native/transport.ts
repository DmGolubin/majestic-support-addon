// SPDX-License-Identifier: GPL-3.0-or-later
import { PANEL_API_PATH, PANEL_ORIGIN, panelEndpoint } from "../../src/core/panelProtocol";
import { api } from "../shims/host";

/** Use BD's supported streaming network bridge. Renderer require('https') is only
 * a legacy get() polyfill; stream and node:* are not available at all.
 */
export function makePanelFetch(netFetch: (input: string, init: any) => Promise<Response> = (input, init) => api().Net.fetch(input, init)): typeof fetch {
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
        try {
            const response = await netFetch(url.href, {
                method, headers, body: init.body, signal: init.signal,
                credentials: "omit", redirect: "error", maxRedirects: 0,
                rejectUnauthorized: true, timeout: null // Shared JSON/SSE layers own deadlines.
            });
            if (response.redirected || (response.url && response.url !== url.href)
                || response.status < 200 || response.status >= 300 && response.status < 400) {
                await response.body?.cancel().catch(() => {});
                throw new Error("Unexpected panel redirect");
            }
            return response;
        } catch { throw new Error("Panel network request failed"); }
    }) as typeof fetch;
}
export const panelFetch = makePanelFetch();
