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
    projects: [{ project: "majestic", personalReminderMinutes: 37, telegramEnabled: false }], ...overrides,
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

describe("panel reminder wire parsers", () => {
    it("keeps Telegram thresholds, delivery toggles and opaque If-Match version independent", () => {
        expect(parseNotificationSettings(settings())).toEqual(settings());
        expect(parseNotificationSettings(settings({ discordEnabled: false })).projects[0].personalReminderMinutes).toBe(37);
    });

    it.each([
        { thresholdSource: "discord" }, { version: 'bad"header' }, { version: "bad\r\nheader" },
        { discordEnabled: 1 }, { projects: [{ project: "eu", personalReminderMinutes: 15, telegramEnabled: true }] },
        ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "15", undefined].map(personalReminderMinutes => ({
            projects: [{ project: "majestic", personalReminderMinutes, telegramEnabled: true }],
        })),
        { projects: [settings().projects[0], settings().projects[0]] },
    ])("rejects malformed settings %j", override => {
        expect(() => parseNotificationSettings(settings(override))).toThrow();
    });

    it("accepts nullable Discord locations, non-snowflake ticket IDs and project-qualified duplicates", () => {
        const parsed = parse(assigned({ tickets: [ticket({ ticketId: "regional:42", channelId: null }), ticket({ project: "russia-online" })] }));
        expect(parsed.tickets[0]).toMatchObject({ guildId: null, channelId: null, ticketId: "regional:42", reminderAt: BASE });
        expect(parsed.tickets).toHaveLength(2);
    });

    it("requires all waiting_player fields to be explicitly null", () => {
        const player = ticket({ state: "waiting_player", waitingSince: null, waitingCycleId: null, reminderAt: null, reminderId: null });
        expect(parse(assigned({ tickets: [player] })).tickets[0].state).toBe("waiting_player");
        for (const field of ["waitingSince", "waitingCycleId", "reminderAt", "reminderId"]) {
            for (const value of [undefined, "stale"]) {
                expect(() => parse(assigned({ tickets: [{ ...player, [field]: value }] }))).toThrow();
            }
        }
    });

    it.each([
        { accountId: OTHER }, { accountId: 123 }, { maxAgeSeconds: 76 }, { maxAgeSeconds: 74 },
        { discordEnabled: "true" }, { revision: "" }, { checkedAt: iso(BASE + 1) },
        { checkedAt: iso(BASE - 75_001) }, { serverTime: "2026-02-30T12:00:00Z" },
        { serverTime: "2026-10-18T12:00:00+00:00" }, { tickets: [ticket(), ticket()] },
        { tickets: [ticket({ assigneeAccountId: OTHER })] }, { tickets: [ticket({ project: "eu" })] },
        ...["42", "012345678901234567", "18446744073709551616", 123456789012345678].map(guildId => ({ tickets: [ticket({ guildId })] })),
        { tickets: [ticket({ channelId: undefined })] }, { tickets: [ticket({ reminderId: null })] },
        { tickets: [ticket({ state: "closed" })] }, { tickets: [ticket({ waitingSince: iso(BASE + 1) })] },
        { tickets: [ticket({ reminderAt: iso(BASE - 900_001) })] },
    ])("rejects malformed, foreign or stale snapshots %j", override => {
        expect(() => parse(assigned(override))).toThrow();
    });

    it("accepts precisely 75 seconds and rejects inaccessible projects or invalid guards", () => {
        expect(parse(assigned({ checkedAt: iso(BASE - 75_000) })).checkedAt).toBe(BASE - 75_000);
        expect(() => parseAssignedSnapshot(assigned(), ACCOUNT, ["russia-online"])).toThrow();
        expect(() => parseAssignedSnapshot(assigned(), ACCOUNT, ["majestic", "majestic"])).toThrow();
        expect(() => parseAssignedSnapshot(assigned(), "123", ["majestic"])).toThrow();
    });
});

describe("panel reminder controller", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
        vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
    });
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

    it("filters a muted first project before receipt selection and still delivers the other project", async () => {
        const h = harness({ projectSound: project => ({ enabled: project === "russia-online", revision: 1 }) });
        h.get.mockResolvedValue(assigned({ tickets: [ticket(), ticket({ ticketId: "43", project: "russia-online" })] }));
        h.controller.start(); await flush();
        expect(h.storage.saved()).toEqual({ v: 1, receipts: [[ACCOUNT, "russia-online", "43", "reminder-1"]] });
        expect(h.play).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ project: "russia-online", ticketId: "43" }));
        h.controller.stop();
    });

    it("does not consume muted-project receipts or keep overdue polling active", async () => {
        let enabled = false;
        const h = harness({ projectSound: () => ({ enabled, revision: 1 }) });
        h.controller.start(); await flush();
        expect(h.storage.set).not.toHaveBeenCalled(); expect(h.play).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(59_999);
        expect(h.get).toHaveBeenCalledOnce();
        enabled = true;
        await vi.advanceTimersByTimeAsync(1);
        expect(h.get).toHaveBeenCalledTimes(2);
        expect(h.play).toHaveBeenCalledOnce();
        h.controller.stop();
    });

    it("invalidates a claimed playback after a project off/on revision during persistence", async () => {
        let revision = 1;
        const h = harness({ projectSound: () => ({ enabled: true, revision }) });
        const pending = deferred<void>(); h.storage.set.mockImplementationOnce(() => pending.promise);
        h.controller.start(); await flush();
        expect(h.storage.set).toHaveBeenCalledOnce();
        revision += 2; pending.resolve(); await flush();
        expect(h.play).not.toHaveBeenCalled(); h.controller.stop();
    });

    it("checks project revisions after asynchronous playback preparation while leaving other projects independent", async () => {
        const revisions = { majestic: 1, "russia-online": 1 };
        const h = harness({ projectSound: project => ({ enabled: true, revision: revisions[project] }) });
        const decoded = deferred<void>(); let audibleStart = false;
        h.play.mockImplementation(async valid => { await decoded.promise; audibleStart = valid(); return audibleStart; });
        h.controller.start(); await flush();
        revisions["russia-online"]++;
        expect(h.play.mock.calls[0][0]()).toBe(true);
        revisions.majestic++;
        decoded.resolve(); await flush();
        expect(audibleStart).toBe(false); h.controller.stop();
    });

    it("durably saves before audio, reports its outcome and deduplicates across reload", async () => {
        const h = harness();
        h.play.mockImplementation(async () => {
            expect(h.storage.saved()).toEqual({ v: 1, receipts: [[ACCOUNT, "majestic", "42", "reminder-1"]] });
            return true;
        });
        h.controller.start();
        await flush();
        expect(h.play).toHaveBeenCalledTimes(1);
        expect(h.onState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ready", played: true }));
        h.controller.stop();
        const reload = createReminderController(h.options);
        reload.start();
        await flush();
        expect(h.play).toHaveBeenCalledTimes(1);
        expect(h.storage.set).toHaveBeenCalledTimes(1);
        reload.stop();
    });

    it("schedules relative to server time despite a wrong local UTC clock and re-reads before sound", async () => {
        const h = harness();
        h.get.mockImplementation(async () => assigned({ serverTime: iso(BASE + performance.now()), checkedAt: iso(BASE + performance.now()),
            tickets: [ticket({ reminderAt: iso(BASE + 20_000) })] }));
        h.controller.start();
        await flush();
        expect(h.play).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(19_999);
        expect(h.get).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.get).toHaveBeenCalledTimes(2);
        expect(h.play).toHaveBeenCalledTimes(1);
        expect(h.play).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ waitingMs: 920000 }));
    });

    it.each(["removed", "reassigned", "waiting_player", "discord_disabled"])("cancels a due sound after fresh read: %s", async reason => {
        const h = harness();
        h.get.mockResolvedValueOnce(assigned({ tickets: [ticket({ reminderAt: iso(BASE + 10_000) })] }));
        h.controller.start();
        await flush();
        const replacement = reason === "removed" ? { tickets: [] }
            : reason === "reassigned" ? { tickets: [ticket({ assigneeAccountId: OTHER })] }
            : reason === "discord_disabled" ? { discordEnabled: false }
            : { tickets: [ticket({ state: "waiting_player", waitingSince: null, waitingCycleId: null, reminderAt: null, reminderId: null })] };
        h.get.mockResolvedValue(assigned({ serverTime: iso(BASE + 10_000), checkedAt: iso(BASE + 10_000), ...replacement }));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(h.get).toHaveBeenCalledTimes(2);
        expect(h.play).not.toHaveBeenCalled();
    });

    it.each([0, 0.5, 1])("polls with jitter at random=%s", async random => {
        const h = harness({ random: () => random });
        h.get.mockResolvedValue(assigned({ tickets: [] }));
        h.controller.start();
        await flush();
        await vi.advanceTimersByTimeAsync(50_000 + random * 20_000 - 1);
        expect(h.get).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.get).toHaveBeenCalledTimes(2);
    });

    it("does not overlap reads; invalidation discards the old response and coalesces refreshes", async () => {
        const h = harness();
        const first = deferred<unknown>();
        h.get.mockReturnValueOnce(first.promise).mockResolvedValue(assigned({ tickets: [] }));
        h.controller.start();
        await flush();
        h.controller.invalidate();
        h.controller.invalidate("resync.required");
        const pending = h.controller.refresh();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(h.get).toHaveBeenCalledTimes(1);
        first.resolve(assigned());
        await pending;
        expect(h.get).toHaveBeenCalledTimes(2);
        expect(h.play).not.toHaveBeenCalled();
    });

    it("counts request duration toward the 75-second freshness ceiling", async () => {
        const h = harness();
        const response = deferred<unknown>();
        h.get.mockReturnValueOnce(response.promise);
        h.controller.start();
        await flush();
        await vi.advanceTimersByTimeAsync(1_001);
        response.resolve(assigned({ checkedAt: iso(BASE - 74_000) }));
        await flush();
        expect(h.play).not.toHaveBeenCalled();
        expect(h.onState).toHaveBeenLastCalledWith({ status: "unavailable" });
    });

    it("rechecks freshness after a slow durable write and retains the consumed attempt", async () => {
        const h = harness();
        const write = deferred<void>();
        h.storage.set.mockImplementationOnce(async () => write.promise);
        h.get.mockResolvedValue(assigned({ checkedAt: iso(BASE - 74_000) }));
        h.controller.start();
        await flush();
        expect(h.storage.set).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1_001);
        write.resolve();
        await flush();
        expect(h.play).not.toHaveBeenCalled();
        expect(h.onState).toHaveBeenLastCalledWith({ status: "unavailable" });
    });

    it.each(["serverTime", "checkedAt"])("rejects regressing %s across snapshots", async field => {
        const h = harness();
        h.get.mockResolvedValueOnce(assigned({ tickets: [] }));
        h.controller.start();
        await flush();
        h.get.mockResolvedValue(assigned({ [field]: iso(BASE - 1), ...(field === "serverTime" ? { checkedAt: iso(BASE - 1) } : {}) }));
        await h.controller.refresh();
        expect(h.play).not.toHaveBeenCalled();
        expect(h.onState).toHaveBeenLastCalledWith({ status: "unavailable" });
    });

    it.each(["get", "set"] as const)("fails closed on storage.%s failure without tight retries", async operation => {
        const h = harness();
        h.storage[operation].mockRejectedValue(new Error("disk unavailable"));
        h.controller.start();
        await flush();
        expect(h.play).not.toHaveBeenCalled();
        expect(h.onState).toHaveBeenLastCalledWith({ status: "unavailable" });
        await vi.advanceTimersByTimeAsync(59_999);
        expect(h.get).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.get).toHaveBeenCalledTimes(2);
        expect(h.play).not.toHaveBeenCalled();
    });

    it.each([null, {}, { v: 2, receipts: [] }, { v: 1, receipts: [[ACCOUNT, "eu", "42", "r"]] }])("does not replace corrupt receipts %j", async saved => {
        const h = harness();
        h.storage.seed(saved);
        h.controller.start();
        await flush();
        expect(h.play).not.toHaveBeenCalled();
        expect(h.storage.set).not.toHaveBeenCalled();
        expect(h.storage.saved()).toEqual(saved);
    });

    it("keeps historical IDs across absence, new cycles, projects and reload", async () => {
        const h = harness();
        h.controller.start();
        await flush();
        h.get.mockResolvedValue(assigned({ tickets: [] }));
        await h.controller.refresh();
        h.get.mockResolvedValue(assigned({ tickets: [ticket({ reminderId: "repeat-2" })] }));
        await h.controller.refresh();
        h.get.mockResolvedValue(assigned({ tickets: [ticket({ project: "russia-online" })] }));
        await h.controller.refresh();
        h.get.mockResolvedValue(assigned());
        await h.controller.refresh();
        expect(h.play).toHaveBeenCalledTimes(3);
        expect(h.storage.saved()).toEqual({ v: 1, receipts: [
            [ACCOUNT, "majestic", "42", "reminder-1"], [ACCOUNT, "majestic", "42", "repeat-2"],
            [ACCOUNT, "russia-online", "42", "reminder-1"],
        ] });
    });

    it("does not renew old checkedAt freshness by re-reading a frozen serverTime", async () => {
        const h = harness();
        h.get.mockResolvedValue(assigned({ tickets: [] }));
        h.controller.start();
        await flush();
        await vi.advanceTimersByTimeAsync(76_000);
        h.get.mockResolvedValue(assigned());
        await h.controller.refresh();
        expect(h.play).not.toHaveBeenCalled();
        expect(h.onState).toHaveBeenLastCalledWith({ status: "unavailable" });
    });

    it("a receipt from another account does not suppress the current account", async () => {
        const h = harness();
        h.storage.seed({ v: 1, receipts: [[OTHER, "majestic", "42", "reminder-1"]] });
        h.controller.start();
        await flush();
        expect(h.play).toHaveBeenCalledTimes(1);
        expect(h.storage.saved()).toEqual({ v: 1, receipts: [
            [OTHER, "majestic", "42", "reminder-1"], [ACCOUNT, "majestic", "42", "reminder-1"],
        ] });
    });

    it("caps receipt storage without evicting historical IDs", async () => {
        const h = harness();
        const saved = { v: 1, receipts: Array.from({ length: 10_000 }, (_, i) => [ACCOUNT, "majestic", "42", `old-${i}`]) };
        h.storage.seed(saved);
        h.controller.start();
        await flush();
        expect(h.play).not.toHaveBeenCalled();
        expect(h.storage.set).not.toHaveBeenCalled();
        expect(h.storage.saved()).toEqual(saved);
        expect(h.onState).toHaveBeenLastCalledWith({ status: "unavailable" });
    });

    it("serializes receipt claims across two controllers sharing an adapter", async () => {
        const h = harness();
        const second = createReminderController(h.options);
        h.controller.start();
        second.start();
        await flush();
        expect(h.play).toHaveBeenCalledTimes(1);
        expect(h.storage.set).toHaveBeenCalledTimes(1);
        second.stop();
    });

    it.each([false, "reject"])("does not replay a consumed attempt when audio returns %s", async outcome => {
        const h = harness();
        if (outcome === "reject") h.play.mockRejectedValue(new Error("audio"));
        else h.play.mockResolvedValue(false);
        h.controller.start();
        await flush();
        expect(h.onState).toHaveBeenLastCalledWith(expect.objectContaining({ played: false }));
        await h.controller.refresh();
        expect(h.play).toHaveBeenCalledTimes(1);
    });

    it("spaces multiple overdue tickets by at least five seconds", async () => {
        const h = harness();
        h.get.mockResolvedValue(assigned({ tickets: [ticket(), ticket({ ticketId: "43" })] }));
        h.controller.start();
        await flush();
        expect(h.play).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(h.get).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.get).toHaveBeenCalledTimes(2);
        expect(h.play).toHaveBeenCalledTimes(2);
    });

    it("honors Retry-After even through manual refreshes and invalidation events", async () => {
        const h = harness();
        h.get.mockRejectedValueOnce({ status: 429, retryAfterMs: 120_000 });
        h.controller.start();
        await flush();
        await vi.advanceTimersByTimeAsync(60_000);
        h.controller.invalidate("tickets.changed");
        await h.controller.refresh();
        await vi.advanceTimersByTimeAsync(59_999);
        expect(h.get).toHaveBeenCalledTimes(1);
        expect(h.play).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.get).toHaveBeenCalledTimes(2);
        expect(h.play).toHaveBeenCalledTimes(1);
    });

    it("blocks after network/503 failures until a successful new snapshot", async () => {
        const h = harness();
        h.get.mockRejectedValueOnce({ status: 503, retryAfterMs: 90_000 });
        h.controller.start();
        await flush();
        expect(h.play).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(90_000);
        expect(h.play).toHaveBeenCalledTimes(1);
    });

    it("tickets.unavailable invalidates an in-flight snapshot before refreshing", async () => {
        const h = harness();
        const response = deferred<unknown>();
        h.get.mockReturnValueOnce(response.promise).mockResolvedValueOnce(assigned({ tickets: [] }));
        h.controller.start();
        await flush();
        h.controller.invalidate("tickets.unavailable");
        response.resolve(assigned());
        await flush();
        expect(h.get).toHaveBeenCalledTimes(2);
        expect(h.play).not.toHaveBeenCalled();
    });

    it.each(["stop", "permissions.changed", "session.revoked", "token.expired"])("ignores late reads after %s", async event => {
        const h = harness();
        const response = deferred<unknown>();
        h.get.mockReturnValueOnce(response.promise);
        h.controller.start();
        await flush();
        if (event === "stop") h.controller.stop(); else h.controller.invalidate(event);
        response.resolve(assigned());
        await flush();
        await vi.advanceTimersByTimeAsync(180_000);
        expect(h.play).not.toHaveBeenCalled();
        expect(h.get).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(h.onState).toHaveBeenLastCalledWith({ status: "stopped" });
    });

    it.each([null, { accountId: OTHER }, { projects: ["majestic"] }, { sessionId: "new-session" },
        { permissionsRevision: "new-rights" }, { enabled: false }])("checks current identity after durable write: %j", async change => {
        const h = harness();
        const write = deferred<void>();
        h.storage.set.mockImplementationOnce(async () => write.promise);
        h.controller.start();
        await flush();
        expect(h.storage.set).toHaveBeenCalledTimes(1);
        h.change(change);
        write.resolve();
        await flush();
        expect(h.play).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("checks stop after storage read and before writing", async () => {
        const h = harness();
        const read = deferred<unknown>();
        h.storage.get.mockReturnValueOnce(read.promise);
        h.controller.start();
        await flush();
        h.controller.stop();
        read.resolve(undefined);
        await flush();
        expect(h.storage.set).not.toHaveBeenCalled();
        expect(h.play).not.toHaveBeenCalled();
    });

    it("checks stop during durable persistence and suppresses audio", async () => {
        const h = harness();
        const write = deferred<void>();
        h.storage.set.mockImplementationOnce(async () => write.promise);
        h.controller.start();
        await flush();
        h.controller.stop();
        write.resolve();
        await flush();
        expect(h.play).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("ignores an audio result after stop and cancels all later notifications", async () => {
        const h = harness();
        const audio = deferred<boolean>();
        h.play.mockReturnValueOnce(audio.promise);
        h.controller.start();
        await flush();
        h.controller.stop();
        audio.resolve(true);
        await flush();
        expect(h.onState).toHaveBeenLastCalledWith({ status: "stopped" });
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["tickets.changed", "tickets.unavailable", "permissions.changed", "stop", "session", "stale"])(
        "passes a guard that prevents delayed audio after %s", async event => {
            const h = harness();
            const decoded = deferred<void>();
            const actualSound = vi.fn();
            h.play.mockImplementation(async stillValid => {
                expect(stillValid()).toBe(true);
                await decoded.promise;
                if (!stillValid()) return false;
                actualSound();
                return true;
            });
            h.controller.start();
            await flush();
            expect(h.play).toHaveBeenCalledTimes(1);
            h.get.mockResolvedValue(assigned({ tickets: [] }));
            if (event === "stop") h.controller.stop();
            else if (event === "session") h.change({ sessionId: "changed-during-decode" });
            else if (event === "stale") await vi.advanceTimersByTimeAsync(75_001);
            else h.controller.invalidate(event);
            decoded.resolve();
            await flush();
            expect(actualSound).not.toHaveBeenCalled();
            expect(h.onState.mock.calls.some(([state]) => state.played === true)).toBe(false);
        },
    );

    it("restart waits for an unabortable old read and never consumes its response", async () => {
        const h = harness();
        const old = deferred<unknown>();
        h.get.mockReturnValueOnce(old.promise).mockResolvedValueOnce(assigned({ tickets: [] }));
        h.controller.start();
        await flush();
        h.controller.stop();
        h.controller.start();
        await flush();
        expect(h.get).toHaveBeenCalledTimes(1);
        old.resolve(assigned());
        await flush();
        expect(h.get).toHaveBeenCalledTimes(2);
        expect(h.play).not.toHaveBeenCalled();
    });

    it("does not start when current is disabled, and isolates UI exceptions", async () => {
        const h = harness();
        h.change({ enabled: false });
        h.controller.start();
        await flush();
        expect(h.get).not.toHaveBeenCalled();
        h.change({ enabled: true });
        h.onState.mockImplementation(() => { throw new Error("UI"); });
        h.controller.start();
        await flush();
        expect(h.play).toHaveBeenCalledTimes(1);
    });
});
