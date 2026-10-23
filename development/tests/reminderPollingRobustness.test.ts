import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createReminderController, parseAssignedSnapshot, parseNotificationSettings,
    type ReminderContext, type ReminderOptions, type ReminderState,
} from "../src/core/panelReminders";

const ACCOUNT = "123456789012345678";
const OTHER = "223456789012345678";
const BASE = Date.parse("2026-10-18T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ticket = (overrides: Record<string, unknown> = {}) => ({
    ticketId: "42", guildId: null, channelId: "323456789012345678", project: "majestic",
    assigneeAccountId: ACCOUNT, state: "waiting_support", waitingSince: iso(BASE - 900_000),
    waitingCycleId: "cycle-1", reminderAt: iso(BASE), reminderId: "reminder-1", ...overrides,
});
const assigned = (overrides: Record<string, unknown> = {}) => ({
    accountId: ACCOUNT, revision: "opaque-revision", serverTime: iso(BASE), checkedAt: iso(BASE),
    maxAgeSeconds: 75, discordEnabled: true, tickets: [ticket()], ...overrides,
});
const settings = (overrides: Record<string, unknown> = {}) => ({
    version: "opaque-version", discordEnabled: true, thresholdSource: "telegram",
    projects: [{ project: "majestic", personalReminderMinutes: 37, discordReminderMinutes: null, effectiveReminderMinutes: 37, thresholdSource: "telegram", telegramEnabled: false }], ...overrides,
});
const parse = (raw: unknown) => parseAssignedSnapshot(raw, ACCOUNT, ["majestic", "russia-online"]);
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function memory() {
    let data: unknown;
    return {
        get: vi.fn(async (_key: string): Promise<unknown> => structuredClone(data)),
        set: vi.fn(async (_key: string, value: unknown) => { data = structuredClone(value); }),
        saved: () => structuredClone(data),
        seed: (value: unknown) => { data = structuredClone(value); },
    };
}
const clock: NonNullable<ReminderOptions["clock"]> = {
    now: () => performance.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
function harness(overrides: Partial<ReminderOptions> = {}) {
    let context: ReminderContext | null = {
        accountId: ACCOUNT, projects: ["majestic", "russia-online"], sessionId: "session-1",
        permissionsRevision: "permissions-1", enabled: true,
    };
    const storage = memory();
    const get = vi.fn(async (): Promise<unknown> => assigned({
        serverTime: iso(BASE + performance.now()), checkedAt: iso(BASE + performance.now()),
    }));
    const play = vi.fn<ReminderOptions["play"]>(async _stillValid => true);
    const onState = vi.fn<(state: ReminderState) => void>();
    const options: ReminderOptions = {
        accountId: ACCOUNT, projects: ["majestic", "russia-online"], get, storage, play,
        current: () => context, onState, clock, random: () => 0.5, ...overrides,
    };
    return { controller: createReminderController(options), options, storage, get, play, onState,
        change: (patch: Partial<ReminderContext> | null) => { context = patch === null ? null : { ...context!, ...patch }; } };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(BASE); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("reminder polling robustness regressions", () => {
    it("keeps network backoff when a burst invalidates the pending request", async () => {
        const h = harness(), read = deferred<unknown>();
        h.get.mockReturnValueOnce(read.promise);
        h.controller.start(); await flush();
        for (let i = 0; i < 100; i++) h.controller.invalidate("tickets.changed");
        read.reject(new Error("offline")); await flush();
        expect(h.get).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(59999);
        expect(h.get).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.get).toHaveBeenCalledTimes(2);
        h.controller.stop();
    });

    it("honors superseded 429 delay across stop/start and ignores stale delivery", async () => {
        const h = harness(), read = deferred<unknown>();
        h.get.mockReturnValueOnce(read.promise);
        h.controller.start(); await flush();
        h.controller.stop(); h.controller.start();
        for (let i = 0; i < 100; i++) h.controller.invalidate("tickets.changed");
        read.reject({ status: 429, retryAfterMs: 120000 }); await flush();
        expect(h.get).toHaveBeenCalledTimes(1); expect(h.play).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(119999);
        expect(h.get).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.get).toHaveBeenCalledTimes(2);
        h.controller.stop();
        expect(vi.getTimerCount()).toBe(0);
    });
});
