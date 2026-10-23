import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticJournal, DIAGNOSTIC_TTL, diagnosticData } from "../src/core/diagnosticJournal";
import { readFileSync } from "node:fs";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const continuous = { campaign: "mvp-file-2026-10", continuous: true };
function fixture(initial: string | null = null) {
    let raw = initial;
    const storage = { read: () => raw, write: vi.fn((value: string) => { raw = value; }) };
    const journal = new DiagnosticJournal(); journal.start(storage, continuous);
    return { journal, storage, saved: () => JSON.parse(raw!) };
}
describe("A24 continuous diagnostic journal", () => {
    it("defaults on without expiry, resumes identity/sequence and retains history months later", () => {
        const h = fixture();
        expect(h.journal.active).toBe(true); expect(vi.getTimerCount()).toBe(0);
        h.journal.record("auth.rejected", { code: "invalid_token", status: 401 }, true);
        h.journal.stop();
        const saved = h.saved();
        expect(saved).toMatchObject({ continuous: true, enabled: true, optedOut: false, until: 0, campaignUntil: 0 });
        vi.setSystemTime(Date.now() + 90 * DIAGNOSTIC_TTL);
        const next = fixture(JSON.stringify(saved));
        expect(next.journal.active).toBe(true);
        expect(next.saved().sessionId).toBe(saved.sessionId);
        expect(next.saved().sequence).toBe(saved.sequence + 1);
        expect(next.saved().events.some((e: any) => e.event === "auth.rejected")).toBe(true);
    });
    it("persists opt-out and clear without reactivation or timers, even with changed campaign", () => {
        const h = fixture(); h.journal.enable(false);
        expect(h.saved().events.at(-1).event).toBe("recorder.disabled");
        const seq = h.saved().sequence, id = h.saved().sessionId;
        h.journal.clear(); h.journal.stop();
        expect(h.saved()).toMatchObject({ optedOut: true, enabled: false, clearGeneration: 1, sequence: seq, sessionId: id, events: [] });
        const next = new DiagnosticJournal();
        next.start(h.storage, { continuous: true, campaign: "next-release" });
        expect(next.active).toBe(false); expect(next.record("request.start")).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        next.enable(true);
        expect(next.active).toBe(true); expect(next.snapshot().sequence).toBe(seq + 1);
    });
    it.each(["expired", "active", "explicit-off", "old-off", "cleared-off"])("migrates old campaign %s correctly", mode => {
        const now = Date.now(), deadline = now - DIAGNOSTIC_TTL;
        const old: any = { schema: 1, campaign: continuous.campaign, campaignUntil: deadline, savedAt: now, until: 0, events: [] };
        if (mode === "active") { old.campaignUntil = now + DIAGNOSTIC_TTL; old.until = old.campaignUntil; }
        if (mode === "explicit-off") old.optedOut = true;
        if (mode === "old-off") old.events = [{ seq: 20, time: now - 3 * DIAGNOSTIC_TTL, event: "recorder.disabled", data: {} }];
        if (mode === "cleared-off") old.savedAt = deadline - 100;
        expect(fixture(JSON.stringify(old)).journal.active).toBe(["expired", "active"].includes(mode));
    });
    it("restores allocated sequence even when sidecar contains only an older delta batch", () => {
        const h = fixture(), saved = h.saved();
        const next = fixture(JSON.stringify({ ...saved, sequence: 5000 }));
        expect(next.saved().events.at(-1).seq).toBe(5001);
        next.journal.clear();
        expect(next.saved().sequence).toBe(5001);
        expect(next.saved().clearGeneration).toBe(1);
    });
    it("bounds memory/serialized state, flushes during floods and never records key or content payloads", () => {
        const h = fixture(); h.storage.write.mockClear();
        for (let i = 0; i < 6000; i++) h.journal.record("request.success", { route: "/me", status: 200, text: "SECRET", token: "SECRET" });
        for (const event of ["key", "keydown", "keyup", "input", "search", "wheel"]) h.journal.record("debug", { event, code: "SECRET" });
        h.journal.flush();
        expect(h.journal.size).toBe(2000); expect(h.saved().sequence).toBe(6001);
        expect(h.storage.write.mock.calls.length).toBeGreaterThanOrEqual(60);
        expect(JSON.stringify(h.saved()).length).toBeLessThanOrEqual(512 * 1024);
        expect(JSON.stringify(h.saved())).not.toContain("SECRET");
    });
    it("savedAt changes only on flush; malformed/unavailable stores never break runtime", () => {
        const h = fixture(), stamp = h.journal.snapshot().savedAt;
        vi.setSystemTime(Date.now() + 10);
        expect(h.journal.snapshot().savedAt).toBe(stamp);
        h.journal.flush(); expect(h.journal.snapshot().savedAt).toBe(stamp + 10);
        expect(fixture("broken").journal.active).toBe(false);
        const j = new DiagnosticJournal();
        expect(() => j.start({ read: () => { throw Error("denied"); }, write: () => { throw Error("full"); } }, continuous)).not.toThrow();
        expect(j.active).toBe(false); expect(j.storageFailed).toBe(true);
    });
    it("keeps known auth outcomes but strips fabricated codes and private values", () => {
        for (const code of ["reauthentication_required", "callback_failed", "logout_in_progress", "retain_session", "terminate_session"])
            expect(diagnosticData({ code, token: "SECRET" })).toEqual({ code });
        expect(diagnosticData({ code: "vault_stale", reason: "state_invalid", text: "SECRET" })).toEqual({ code: "unknown", reason: "unknown" });
    });
    it("preserves actual sound modes/codes across renderer and native double sanitization, without names or audio", () => {
        const source = ["src/core/ticketSound.ts", "src/vencord/ui/ticketSound.ts"]
            .map(p => readFileSync(new URL("../" + p, import.meta.url), "utf8")).join("\n");
        const codes = [...new Set([...source.matchAll(/"(sound_[a-z_]+)"/g)].map(m => m[1]))];
        expect(codes.length).toBeGreaterThan(15);
        for (const code of codes) for (const mode of ["ticket", "test", "reminder", "custom"]) {
            const data = diagnosticData(diagnosticData({ code, mode, volume: 0.5, enabled: true, filename: "SECRET", audio: "SECRET" }));
            expect(data).toEqual({ code, mode, volume: 0.5, enabled: true });
        }
        const h = fixture(); h.journal.record("runtime.sound_skipped", { code: "sound_muted", mode: "ticket" }, true);
        expect(h.saved().events.at(-1)).toMatchObject({ event: "runtime.sound_skipped", data: { code: "sound_muted", mode: "ticket" } });
    });
});
