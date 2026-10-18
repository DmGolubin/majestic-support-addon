import { ReadableStream } from "node:stream/web";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PanelClient, PanelError } from "../src/core/panelClient";
import { PANEL_ORIGIN } from "../src/core/panelProtocol";
import { createPanelTransport } from "../src/core/panelTransport";

const MiB = 1024 * 1024;
const secret = "fixture-private-credential";
const encode = (text: string) => new TextEncoder().encode(text);
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
const mockFetch = (response: Response) => vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
    const cancel = vi.fn();
    let offset = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset < chunks.length) controller.enqueue(chunks[offset++]);
            else controller.close();
        },
        cancel
    }), { headers: { "Content-Type": "application/json", ...headers } });
    return { response, cancel };
}

async function failure(promise: Promise<unknown>): Promise<PanelError> {
    const error = await promise.then(() => { throw new Error("Expected failure"); }, e => e);
    expect(error).toBeInstanceOf(PanelError);
    // Include non-enumerable fields: message, stack and any accidental cause.
    const exposed = Object.getOwnPropertyNames(error).map(key => String(error[key])).join(" ");
    expect(exposed).not.toContain(secret);
    return error;
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("panel JSON transport", () => {
    it("completes device login through the actual URL builder and transport", async () => {
        vi.useFakeTimers();
        const scopes = "profile:read faq:read personal:read folders:read sync:read";
        const fetch = vi.fn<typeof globalThis.fetch>(async url => {
            if (String(url).endsWith("/oauth/device_authorization")) return json({
                device_code: "fixture-device", user_code: "TEST-CODE", expires_in: 600, interval: 5,
                verification_uri: PANEL_ORIGIN + "/connect", verification_uri_complete: PANEL_ORIGIN + "/connect?user_code=TEST-CODE"
            });
            if (String(url).endsWith("/oauth/token")) return json({
                access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 900,
                scope: scopes, connectionId: "11111111-2222-4333-8444-555555555555"
            });
            return json({ ok: true });
        });
        const client = new PanelClient(createPanelTransport(fetch));
        const device = vi.fn();
        const result = client.login(device).then(() => null, error => error);
        await vi.advanceTimersByTimeAsync(5000);
        expect(await result).toBeNull();
        expect(device).toHaveBeenCalledOnce();
        expect(fetch.mock.calls.map(([url]) => url)).toEqual([
            PANEL_ORIGIN + "/api/plugin/v1/oauth/device_authorization", PANEL_ORIGIN + "/api/plugin/v1/oauth/token"
        ]);
        expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
        expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({ client_id: "support-templates", scope: scopes });
        await client.get("/me");
        expect(fetch.mock.calls[2][1]?.headers).toMatchObject({ Authorization: "Bearer fixture-access" });
        client.dispose();
    });

    it("uses the fixed API base, Bearer header and no cookies/cache/redirect following", async () => {
        const fetch = mockFetch(json({ accountId: "123" }));
        await expect(createPanelTransport(fetch)("/me", { token: secret })).resolves.toEqual({ accountId: "123" });
        const [url, options] = fetch.mock.calls[0];
        expect(url).toBe(PANEL_ORIGIN + "/api/plugin/v1/me");
        expect(options).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
        expect(options?.body).toBeUndefined();
        expect(options?.headers).toEqual({ Accept: "application/json", Authorization: "Bearer " + secret });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([null, false, 0, { refresh_token: secret }])("uses POST whenever body is defined (%j)", async body => {
        const fetch = mockFetch(json({ ok: true }));
        await createPanelTransport(fetch)("/oauth/token", { body });
        expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
        expect(fetch.mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
    });

    it("supports an explicitly trusted HTTPS staging origin", async () => {
        const fetch = mockFetch(json({ ok: true }));
        await createPanelTransport(fetch, "https://staging.example.test")("/snapshot", {});
        expect(fetch.mock.calls[0][0]).toBe("https://staging.example.test/api/plugin/v1/snapshot");
    });

    it.each(["http://panel.example", "https://user:pass@panel.example", "https://panel.example/path", "https://panel.example/?secret=x", "https://panel.example/#fragment"])("rejects unsafe origin %s before fetch", origin => {
        const fetch = vi.fn<typeof globalThis.fetch>();
        expect(() => createPanelTransport(fetch, origin)).toThrow(PanelError);
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each(["https://evil.example/me", "//evil.example/me", "/../oauth/token", "/%2e%2e/me", "/me?token=" + secret, "/me#" + secret, "/me\\other"])("rejects unsafe paths before fetch", async path => {
        const fetch = vi.fn<typeof globalThis.fetch>();
        expect(await failure(createPanelTransport(fetch)(path, {}))).toMatchObject({ code: "invalid_request", status: 0 });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("sanitizes invalid headers and failed body serialization", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>();
        const transport = createPanelTransport(fetch);
        const body = { toJSON() { throw new Error(secret); } };
        for (const options of [{ token: secret + "\r\nCookie: x" }, { body }, { body: 1n }, { body: () => secret }]) {
            expect(await failure(transport("/oauth/token", options))).toMatchObject({ code: "invalid_request" });
        }
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([301, 302, 303, 307, 308])("rejects redirect status %i without another request", async status => {
        const fetch = mockFetch(new Response(null, { status, headers: { Location: "https://evil.example/" + secret } }));
        expect(await failure(createPanelTransport(fetch)("/me", {}))).toMatchObject({ code: "redirect_not_allowed", status });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("rejects a followed redirect or a response from a different URL", async () => {
        for (const property of [{ redirected: true }, { url: "https://evil.example/" + secret }]) {
            const response = json({ ok: true });
            for (const [key, value] of Object.entries(property)) Object.defineProperty(response, key, { value });
            expect(await failure(createPanelTransport(mockFetch(response))("/me", {}))).toMatchObject({ code: "redirect_not_allowed" });
        }
    });

    it("sanitizes fetch failures and never retries a refresh request", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(secret));
        expect(await failure(createPanelTransport(fetch)("/oauth/token", { body: { refresh_token: secret } }))).toMatchObject({ code: "network_error", status: 0 });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
        [400, "authorization_pending"], [400, "slow_down"], [400, "access_denied"],
        [400, "expired_token"], [401, "session_revoked"], [401, "invalid_token"],
        [403, "insufficient_scope"], [503, "plugin_disabled"]
    ])("maps structured server code at status %i", async (status, code) => {
        const fetch = mockFetch(json({ code, error: secret, requestId: secret }, status));
        expect(await failure(createPanelTransport(fetch)("/oauth/token", { body: {} }))).toMatchObject({ code, status });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([[429, "rate_limited"], [503, "service_unavailable"], [401, "unauthorized"], [403, "forbidden"], [500, "http_error"]])("does not echo unknown server codes at status %i", async (status, code) => {
        const response = json({ code: secret, error: secret }, status, { "Retry-After": "12" });
        expect(await failure(createPanelTransport(mockFetch(response))("/snapshot", {}))).toMatchObject({ code, status, retryAfterMs: 12_000 });
    });

    it("parses Retry-After HTTP dates, including dates already elapsed", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-18T10:00:00Z"));
        for (const [date, delay] of [["Sun, 18 Oct 2026 10:00:30 GMT", 30_000], ["Sun, 18 Oct 2026 09:59:00 GMT", 0]] as const) {
            const fetch = mockFetch(json({ code: "plugin_disabled" }, 503, { "Retry-After": date }));
            expect(await failure(createPanelTransport(fetch)("/me", {}))).toMatchObject({ retryAfterMs: delay });
        }
    });

    it.each(["-1", "1.5", "Infinity", "999999999999999999999999999", secret])("ignores invalid Retry-After %s", async value => {
        const fetch = mockFetch(json({ code: "rate_limited" }, 429, { "Retry-After": value }));
        expect((await failure(createPanelTransport(fetch)("/me", {}))).retryAfterMs).toBeUndefined();
    });

    it.each([
        ["<html>" + secret + "</html>", "text/html"],
        ["<html>" + secret + "</html>", "application/json"],
        ['{"secret":"' + secret, "application/json"],
        ["{}", "text/plain"], ["null", "application/json"], ["[]", "application/json"],
        ['"' + secret + '"', "application/json"], ["", "application/json"]
    ])("rejects malformed/non-object/non-JSON responses without echoing them", async (body, mime) => {
        const fetch = mockFetch(new Response(body, { headers: { "Content-Type": mime } }));
        expect(await failure(createPanelTransport(fetch)("/me", {}))).toMatchObject({ code: "invalid_response", status: 200 });
    });

    it("retains status and Retry-After when a proxy sends an HTML error", async () => {
        const fetch = mockFetch(new Response(secret, { status: 503, statusText: secret, headers: { "Content-Type": "text/html", "Retry-After": "9" } }));
        expect(await failure(createPanelTransport(fetch)("/me", {}))).toMatchObject({ code: "invalid_response", status: 503, retryAfterMs: 9000 });
    });

    it("decodes split UTF-8 correctly and rejects malformed UTF-8 rather than replacing it", async () => {
        const bytes = encode('{"text":"я"}');
        const good = streamed([...bytes].map(byte => Uint8Array.of(byte)));
        await expect(createPanelTransport(mockFetch(good.response))("/snapshot", {})).resolves.toEqual({ text: "я" });
        for (const chunks of [[encode('{"text":"'), Uint8Array.of(0xff), encode('"}')], [encode('{"text":"'), Uint8Array.of(0xd0)]]) {
            expect(await failure(createPanelTransport(mockFetch(streamed(chunks).response))("/me", {}))).toMatchObject({ code: "invalid_response" });
        }
    });

    it.each([["/oauth/token", MiB], ["/snapshot", 16 * MiB]] as const)("accepts exactly the byte limit for %s", async (path, limit) => {
        const text = '{"x":"' + "x".repeat(limit - 8) + '"}';
        const response = streamed([encode(text)]).response;
        const value = await createPanelTransport(mockFetch(response))(path, {}) as { x: string };
        expect(value.x.length).toBe(limit - 8);
    });

    it.each([["/oauth/token", MiB], ["/snapshot", 16 * MiB]] as const)("caps streaming bytes for %s even with a lying Content-Length", async (path, limit) => {
        const block = new Uint8Array(MiB).fill(32);
        const chunks = [...Array.from({ length: limit / MiB }, () => block), Uint8Array.of(32), encode(secret)];
        const { response, cancel } = streamed(chunks, { "Content-Length": "1" });
        expect(await failure(createPanelTransport(mockFetch(response))(path, {}))).toMatchObject({ code: "response_too_large", status: 200 });
        expect(cancel).toHaveBeenCalled();
    });

    it("rejects a declared oversize response before acquiring its reader", async () => {
        const { response, cancel } = streamed([encode("{}")], { "Content-Length": String(MiB + 1) });
        const getReader = vi.spyOn(response.body!, "getReader");
        expect(await failure(createPanelTransport(mockFetch(response))("/oauth/token", {}))).toMatchObject({ code: "response_too_large" });
        expect(getReader).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalled();
    });

    it("sanitizes mid-stream failure", async () => {
        const response = new Response(new ReadableStream({ pull(controller) { controller.error(new Error(secret)); } }), { headers: { "Content-Type": "application/json" } });
        expect(await failure(createPanelTransport(mockFetch(response))("/snapshot", {}))).toMatchObject({ code: "network_error", status: 200 });
    });

    it("aborts at 15 seconds even if fetch ignores the signal", async () => {
        vi.useFakeTimers();
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}));
        const result = failure(createPanelTransport(fetch)("/oauth/token", { body: { refresh_token: secret } }));
        await vi.advanceTimersByTimeAsync(15_000);
        expect(await result).toMatchObject({ code: "timeout" });
        expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("times out and cancels a body that stalls after headers arrive", async () => {
        vi.useFakeTimers();
        const cancel = vi.fn();
        const response = new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "application/json" } });
        const result = failure(createPanelTransport(mockFetch(response))("/snapshot", {}));
        await vi.advanceTimersByTimeAsync(15_000);
        expect(await result).toMatchObject({ code: "timeout" });
        expect(cancel).toHaveBeenCalled();
        expect(response.body?.locked).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not fetch for an already-aborted caller", async () => {
        const controller = new AbortController();
        controller.abort(new Error(secret));
        const fetch = vi.fn<typeof globalThis.fetch>();
        expect(await failure(createPanelTransport(fetch)("/me", { signal: controller.signal }))).toMatchObject({ code: "aborted" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("merges caller cancellation without forwarding its secret reason", async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}));
        const result = failure(createPanelTransport(fetch)("/me", { signal: controller.signal }));
        controller.abort(new Error(secret));
        expect(await result).toMatchObject({ code: "aborted" });
        const signal = fetch.mock.calls[0][1]?.signal;
        expect(signal?.aborted).toBe(true);
        expect(String(signal?.reason)).not.toContain(secret);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("cancels a stalled reader on caller abort", async () => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const cancel = vi.fn();
        const response = new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "application/json" } });
        const result = failure(createPanelTransport(mockFetch(response))("/snapshot", { signal: caller.signal }));
        await vi.advanceTimersByTimeAsync(0);
        caller.abort(new Error(secret));
        expect(await result).toMatchObject({ code: "aborted" });
        expect(cancel).toHaveBeenCalled();
        expect(response.body?.locked).toBe(false);
    });

    it("cleans up timers and caller listeners after success", async () => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const remove = vi.spyOn(caller.signal, "removeEventListener");
        const fetch = mockFetch(json({ ok: true }));
        await createPanelTransport(fetch)("/me", { signal: caller.signal });
        expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
        expect(vi.getTimerCount()).toBe(0);
        caller.abort();
        expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
    });

    it("does not log request or error secrets", async () => {
        const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info")].map(spy => spy.mockImplementation(() => {}));
        const fetch = mockFetch(json({ code: secret, error: secret, requestId: secret }, 500));
        await failure(createPanelTransport(fetch)("/oauth/token", { token: secret, body: { refresh_token: secret } }));
        for (const log of logs) expect(log).not.toHaveBeenCalled();
    });
});
