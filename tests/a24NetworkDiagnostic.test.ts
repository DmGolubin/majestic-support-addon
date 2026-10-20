import { afterEach, beforeEach, expect, it } from "vitest";
import { diagnosticJournal as journal } from "../src/core/diagnosticJournal";
import { networkFailureReason } from "../src/core/networkDiagnostic";
import { createPanelTransport } from "../src/core/panelTransport";
import { createPanelEventStream } from "../src/core/panelEvents";

beforeEach(() => journal.start({ read: () => null, write() {} }, { continuous: true }));
afterEach(() => journal.stop());

it("classifies structured failures without returning exception text or arbitrary codes", () => {
    expect(networkFailureReason({ cause: { code: "ECONNRESET", message: "PRIVATE_TOKEN" } })).toBe("connection_reset");
    expect(networkFailureReason({ code: "ENOTFOUND" })).toBe("dns_failure");
    expect(networkFailureReason({ code: "ETIMEDOUT" })).toBe("host_timeout");
    expect(networkFailureReason({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe("tls_error");
    expect(networkFailureReason({ code: "PRIVATE_TOKEN", message: "https://PRIVATE_HOST" })).toBe("unknown_failure");
    const cycle: any = {}; cycle.cause = cycle;
    expect(networkFailureReason(cycle)).toBe("unknown_failure");
    expect(networkFailureReason({ get code() { throw Error("PRIVATE"); } })).toBe("unknown_failure");
});

it("distinguishes failure before headers from an interrupted HTTP 200 response body", async () => {
    const headers = createPanelTransport(async () => { throw { code: "ECONNREFUSED", message: "PRIVATE" }; });
    await expect(headers("/me", {})).rejects.toMatchObject({ code: "network_error" });
    expect(journal.snapshot().events.find(e => e.event === "request.failure")?.data).toMatchObject({
        status: 0, phase: "headers", reason: "connection_refused", bytesReceived: 0
    });
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (!n++) controller.enqueue(new TextEncoder().encode('{"secret":"PRIVATE'));
            else controller.error({ code: "ECONNRESET", message: "PRIVATE_BODY_ERROR" });
        }
    });
    const transport = createPanelTransport(async () => new Response(body, { headers: { "Content-Type": "application/json" } }));
    await expect(transport("/snapshot", {})).rejects.toMatchObject({ code: "network_error", status: 200 });
    expect(journal.snapshot().events.filter(e => e.event === "request.failure").at(-1)?.data).toMatchObject({
        status: 200, phase: "body", reason: "connection_reset", bytesReceived: 18
    });
    expect(JSON.stringify(journal.snapshot())).not.toContain("PRIVATE");
});

it("logs SSE response-body failures separately without persisting event content", async () => {
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (!n++) controller.enqueue(new TextEncoder().encode(": PRIVATE_HEARTBEAT\n\n"));
            else controller.error({ code: "ERR_STREAM_PREMATURE_CLOSE" });
        }
    });
    const stream = createPanelEventStream(async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    await expect(stream("PRIVATE_TOKEN", new AbortController().signal, () => {})).rejects.toMatchObject({ code: "network_error", status: 200 });
    expect(journal.snapshot().events.find(e => e.event === "stream.transport_failure")?.data).toMatchObject({
        status: 200, phase: "body", reason: "connection_closed", bytesReceived: 21
    });
    expect(JSON.stringify(journal.snapshot())).not.toContain("PRIVATE");
});
