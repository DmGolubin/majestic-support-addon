import { ReadableStream } from "node:stream/web";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PanelError } from "../src/core/panelClient";
import { createPanelEventStream, type PanelEvent } from "../src/core/panelEvents";
import { PANEL_ORIGIN } from "../src/core/panelProtocol";
import { diagnosticJournal } from "../src/core/diagnosticJournal";

const secret = "fixture-private-sse-token";
const encode = (text: string) => new TextEncoder().encode(text);
const frame = (type = "library.changed", data = "{}") => `event: ${type}\ndata: ${data}\n\n`;
const mockFetch = (response: Response) => vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
const freshSignal = () => new AbortController().signal;

function sse(chunks: Uint8Array[], close = true) {
    let offset = 0;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset < chunks.length) controller.enqueue(chunks[offset++]);
            else if (close) controller.close();
        }, cancel
    }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
    return { response, cancel };
}

async function failure(promise: Promise<unknown>): Promise<PanelError> {
    const error = await promise.then(() => { throw new Error("Expected failure"); }, e => e);
    expect(error).toBeInstanceOf(PanelError);
    expect(Object.getOwnPropertyNames(error).map(key => String(error[key])).join(" ")).not.toContain(secret);
    return error;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("panel SSE stream", () => {
    it("distinguishes a header timeout from an intentional shutdown in diagnostics", async () => {
        vi.useFakeTimers();
        const log = vi.spyOn(diagnosticJournal, "record");
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}));
        const result = failure(createPanelEventStream(fetch)(secret, freshSignal(), vi.fn()));
        await vi.advanceTimersByTimeAsync(15000); await result;
        expect(log).toHaveBeenCalledWith("stream.transport_failure", expect.objectContaining({
            phase: "headers", reason: "headers_timeout", status: 0, bytesReceived: 0, durationMs: 15000
        }), true);
        log.mockClear();
        const caller = new AbortController();
        const cancelled = failure(createPanelEventStream(fetch)(secret, caller.signal, vi.fn()));
        caller.abort(); await cancelled;
        expect(log.mock.calls.some(([name]) => name === "stream.transport_failure")).toBe(false);
        expect(log).toHaveBeenCalledWith("stream.cancelled", expect.objectContaining({ reason: "host_aborted" }), false);
    });

    it("records the handshake and first control event once without logging SSE payloads", async () => {
        const log = vi.spyOn(diagnosticJournal, "record");
        const response = sse([encode(frame("resync.required", secret) + frame())]).response;
        await createPanelEventStream(mockFetch(response))(secret, freshSignal(), vi.fn());
        expect(log.mock.calls.filter(([name]) => name === "stream.connected")).toHaveLength(1);
        expect(log.mock.calls.filter(([name]) => name === "stream.first_event")).toHaveLength(1);
        expect(log).toHaveBeenCalledWith("stream.first_event", expect.objectContaining({ event: "resync.required", status: 200 }));
        expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    });

    it("uses one fixed authenticated request with no cookies, cache, redirects or referrer", async () => {
        const fetch = mockFetch(sse([encode(frame("resync.required"))]).response);
        const onEvent = vi.fn();
        await createPanelEventStream(fetch)(secret, freshSignal(), onEvent);
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe(PANEL_ORIGIN + "/api/plugin/v1/sync/events");
        expect(init).toMatchObject({ method: "GET", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
        expect(init?.headers).toEqual({ Accept: "text/event-stream", Authorization: "Bearer " + secret });
        expect(init?.body).toBeUndefined();
        expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: "resync.required", data: {} });
    });

    it("allows an explicitly configured HTTPS staging origin", async () => {
        const fetch = mockFetch(sse([]).response);
        await createPanelEventStream(fetch, "https://staging.example.test")(secret, freshSignal(), vi.fn());
        expect(fetch.mock.calls[0][0]).toBe("https://staging.example.test/api/plugin/v1/sync/events");
    });

    it.each(["http://panel.example", "https://user:pass@panel.example", "https://panel.example/path", "https://panel.example/?token=x", "https://panel.example/#x"])("rejects unsafe configuration %s before fetch", origin => {
        const fetch = vi.fn<typeof globalThis.fetch>();
        expect(() => createPanelEventStream(fetch, origin)).toThrow(PanelError);
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each(["", secret + "\r\nCookie: x", secret + " ", "x".repeat(4097)])("rejects invalid tokens without exposing them", async token => {
        const fetch = vi.fn<typeof globalThis.fetch>();
        expect(await failure(createPanelEventStream(fetch)(token, freshSignal(), vi.fn()))).toMatchObject({ code: "invalid_request" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([1, 2, 3, 7, 1024])("handles BOM, split UTF-8 and CRLF at chunk size %i", async size => {
        const bytes = encode('\uFEFF: hello\r\nevent: resync.required\r\ndata: {"text":"я😀"}\r\n\r\n' + frame("permissions.changed", '{"revision":"new"}'));
        const chunks = Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.slice(i * size, (i + 1) * size));
        const events: PanelEvent[] = [];
        await createPanelEventStream(mockFetch(sse(chunks).response))(secret, freshSignal(), event => events.push(event));
        expect(events).toEqual([{ type: "resync.required", data: { text: "я😀" } }, { type: "permissions.changed", data: { revision: "new" } }]);
    });

    it.each(["\n", "\r\n", "\r"])("supports SSE line ending %j and multiline data", async newline => {
        const text = [": heartbeat", "event: library.changed", 'data: {"revision":', 'data: "next"}', "", ""].join(newline);
        const onEvent = vi.fn();
        await createPanelEventStream(mockFetch(sse([encode(text)]).response))(secret, freshSignal(), onEvent);
        expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: "library.changed", data: { revision: "next" } });
    });

    it("ignores comments, unknown fields/events, IDs/retry and frames without data", async () => {
        const text = ": comment\n\nevent: library.changed\n\nevent: session.revoked\n\n" +
            "event: future.event\ndata: not-json\n\ndata: {}\n\n" +
            "id: " + secret + "\nretry: 0\nunknown: x\nevent: ignored\nevent: tickets.changed\ndata:{}\n\n";
        const fetch = mockFetch(sse([encode(text)]).response);
        const onEvent = vi.fn();
        await createPanelEventStream(fetch)(secret, freshSignal(), onEvent);
        expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: "tickets.changed", data: {} });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][1]?.headers).not.toHaveProperty("Last-Event-ID");
    });

    it.each(["library.changed", "permissions.changed", "resync.required", "tickets.changed", "tickets.unavailable"])("delivers supported nonterminal event %s", async type => {
        const onEvent = vi.fn();
        await createPanelEventStream(mockFetch(sse([encode(frame(type))]).response))(secret, freshSignal(), onEvent);
        expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type, data: {} });
    });

    it.each([null, [1, 2], false, 7, "value", { nested: [1], text: "\uFEFF" }])("does not invent a schema for valid JSON data %j", async data => {
        const onEvent = vi.fn();
        await createPanelEventStream(mockFetch(sse([encode(frame("resync.required", JSON.stringify(data)))]).response))(secret, freshSignal(), onEvent);
        expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: "resync.required", data });
    });

    it.each([
        ["token.expired", "{}"], ["token.expired", ""], ["token.expired", "expired"],
        ["session.revoked", "{}"], ["session.revoked", ""], ["session.revoked", "revoked"]
    ])("delivers %s with data %j once, cancels the connection and ignores remaining bytes", async (type, payload) => {
        const leading = encode(frame(type, payload));
        const bytes = new Uint8Array(leading.length + 100_000);
        bytes.set(leading); bytes.fill(0xff, leading.length);
        const { response, cancel } = sse([bytes], false);
        const fetch = mockFetch(response);
        const caller = new AbortController();
        const onEvent = vi.fn(() => caller.abort(new Error(secret)));
        await expect(createPanelEventStream(fetch)(secret, caller.signal, onEvent)).resolves.toBeUndefined();
        expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type, data: payload === "{}" ? {} : payload });
        expect(cancel).toHaveBeenCalled();
        expect(response.body?.locked).toBe(false);
        expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each(["", "{", "undefined", "plain-control-text"])("delivers bounded opaque data %j when it is not JSON", async data => {
        const onEvent = vi.fn();
        await createPanelEventStream(mockFetch(sse([encode(frame("library.changed", data))]).response))(secret, freshSignal(), onEvent);
        expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: "library.changed", data });
    });

    it("rejects invalid UTF-8, including truncated UTF-8 at EOF", async () => {
        for (const bytes of [Uint8Array.of(0xff, 10), Uint8Array.of(0xd0)]) {
            expect(await failure(createPanelEventStream(mockFetch(sse([bytes]).response))(secret, freshSignal(), vi.fn()))).toMatchObject({ code: "invalid_response" });
        }
    });

    it("does not dispatch an incomplete event at EOF", async () => {
        const onEvent = vi.fn();
        const text = frame("resync.required") + 'event: session.revoked\ndata: {}\n';
        await createPanelEventStream(mockFetch(sse([encode(text)]).response))(secret, freshSignal(), onEvent);
        expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: "resync.required", data: {} });
    });

    it.each([
        "data: " + "x".repeat(64 * 1024),
        "event: library.changed\n" + "data: 1\n".repeat(9000),
        ":" + "x".repeat(64 * 1024)
    ])("caps unterminated lines and aggregate frames", async text => {
        const { response, cancel } = sse([encode(text)], false);
        expect(await failure(createPanelEventStream(mockFetch(response))(secret, freshSignal(), vi.fn()))).toMatchObject({ code: "response_too_large" });
        expect(cancel).toHaveBeenCalled();
        expect(response.body?.locked).toBe(false);
    });

    it("resets the cap per frame rather than imposing a stream lifetime cap", async () => {
        const text = frame("library.changed", JSON.stringify({ text: "x".repeat(40_000) }));
        const onEvent = vi.fn();
        await createPanelEventStream(mockFetch(sse([encode(text.repeat(4))]).response))(secret, freshSignal(), onEvent);
        expect(onEvent).toHaveBeenCalledTimes(4);
    });

    it.each([[401, "session_revoked"], [401, "invalid_token"], [429, "rate_limited"], [503, "plugin_disabled"]])("maps bounded HTTP errors at status %i", async (status, code) => {
        const response = new Response(JSON.stringify({ code, error: secret }), { status, headers: { "Content-Type": "application/json", "Retry-After": "7" } });
        const fetch = mockFetch(response);
        const onEvent = vi.fn();
        expect(await failure(createPanelEventStream(fetch)(secret, freshSignal(), onEvent))).toMatchObject({ code, status, retryAfterMs: 7000 });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(onEvent).not.toHaveBeenCalled();
    });

    it("preserves Retry-After dates and sanitizes unknown HTTP error codes", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-18T10:00:00Z"));
        const response = new Response(JSON.stringify({ code: secret }), { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "Sun, 18 Oct 2026 10:00:30 GMT" } });
        expect(await failure(createPanelEventStream(mockFetch(response))(secret, freshSignal(), vi.fn()))).toMatchObject({ code: "service_unavailable", status: 503, retryAfterMs: 30_000 });
    });

    it("rejects oversized HTTP error bodies using the JSON transport limit", async () => {
        const response = new Response("x".repeat(1024 * 1024 + 1), { status: 429, headers: { "Content-Type": "application/json" } });
        expect(await failure(createPanelEventStream(mockFetch(response))(secret, freshSignal(), vi.fn()))).toMatchObject({ code: "response_too_large", status: 429 });
    });

    it.each(["text/html", "application/json", "text/plain", ""])("rejects non-SSE success MIME %s", async mime => {
        const response = new Response(secret, { headers: { "Content-Type": mime } });
        expect(await failure(createPanelEventStream(mockFetch(response))(secret, freshSignal(), vi.fn()))).toMatchObject({ code: "invalid_response", status: 200 });
    });

    it("preserves status and delay for an HTML proxy error", async () => {
        const response = new Response(secret, { status: 503, headers: { "Content-Type": "text/html", "Retry-After": "9" } });
        expect(await failure(createPanelEventStream(mockFetch(response))(secret, freshSignal(), vi.fn()))).toMatchObject({ code: "invalid_response", status: 503, retryAfterMs: 9000 });
    });

    it.each([301, 302, 307, 308])("rejects HTTP redirect %i", async status => {
        const response = new Response(null, { status, headers: { Location: "https://evil.example/" + secret } });
        const fetch = mockFetch(response);
        expect(await failure(createPanelEventStream(fetch)(secret, freshSignal(), vi.fn()))).toMatchObject({ code: "redirect_not_allowed", status });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("rejects already-followed redirects and wrong response URLs", async () => {
        for (const props of [{ redirected: true }, { url: "https://evil.example/" + secret }]) {
            const { response } = sse([]);
            for (const [key, value] of Object.entries(props)) Object.defineProperty(response, key, { value });
            expect(await failure(createPanelEventStream(mockFetch(response))(secret, freshSignal(), vi.fn()))).toMatchObject({ code: "redirect_not_allowed" });
        }
    });

    it("sanitizes fetch/reader failures without reconnecting", async () => {
        const response = new Response(new ReadableStream({ pull(controller) { controller.error(new Error(secret)); } }), { headers: { "Content-Type": "text/event-stream" } });
        for (const fetch of [vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(secret)), mockFetch(response)]) {
            expect(await failure(createPanelEventStream(fetch)(secret, freshSignal(), vi.fn()))).toMatchObject({ code: "network_error" });
            expect(fetch).toHaveBeenCalledTimes(1);
        }
    });

    it("sanitizes callback exceptions, stops dispatch and closes the reader", async () => {
        const { response, cancel } = sse([encode(frame().repeat(2))], false);
        const onEvent = vi.fn(() => { throw new PanelError(secret); });
        expect(await failure(createPanelEventStream(mockFetch(response))(secret, freshSignal(), onEvent))).toMatchObject({ code: "callback_failed" });
        expect(onEvent).toHaveBeenCalledTimes(1);
        expect(cancel).toHaveBeenCalled();
    });

    it("times out a stalled handshake even when fetch ignores abort", async () => {
        vi.useFakeTimers();
        let resolve!: (value: Response) => void;
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(done => { resolve = done; }));
        const onEvent = vi.fn();
        const result = failure(createPanelEventStream(fetch)(secret, freshSignal(), onEvent));
        await vi.advanceTimersByTimeAsync(15_000);
        expect(await result).toMatchObject({ code: "timeout" });
        expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
        const { response, cancel } = sse([encode(frame())], false);
        resolve(response);
        await vi.advanceTimersByTimeAsync(0);
        expect(onEvent).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not impose an idle timeout without a contractual heartbeat", async () => {
        vi.useFakeTimers();
        const { response, cancel } = sse([encode(": heartbeat\n\n")], false);
        const caller = new AbortController();
        let settled = false;
        const result = failure(createPanelEventStream(mockFetch(response))(secret, caller.signal, vi.fn()));
        void result.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(settled).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        caller.abort(new Error(secret));
        expect(await result).toMatchObject({ code: "aborted" });
        expect(cancel).toHaveBeenCalled();
        expect(response.body?.locked).toBe(false);
    });

    it("does not request when the caller is already aborted", async () => {
        const caller = new AbortController();
        caller.abort(new Error(secret));
        const fetch = vi.fn<typeof globalThis.fetch>();
        expect(await failure(createPanelEventStream(fetch)(secret, caller.signal, vi.fn()))).toMatchObject({ code: "aborted" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("aborts a pending handshake and removes the caller listener", async () => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const remove = vi.spyOn(caller.signal, "removeEventListener");
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}));
        const result = failure(createPanelEventStream(fetch)(secret, caller.signal, vi.fn()));
        caller.abort(new Error(secret));
        expect(await result).toMatchObject({ code: "aborted" });
        const signal = fetch.mock.calls[0][1]?.signal;
        expect(signal?.aborted).toBe(true);
        expect(String(signal?.reason)).not.toContain(secret);
        expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
        expect(vi.getTimerCount()).toBe(0);
    });

    it("stops immediately if the callback aborts on a nonterminal event", async () => {
        const caller = new AbortController();
        const onEvent = vi.fn(() => caller.abort(new Error(secret)));
        const { response, cancel } = sse([encode(frame().repeat(2))], false);
        expect(await failure(createPanelEventStream(mockFetch(response))(secret, caller.signal, onEvent))).toMatchObject({ code: "aborted" });
        expect(onEvent).toHaveBeenCalledTimes(1);
        expect(cancel).toHaveBeenCalled();
    });

    it("cleans up on EOF without retrying or logging", async () => {
        vi.useFakeTimers();
        const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info")].map(spy => spy.mockImplementation(() => {}));
        const caller = new AbortController();
        const remove = vi.spyOn(caller.signal, "removeEventListener");
        const fetch = mockFetch(sse([encode(": " + secret + "\n\n")]).response);
        await createPanelEventStream(fetch)(secret, caller.signal, vi.fn());
        expect(vi.getTimerCount()).toBe(0);
        expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
        expect(fetch).toHaveBeenCalledTimes(1);
        for (const log of logs) expect(log).not.toHaveBeenCalled();
    });
});
