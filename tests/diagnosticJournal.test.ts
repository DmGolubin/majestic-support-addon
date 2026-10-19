import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticJournal, diagnosticData, diagnosticJournal, diagnosticRoute, DIAGNOSTIC_TTL } from "../src/core/diagnosticJournal";
import { createPanelTransport } from "../src/core/panelTransport";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { diagnosticJournal.stop(); diagnosticJournal.clear(); vi.clearAllTimers(); vi.useRealTimers(); });
function setup() {
    let text: string | null = null;
    const storage = { read: () => text, write: vi.fn((value: string) => { text = value; }) };
    const journal = new DiagnosticJournal(); journal.start(storage);
    return { journal, storage, raw: () => text };
}
describe("bounded file diagnostics", () => {
    it("does no recording or scheduling until explicitly enabled", () => {
        const { journal, storage } = setup();
        journal.record("request.start", { route: "/me" });
        expect(journal.size).toBe(0); expect(storage.write).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
        journal.stop();
    });
    it("resumes a bounded saved recording after restart without storing credentials", () => {
        const h = setup(); h.journal.enable(true);
        h.journal.record("auth.terminated", { code: "session_revoked", status: 401, token: "SECRET", message: "CHAT" }, true);
        h.journal.stop();
        const second = new DiagnosticJournal(); second.start(h.storage);
        expect(second.active).toBe(true);
        expect(second.snapshot().events.some(e => e.event === "auth.terminated" && e.data.code === "session_revoked")).toBe(true);
        expect(h.raw()).not.toMatch(/SECRET|CHAT/);
        expect(second.snapshot().events.at(-1)?.event).toBe("runtime.start"); second.stop();
    });
    it("batches ordinary writes and flushes fatal evidence immediately", async () => {
        const { journal, storage } = setup(); journal.enable(true); storage.write.mockClear();
        for (let i = 0; i < 100; i++) journal.record("ui.state", { count: i });
        expect(storage.write).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(2);
        await vi.advanceTimersByTimeAsync(5000); expect(storage.write).toHaveBeenCalledTimes(1);
        journal.record("auth.terminated", { code: "refresh_uncertain" }, true);
        expect(storage.write).toHaveBeenCalledTimes(2); journal.stop(); expect(vi.getTimerCount()).toBe(0);
    });
    it("limits event count and serialized size under a flood", () => {
        const h = setup(); h.journal.enable(true);
        for (let i = 0; i < 10000; i++) h.journal.record("ui.state", { count: i, query: "x".repeat(10000) });
        h.journal.flush();
        expect(h.journal.size).toBeLessThanOrEqual(2000); expect(h.raw()!.length).toBeLessThanOrEqual(512 * 1024);
        expect(h.journal.snapshot().dropped).toBeGreaterThan(0); h.journal.stop();
    });
    it("expires after 24 hours and drops old evidence", async () => {
        const h = setup(); h.journal.enable(true); h.journal.record("ui.state");
        await vi.advanceTimersByTimeAsync(DIAGNOSTIC_TTL + 1);
        expect(h.journal.active).toBe(false); expect(h.journal.snapshot().events).toEqual([]); expect(vi.getTimerCount()).toBe(0); h.journal.stop();
    });
    it("survives corrupt or unavailable persistence and keeps in-memory export", () => {
        const journal = new DiagnosticJournal();
        journal.start({ read: () => "broken", write: () => { throw Error("disk full SECRET"); } });
        expect(() => journal.enable(true)).not.toThrow();
        journal.record("request.failure", { code: "network_error" }, true);
        expect(journal.storageFailed).toBe(true); expect(journal.size).toBeGreaterThan(0); expect(() => journal.stop()).not.toThrow();
    });
    it("validates persisted event payloads again, strips secrets and does not expose mutable entries", () => {
        const journal = new DiagnosticJournal();
        journal.start({ read: () => JSON.stringify({ schema: 1, until: Date.now() + 10000, events: [{ seq: 1, time: Date.now(), event: "request.failure", data: { code: "SECRET", status: 403, headers: { Authorization: "Bearer SECRET" } } }] }), write() {} });
        const snapshot = journal.snapshot(); expect(JSON.stringify(snapshot)).not.toContain("SECRET");
        snapshot.events[0].data.status = 999; expect(journal.snapshot().events[0].data.status).toBe(403); journal.stop();
    });
    it("clears stored evidence while preserving the recording preference", () => {
        const h = setup(); h.journal.enable(true); h.journal.record("ui.state", {}, true); h.journal.clear();
        expect(h.journal.active).toBe(true); expect(JSON.parse(h.raw()!).events).toEqual([]); h.journal.enable(false);
        h.journal.stop(); const second = new DiagnosticJournal(); second.start(h.storage); expect(second.active).toBe(false); second.stop();
    });
    it("uses metadata allowlists rather than regex-only secret masking", () => {
        expect(diagnosticData({ code: "a-super-secret", query: "chat", title: "private", message: "secret", id: 123, route: "/personal/private-token", status: 401,
            body: { password: "pw" }, headers: { cookie: "cookie" }, durationMs: 9.15, ok: false })).toEqual({ code: "unknown", route: "/personal/:id", status: 401, durationMs: 9.15, ok: false });
        expect(diagnosticRoute("/me?token=secret")).toBe("unknown");
    });
    it("can clear a saved report from the host panel after plugin stop", () => {
        const h = setup(); h.journal.enable(true); h.journal.record("auth.terminated", { code: "session_revoked" }, true);
        h.journal.stop(); h.journal.clear();
        expect(JSON.parse(h.raw()!).events).toEqual([]); expect(vi.getTimerCount()).toBe(0);
    });
    it("records real HTTP status, correlation and duration, never request or response contents", async () => {
        diagnosticJournal.start({ read: () => null, write() {} }); diagnosticJournal.enable(true);
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: "session_revoked", secret: "RESPONSE_SECRET" }), { status: 401, headers: { "Content-Type": "application/json" } }));
        const transport = createPanelTransport(fetcher);
        await expect(transport("/me", { token: "ACCESS_SECRET" })).rejects.toMatchObject({ code: "session_revoked" });
        const events = diagnosticJournal.snapshot().events;
        const start = events.find(e => e.event === "request.start")!;
        expect(events.find(e => e.event === "request.failure")?.data).toMatchObject({ requestId: start.seq, status: 401, route: "/me", code: "session_revoked" });
        expect(JSON.stringify(events)).not.toMatch(/ACCESS_SECRET|RESPONSE_SECRET|Authorization/);
    });
    it("records successful status without inventing a status for transport failure", async () => {
        diagnosticJournal.start({ read: () => null, write() {} }); diagnosticJournal.enable(true);
        await createPanelTransport(async () => new Response('{}', { status: 201, headers: { "Content-Type": "application/json" } }))("/me", {});
        await expect(createPanelTransport(async () => { throw Error("private URL secret"); })("/me", {})).rejects.toMatchObject({ code: "network_error" });
        expect(diagnosticJournal.snapshot().events.find(e => e.event === "request.success")?.data.status).toBe(201);
        expect(diagnosticJournal.snapshot().events.find(e => e.event === "request.failure")?.data.status).toBe(0);
    });
});
