import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticJournal, DIAGNOSTIC_CAMPAIGN_DURATION, DIAGNOSTIC_TTL } from "../src/core/diagnosticJournal";

const campaign = "mvp-file-2026-10";
const options = { campaign, durationMs: DIAGNOSTIC_CAMPAIGN_DURATION };
const epoch = 1_800_000_000_000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(epoch); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function storage(initial: string | null = null) {
    let text = initial;
    const adapter = { read: vi.fn(() => text), write: vi.fn((value: string) => { text = value; }) };
    return { adapter, raw: () => text!, saved: () => JSON.parse(text!) };
}
function start(h = storage(), override = options) {
    const journal = new DiagnosticJournal();
    journal.start(h.adapter, override);
    return { ...h, journal };
}

describe("A22 one-time diagnostic campaign", () => {
    it("defaults an opted-in campaign to the exported four-day duration", () => {
        const journal = new DiagnosticJournal();
        journal.start(storage().adapter, { campaign });
        expect(journal.campaignEndsAt).toBe(epoch + DIAGNOSTIC_CAMPAIGN_DURATION);
        journal.stop();
    });
    it("defaults on only for an opted-in campaign and synchronously saves its absolute deadline", () => {
        const h = start();
        expect(h.journal.active).toBe(true);
        expect(h.journal.campaignEndsAt).toBe(epoch + 4 * DIAGNOSTIC_TTL);
        expect(h.saved()).toMatchObject({ schema: 1, campaign, campaignUntil: epoch + DIAGNOSTIC_CAMPAIGN_DURATION,
            until: epoch + DIAGNOSTIC_CAMPAIGN_DURATION, savedAt: epoch });
        expect(h.adapter.write).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);
        const legacy = new DiagnosticJournal(); legacy.start(storage().adapter);
        expect(legacy.active).toBe(false);
        expect(legacy.campaignEndsAt).toBe(0);
        legacy.enable(true); expect(legacy.expiresAt).toBe(epoch + DIAGNOSTIC_TTL);
        legacy.stop(); h.journal.stop();
    });
    it("resumes beyond 24 hours without extending the deadline on restart or a changed build duration", () => {
        const h = start(), deadline = h.journal.campaignEndsAt;
        h.journal.record("request.success", { status: 200 }, true);
        h.journal.stop();
        vi.setSystemTime(epoch + 2 * DIAGNOSTIC_TTL);
        const resumed = start(h, { campaign, durationMs: 99 * DIAGNOSTIC_TTL }).journal;
        expect(resumed.active).toBe(true);
        expect(resumed.expiresAt).toBe(deadline);
        expect(resumed.campaignEndsAt).toBe(deadline);
        expect(resumed.snapshot().events.some(e => e.event === "request.success")).toBe(true);
        resumed.start(h.adapter, { campaign, durationMs: 1 });
        expect(resumed.expiresAt).toBe(deadline);
        resumed.stop();
    });
    it("keeps click-off across restarts, with no timers or writes on inactive record calls", () => {
        const h = start(), deadline = h.journal.campaignEndsAt;
        h.journal.record("ui.state");
        h.adapter.write.mockClear();
        h.journal.enable(false);
        expect(h.adapter.write).toHaveBeenCalledTimes(1);
        expect(h.saved()).toMatchObject({ until: 0, campaign, campaignUntil: deadline });
        expect(vi.getTimerCount()).toBe(0);
        h.journal.stop();
        vi.setSystemTime(epoch + DIAGNOSTIC_TTL);
        const next = start(h).journal;
        expect(next.active).toBe(false);
        expect(next.campaignEndsAt).toBe(deadline);
        h.adapter.write.mockClear();
        expect(next.record("request.start")).toBe(0);
        expect(h.adapter.write).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        next.stop();
    });
    it("permits explicit re-enable only inside the original campaign window", () => {
        const h = start(), deadline = h.journal.campaignEndsAt;
        h.journal.enable(false);
        vi.setSystemTime(deadline - 1000);
        h.journal.enable(true);
        expect(h.journal.active).toBe(true);
        expect(h.journal.expiresAt).toBe(deadline);
        h.journal.enable(false);
        vi.setSystemTime(deadline);
        h.journal.enable(true);
        expect(h.journal.active).toBe(false);
        expect(h.saved()).toMatchObject({ until: 0, campaignUntil: deadline });
        expect(vi.getTimerCount()).toBe(0);
        h.journal.stop();
    });
    it("persists timer expiry and never auto-reactivates or re-enables after it", async () => {
        const h = start(), deadline = h.journal.campaignEndsAt;
        await vi.advanceTimersByTimeAsync(DIAGNOSTIC_CAMPAIGN_DURATION);
        expect(h.saved()).toMatchObject({ until: 0, campaignUntil: deadline, savedAt: deadline });
        expect(h.journal.active).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        h.journal.stop();
        const next = start(h).journal;
        next.enable(true);
        expect(next.active).toBe(false);
        expect(next.campaignEndsAt).toBe(deadline);
        expect(vi.getTimerCount()).toBe(0);
        next.stop();
    });
    it("persists expiry discovered after the host was stopped or crashed", () => {
        const h = start(), deadline = h.journal.campaignEndsAt;
        h.journal.stop(); // until remains saved for resume.
        expect(h.saved().until).toBe(deadline);
        vi.setSystemTime(deadline + 1);
        const next = start(h).journal;
        expect(next.active).toBe(false);
        expect(h.saved().until).toBe(0);
        expect(next.campaignEndsAt).toBe(deadline);
        expect(vi.getTimerCount()).toBe(0);
        next.stop();
    });
    it("clear deletes evidence but preserves campaign deadline, opt-out and saved timestamp semantics", () => {
        const h = start(), deadline = h.journal.campaignEndsAt;
        h.journal.enable(false);
        vi.setSystemTime(epoch + 100);
        h.journal.clear();
        expect(h.saved()).toMatchObject({ until: 0, campaign, campaignUntil: deadline, savedAt: epoch + 100, events: [], dropped: 0 });
        h.journal.stop();
        const next = start(h).journal;
        expect(next.active).toBe(false); expect(next.campaignEndsAt).toBe(deadline);
        next.stop();
    });
    it("updates savedAt on flush only and includes complete resume metadata in an isolated snapshot", () => {
        const h = start();
        vi.setSystemTime(epoch + 100);
        h.journal.record("ui.state", { count: 3 });
        expect(h.journal.snapshot().savedAt).toBe(epoch);
        expect(h.journal.snapshot().savedAt).toBe(epoch);
        h.journal.flush();
        expect(h.saved().savedAt).toBe(epoch + 100);
        expect(h.journal.snapshot()).toEqual(h.saved());
        const copy = h.journal.snapshot();
        copy.until = 0; copy.campaignUntil = 0; copy.events[0].data.secret = "PRIVATE";
        expect(h.journal.expiresAt).toBe(epoch + DIAGNOSTIC_CAMPAIGN_DURATION);
        expect(h.raw()).not.toContain("PRIVATE");
        h.journal.stop();
    });
    it.each([0, epoch + DIAGNOSTIC_TTL])("migrates legacy schema 1 once even if its old until was %s", until => {
        const h = start(storage(JSON.stringify({ schema: 1, until, events: [], dropped: 0 })));
        const deadline = h.journal.campaignEndsAt;
        expect(h.journal.active).toBe(true);
        h.journal.enable(false); h.journal.stop();
        vi.setSystemTime(epoch + 10);
        const next = start(h).journal;
        expect(next.active).toBe(false); expect(next.campaignEndsAt).toBe(deadline);
        next.stop();
    });
    it("retains four-day history while continuing to sanitize restored payloads", () => {
        const h = start(storage(JSON.stringify({ schema: 1, campaign, campaignUntil: epoch + DIAGNOSTIC_TTL, until: 0, events: [
            { seq: 1, time: epoch - 3 * DIAGNOSTIC_TTL, event: "request.failure", data: { code: "network_error", token: "PRIVATE", route: "/personal/PRIVATE" } },
            { seq: 2, time: epoch - DIAGNOSTIC_CAMPAIGN_DURATION - 1, event: "request.start", data: {} }
        ] })));
        expect(h.journal.snapshot().events.some(e => e.seq === 1 && e.data.route === "/personal/:id")).toBe(true);
        expect(h.journal.snapshot().events.some(e => e.time < epoch - DIAGNOSTIC_CAMPAIGN_DURATION)).toBe(false);
        expect(h.raw()).not.toContain("PRIVATE");
        h.journal.stop();
    });
    it.each([false, true])("preserves the campaign report on day eight until clear (stopped before expiry: %s)", async stopped => {
        const h = start(), deadline = h.journal.campaignEndsAt;
        h.journal.record("request.success", { status: 200 }, true);
        await vi.advanceTimersByTimeAsync(3 * DIAGNOSTIC_TTL);
        h.journal.record("request.failure", { code: "network_error" }, true);
        if (stopped) h.journal.stop();
        const evidence = h.journal.snapshot().events;
        await vi.advanceTimersByTimeAsync(5 * DIAGNOSTIC_TTL);
        expect(h.journal.snapshot().events).toEqual(evidence);
        h.journal.stop();
        const next = start(h).journal;
        expect(next.active).toBe(false);
        expect(next.record("request.start")).toBe(0);
        next.enable(true);
        expect(next.active).toBe(false);
        expect(next.snapshot().events).toEqual(evidence);
        expect(h.saved()).toMatchObject({ until: 0, campaignUntil: deadline, events: evidence });
        expect(vi.getTimerCount()).toBe(0);
        next.clear(); next.stop();
        const cleared = start(h).journal;
        expect(cleared.snapshot().events).toEqual([]);
        expect(cleared.campaignEndsAt).toBe(deadline);
        cleared.stop();
    });
    it("excludes persisted events outside the fixed campaign window even when reopening much later", () => {
        vi.setSystemTime(epoch + 8 * DIAGNOSTIC_TTL);
        const deadline = epoch + DIAGNOSTIC_CAMPAIGN_DURATION;
        const times = [epoch - 1, epoch, deadline, deadline + 1, Date.now()];
        const h = start(storage(JSON.stringify({ schema: 1, campaign, campaignUntil: deadline, until: 0,
            events: times.map((time, i) => ({ seq: i + 1, time, event: "request.success", data: {} })) })));
        expect(h.journal.snapshot().events.map(e => e.time)).toEqual([epoch, deadline]);
        expect(h.journal.active).toBe(false);
        h.journal.stop();
    });
    it("does not renew the campaign even when a caller changes its ID", () => {
        const h = start(), deadline = h.journal.campaignEndsAt;
        h.journal.enable(false); h.journal.stop();
        vi.setSystemTime(epoch + DIAGNOSTIC_TTL);
        const next = start(h, { campaign: "mvp-new-build", durationMs: DIAGNOSTIC_CAMPAIGN_DURATION }).journal;
        expect(next.active).toBe(false);
        expect(next.campaignEndsAt).toBe(deadline);
        next.enable(true); expect(next.expiresAt).toBe(deadline);
        next.stop();
    });
    it.each(["broken", "null", "[]", '{"schema":2}', '{"schema":1}', "x".repeat(512 * 1024 + 1),
        JSON.stringify({ schema: 1, campaign, campaignUntil: null, until: epoch + 1000, events: [] }),
        JSON.stringify({ schema: 1, campaignUntil: null, events: [] }),
        JSON.stringify({ schema: 1, campaign, campaignUntil: epoch + DIAGNOSTIC_CAMPAIGN_DURATION + 1, until: epoch + 1000, events: [] })
    ])("fails closed for malformed persistence (case %#)", raw => {
        const h = start(storage(raw));
        expect(h.journal.active).toBe(false);
        expect(h.journal.campaignEndsAt).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(() => h.journal.enable(true)).not.toThrow();
        expect(h.journal.active).toBe(false);
        h.journal.stop();
    });
    it("never throws or arms timers when persistence cannot be read or written", () => {
        const journal = new DiagnosticJournal();
        expect(() => journal.start({ read() { throw Error("PRIVATE"); }, write() { throw Error("PRIVATE"); } }, options)).not.toThrow();
        expect(journal.active).toBe(false);
        expect(journal.storageFailed).toBe(true);
        expect(JSON.stringify(journal.snapshot())).not.toContain("PRIVATE");
        expect(vi.getTimerCount()).toBe(0);
        expect(() => journal.stop()).not.toThrow();
    });
    it.each([0, epoch + DIAGNOSTIC_CAMPAIGN_DURATION + 1])("does not revive corrupt active-until %s or damaged event history", until => {
        const deadline = epoch + DIAGNOSTIC_CAMPAIGN_DURATION;
        const h = start(storage(JSON.stringify({ schema: 1, campaign, campaignUntil: deadline, until, events: "PRIVATE" })));
        expect(h.journal.active).toBe(false);
        expect(h.journal.campaignEndsAt).toBe(deadline);
        expect(h.saved()).toMatchObject({ until: 0, campaignUntil: deadline, events: [] });
        expect(vi.getTimerCount()).toBe(0);
        h.journal.stop();
    });
    it("does not export arbitrary stored campaign text and does not activate a mismatching campaign", () => {
        const h = start(storage(JSON.stringify({ schema: 1, campaign: "private-token", campaignUntil: epoch + 1000,
            until: epoch + 1000, events: [] })));
        expect(h.raw()).not.toContain("private-token");
        expect(h.saved()).toMatchObject({ campaign, campaignUntil: epoch + 1000, until: 0 });
        expect(h.journal.active).toBe(false);
        h.journal.stop();
    });
    it("also sanitizes stored campaign text for callers using the legacy API", () => {
        const h = storage(JSON.stringify({ schema: 1, campaign: "private-token", campaignUntil: epoch + 1000, until: 0, events: [] }));
        const journal = new DiagnosticJournal(); journal.start(h.adapter);
        expect(h.raw()).not.toContain("private-token");
        expect(journal.active).toBe(false);
        expect(journal.campaignEndsAt).toBe(epoch + 1000);
        journal.stop();
    });
    it("retains its original deadline across same-instance restart when writes leave storage empty", () => {
        const h = storage();
        h.adapter.write.mockImplementation(() => { throw Error("unavailable"); });
        const journal = start(h).journal, deadline = journal.campaignEndsAt;
        journal.stop();
        vi.setSystemTime(epoch + DIAGNOSTIC_TTL);
        journal.start(h.adapter, options);
        expect(journal.campaignEndsAt).toBe(deadline);
        expect(journal.expiresAt).toBe(deadline);
        expect(journal.storageFailed).toBe(true);
        journal.stop();
    });
    it("resumes four-day deadlines but still rejects campaign deadlines outside the bounded window", () => {
        const h = start(storage(JSON.stringify({ schema: 1, campaign, campaignUntil: epoch + DIAGNOSTIC_CAMPAIGN_DURATION,
            until: epoch + DIAGNOSTIC_CAMPAIGN_DURATION, savedAt: epoch - 1, events: [] })));
        expect(h.journal.active).toBe(true);
        expect(h.journal.expiresAt).toBe(epoch + DIAGNOSTIC_CAMPAIGN_DURATION);
        h.journal.stop();
    });
    it("preserves in-memory opt-out if a failed write leaves an older active snapshot", () => {
        const h = start();
        h.adapter.write.mockImplementation(() => { throw Error("disk unavailable"); });
        h.journal.enable(false); h.journal.stop();
        // Same-millisecond tie must prefer the in-memory opt-out.
        h.journal.start(h.adapter, options);
        expect(h.journal.active).toBe(false);
        expect(h.journal.campaignEndsAt).toBe(epoch + DIAGNOSTIC_CAMPAIGN_DURATION);
        expect(vi.getTimerCount()).toBe(0);
        h.journal.stop();
    });
    it("bounds a campaign flood by count and actual UTF-8 bytes and never persists secret payloads", () => {
        const h = start();
        const data = { count: 1e9, status: 200, requestId: 5, durationMs: 2, retryAfterMs: 1000,
            width: 1000, height: 1000, queryLength: 1000, composeCount: 1000, total: 1e9, templates: 1000, steps: 1000,
            reason: "PRIVATE", route: "/personal/PRIVATE", token: "PRIVATE", body: "PRIVATE", message: "PRIVATE",
            query: "PRIVATE", headers: { Authorization: "Bearer PRIVATE" }, title: "PRIVATE", nested: { secret: "PRIVATE" } };
        for (let i = 0; i < 10000; i++) h.journal.record("request.success", data);
        h.journal.flush();
        expect(h.journal.size).toBeLessThanOrEqual(2000);
        expect(Buffer.byteLength(h.raw(), "utf8")).toBeLessThanOrEqual(512 * 1024);
        expect(h.saved().dropped).toBeGreaterThan(8000);
        expect(h.raw()).not.toContain("PRIVATE");
        expect(h.saved()).toMatchObject({ campaign, campaignUntil: epoch + DIAGNOSTIC_CAMPAIGN_DURATION });
        h.journal.stop(); expect(vi.getTimerCount()).toBe(0);
    });
    it.each([1, DIAGNOSTIC_TTL, DIAGNOSTIC_CAMPAIGN_DURATION * 2])("bounds configured duration %s", durationMs => {
        const h = start(storage(), { campaign, durationMs });
        expect(h.journal.campaignEndsAt).toBe(epoch + Math.min(durationMs, DIAGNOSTIC_CAMPAIGN_DURATION));
        h.journal.stop();
    });
    it.each([0, -1, NaN, Infinity, 1.5])("does not activate invalid duration %s", durationMs => {
        const h = start(storage(), { campaign, durationMs });
        expect(h.journal.active).toBe(false);
        expect(h.journal.campaignEndsAt).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        h.journal.stop();
    });
});
