import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnosticData, diagnosticJournal as journal } from "../src/core/diagnosticJournal";
import { createReminderController, type ReminderOptions } from "../src/core/panelReminders";
import { storageModule } from "./a22DiagnosticStorageHarness";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordTicketSoundDiagnostic } from "../src/core/ticketSound";

const ACCOUNT = "123456789012345678", OTHER = "223456789012345678";
const CHANNEL = "323456789012345678", GUILD = "423456789012345678";
const BASE = Date.parse("2026-10-20T12:00:00Z");
const iso = (time: number) => new Date(time).toISOString();
const ticket = (patch = {}) => ({
    ticketId: "regional:42", channelId: CHANNEL, guildId: GUILD, project: "majestic",
    assigneeAccountId: ACCOUNT, state: "waiting_support", waitingSince: iso(BASE - 900000),
    reminderAt: iso(BASE), reminderId: "private opaque reminder", waitingCycleId: "private opaque cycle", ...patch,
});
const snapshot = (patch = {}) => ({
    accountId: ACCOUNT, revision: "private opaque revision", serverTime: iso(BASE), checkedAt: iso(BASE),
    maxAgeSeconds: 75, discordEnabled: true, tickets: [ticket()], ...patch,
});
const stops: (() => void)[] = [];
beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(BASE);
    journal.start({ read: () => null, write: () => {} }, { continuous: true });
    journal.clear();
});
afterEach(() => {
    stops.splice(0).forEach(stop => stop()); journal.stop(); journal.clear();
    vi.clearAllTimers(); vi.useRealTimers();
});
const events = (name: string) => journal.snapshot().events.filter(e => e.event === `runtime.reminder_${name}`).map(e => e.data);
const flush = () => vi.advanceTimersByTimeAsync(0);
function fixture(raw: unknown = snapshot(), extra: Partial<ReminderOptions> = {}) {
    let enabled = true, saved: unknown;
    const get = vi.fn(async () => raw);
    const play = vi.fn<ReminderOptions["play"]>(async valid => valid());
    const storage = { get: vi.fn(async () => saved), set: vi.fn(async (_key: string, value: unknown) => { saved = value; }) };
    const controller = createReminderController({
        accountId: ACCOUNT, projects: ["majestic"], get, play, storage,
        current: () => ({ accountId: ACCOUNT, projects: ["majestic"], enabled, sessionId: "AUTH_SESSION_SECRET", permissionsRevision: "auth revision" }),
        random: () => 0.5, ...extra,
    });
    stops.push(controller.stop);
    return { controller, get, play, storage, disable: () => { enabled = false; } };
}
describe("A24 assigned-reminder explanations", () => {
    it("explains empty snapshots and never plays with zero assigned tickets", async () => {
        const h = fixture(snapshot({ tickets: [] })); h.controller.start(); await flush();
        expect(h.play).not.toHaveBeenCalled();
        expect(events("snapshot")).toContainEqual(expect.objectContaining({ phase: "complete", snapshotCount: 0, ownCount: 0, fresh: true }));
        expect(events("selection")).toContainEqual(expect.objectContaining({ reason: "empty_snapshot", eligibleCount: 0 }));
    });
    it("rejects foreign assignments, showing technical ticket identity and only an ownership boolean", async () => {
        const h = fixture(snapshot({ tickets: [ticket({ assigneeAccountId: OTHER })] })); h.controller.start(); await flush();
        expect(h.play).not.toHaveBeenCalled(); expect(h.storage.set).not.toHaveBeenCalled();
        expect(events("snapshot")).toContainEqual(expect.objectContaining({ ownCount: 0, otherCount: 1, accountMatches: true }));
        expect(events("ticket")).toContainEqual(expect.objectContaining({ ticketId: "regional:42", channelId: CHANNEL, guildId: GUILD,
            project: "majestic", ownAssignee: false, eligible: false, reason: "foreign_assignment" }));
        expect(events("failure")).toContainEqual(expect.objectContaining({ phase: "snapshot_validate", reason: "foreign_assignment" }));
        const raw = JSON.stringify(journal.snapshot());
        expect(raw).not.toContain(ACCOUNT); expect(raw).not.toContain(OTHER);
        expect(raw).not.toContain("assigneeAccountId"); expect(raw).not.toContain("AUTH_SESSION_SECRET");
    });
    it("rejects stale snapshots with a specific reason rather than claiming an empty list", async () => {
        const h = fixture(snapshot({ checkedAt: iso(BASE - 75001) })); h.controller.start(); await flush();
        expect(h.play).not.toHaveBeenCalled();
        expect(events("failure")).toContainEqual(expect.objectContaining({ reason: "stale_snapshot" }));
        expect(events("snapshot").some(e => e.phase === "complete")).toBe(false);
    });
    it("identifies the chosen due ticket and correlates receipt, guard and actual play result", async () => {
        const h = fixture(); h.controller.start(); await flush();
        expect(h.play).toHaveBeenCalledOnce();
        const context = h.play.mock.calls[0][1]!;
        expect(context).toMatchObject({ ticketId: "regional:42", channelId: CHANNEL, guildId: GUILD, project: "majestic" });
        expect(Object.keys(context)).not.toContain("assigneeAccountId");
        const chosen = events("chosen")[0];
        expect(chosen).toMatchObject({ ticketId: "regional:42", ownAssignee: true, eligible: true,
            waitingSince: BASE - 900000, reminderAt: BASE, serverNow: BASE, thresholdMs: 900000, cycle: context.cycle });
        expect(chosen.waitingCycleId).toMatch(/^h:[0-9a-f]{16}$/);
        expect(events("receipt")[0]).toMatchObject({ cycle: context.cycle, reason: "receipt_saved", ticketId: "regional:42" });
        expect(events("guard")).toEqual([expect.objectContaining({ currentGuard: true, reason: "guard_valid", cycle: context.cycle })]);
        expect(events("play")[0]).toMatchObject({ played: true, currentGuard: true, cycle: context.cycle });
        expect(JSON.stringify(journal.snapshot())).not.toContain("private opaque");
        const native = storageModule.sanitizeDiagnosticReport(JSON.stringify({ journal: journal.snapshot() }));
        expect(native.journal.events.find((e: any) => e.event === "runtime.reminder_chosen").data).toEqual(chosen);
    });
    it("distinguishes waiting_player, not_due and durable receipt duplicates", async () => {
        const player = ticket({ ticketId: "1", state: "waiting_player", waitingSince: null, reminderAt: null, waitingCycleId: null, reminderId: null });
        const future = ticket({ ticketId: "2", reminderAt: iso(BASE + 10000) });
        const h = fixture(snapshot({ tickets: [player, future, ticket()] }));
        h.controller.start(); await flush(); await h.controller.refresh();
        expect(h.play).toHaveBeenCalledOnce();
        expect(events("ticket")).toContainEqual(expect.objectContaining({ ticketId: "1", reason: "waiting_player", eligible: false }));
        expect(events("ticket")).toContainEqual(expect.objectContaining({ ticketId: "2", reason: "not_due", dueInMs: 10000 }));
        expect(events("ticket")).toContainEqual(expect.objectContaining({ ticketId: "regional:42", reason: "receipt_duplicate", eligible: false }));
    });
    it("blocks a reassigned ticket during async decode and reports the invalidated guard", async () => {
        let decoded!: () => void;
        const decoding = new Promise<void>(resolve => { decoded = resolve; });
        const audible = vi.fn();
        const h = fixture(snapshot(), { play: async valid => { await decoding; if (!valid()) return false; audible(); return true; } });
        h.controller.start(); await flush();
        h.get.mockResolvedValue(snapshot({ tickets: [ticket({ assigneeAccountId: OTHER })] }));
        h.controller.invalidate("tickets.changed"); decoded(); await flush();
        expect(audible).not.toHaveBeenCalled();
        expect(events("guard")).toContainEqual(expect.objectContaining({ currentGuard: false, reason: "generation_changed" }));
        expect(events("play")).toContainEqual(expect.objectContaining({ played: false, currentGuard: false }));
        expect(events("failure")).toContainEqual(expect.objectContaining({ reason: "foreign_assignment" }));
    });
    it.each(["context", "snapshot"] as const)("blocks disabled reminders through %s", async source => {
        if (source === "snapshot") {
            const h = fixture(snapshot({ discordEnabled: false })); h.controller.start(); await flush();
            expect(h.play).not.toHaveBeenCalled(); expect(events("skip")[0].reason).toBe("settings_disabled");
        } else {
            let decoded!: () => void;
            const decoding = new Promise<void>(resolve => { decoded = resolve; });
            const audible = vi.fn();
            const h = fixture(snapshot(), { play: async valid => { await decoding; if (!valid()) return false; audible(); return true; } });
            h.controller.start(); await flush(); h.disable(); decoded(); await flush();
            expect(audible).not.toHaveBeenCalled();
            expect(events("play")[0]).toMatchObject({ played: false, currentGuard: false });
        }
    });
    it("limits row traces for large snapshots but always records the actual selected ticket", async () => {
        const tickets = Array.from({ length: 100 }, (_, i) => ticket({ ticketId: String(i), reminderAt: iso(BASE + (i < 99 ? 10000 : 0)) }));
        const h = fixture(snapshot({ tickets })); h.controller.start(); await flush();
        expect(events("ticket")).toHaveLength(20);
        expect(events("selection")[0]).toMatchObject({ snapshotCount: 100, tracedCount: 20, eligibleCount: 1 });
        expect(events("chosen")[0].ticketId).toBe("99");
    });
    it("keeps exact validated epochs and technical IDs through native double sanitation, never account IDs or text", () => {
        const raw = { ticketId: "regional:42", channelId: CHANNEL, guildId: GUILD, serverTime: BASE, checkedAt: BASE,
            reminderAt: BASE, waitingSince: BASE - 900000, serverNow: BASE, waitingCycleId: "private opaque cycle",
            reminderId: "private opaque reminder", snapshotRevision: "private opaque revision", accountId: ACCOUNT,
            assigneeAccountId: OTHER, message: "SECRET", accessToken: "SECRET", configSource: "channel", audioState: "running" };
        const once = diagnosticData(raw);
        expect(diagnosticData(once)).toEqual(once);
        expect(once).toMatchObject({ serverTime: BASE, reminderAt: BASE, channelId: CHANNEL, configSource: "channel", audioState: "running" });
        expect(JSON.stringify(once)).not.toContain("SECRET"); expect(JSON.stringify(once)).not.toContain(ACCOUNT);
        expect(diagnosticData({ guildId: "18446744073709551616", channelId: "012345678901234567", serverTime: -1 })).toEqual({});
    });
    it("persists chosen ticket, exact due times, skip reason and correlated sound context through native TXT and reload", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "SupportTemplates-a24-reminder-trace-"));
        try {
            const h = fixture(snapshot({ tickets: [ticket({ ticketId: "41", reminderAt: iso(BASE + 10000) }), ticket()] }));
            h.controller.start(); await flush();
            const context = h.play.mock.calls[0][1]!;
            recordTicketSoundDiagnostic("result", { ...context, mode: "reminder", volume: 30, enabled: true,
                success: true, phase: "ended", configSource: "global", audioState: "running" });
            journal.flush();
            const native = storageModule.createDiagnosticFileStorage({ root, fs });
            const saved = await native.save(JSON.stringify({ product: "SupportTemplates", version: "1.0.1-canary.31",
                distribution: "standalone", build: "source", recording: true, journal: journal.snapshot(),
                snapshot: { connection: { phase: "offline", stale: true, staleUntil: BASE + 75000, remainingMs: 75000 } } }));
            const text = fs.readFileSync(saved.path, "utf8");
            const lineData = (event: string) => text.split("\n").filter(line => line.includes(` ${event} `))
                .map(line => JSON.parse(line.slice(line.indexOf("{"))).data);
            expect(lineData("runtime.reminder_chosen")[0]).toMatchObject({
                ticketId: "regional:42", channelId: CHANNEL, guildId: GUILD, project: "majestic", cycle: context.cycle,
                waitingSince: BASE - 900000, reminderAt: BASE, serverNow: BASE, thresholdMs: 900000,
            });
            expect(lineData("runtime.reminder_ticket")).toContainEqual(expect.objectContaining({
                ticketId: "41", eligible: false, reason: "not_due", dueInMs: 10000,
            }));
            expect(lineData("runtime.sound_result")[0]).toMatchObject({
                ticketId: "regional:42", channelId: CHANNEL, guildId: GUILD, cycle: context.cycle,
                mode: "reminder", configSource: "global", audioState: "running", phase: "ended", success: true,
            });
            const snapshotLine = text.split("\n").find(line => line.includes(" runtime.snapshot "))!;
            expect(JSON.parse(snapshotLine.slice(snapshotLine.indexOf("{"))).snapshot.connection)
                .toEqual({ phase: "offline", stale: true, staleUntil: BASE + 75000 });
            const reloaded = JSON.parse((await storageModule.createDiagnosticFileStorage({ root, fs }).load()).state);
            expect(reloaded.events.find((e: any) => e.event === "runtime.reminder_chosen").data)
                .toEqual(lineData("runtime.reminder_chosen")[0]);
            expect(reloaded.events.find((e: any) => e.event === "runtime.sound_result").data)
                .toEqual(lineData("runtime.sound_result")[0]);
            for (const secret of [ACCOUNT, OTHER, "assigneeAccountId", "AUTH_SESSION_SECRET", "private opaque"])
                expect(text.includes(secret)).toBe(false);
        } finally {
            if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())
                || !path.basename(root).startsWith("SupportTemplates-a24-reminder-trace-")) throw Error("Unexpected fixture path");
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
