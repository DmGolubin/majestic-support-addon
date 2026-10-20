import { reminderDestination } from "../src/core/reminderDestination";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PanelError } from "../src/core/panelClient";
import { parseAssignedSnapshot, parseNotificationSettings, type PanelNotificationSettings, type ReminderOptions, type ReminderPlaybackTicket } from "../src/core/panelReminders";
import type { PanelMutation } from "../src/core/panelProtocol";

// Run the actual adapter; replace the engine and host services, retaining the real settings parser.
const code = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/ticketReminders.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const scopes = ["tickets:assigned:read", "notifications:settings:read", "notifications:settings:write"];
const accountId = "111111111111111111";
const otherAccountId = "222222222222222222";
const settings = (discordEnabled = true, version = "settings-v1"): PanelNotificationSettings => ({
    version, discordEnabled, thresholdSource: "telegram",
    projects: [
        { project: "majestic", personalReminderMinutes: 5, telegramEnabled: true },
        { project: "russia-online", personalReminderMinutes: 15, telegramEnabled: false },
    ],
});
const idle = { phase: "idle", settings: null, busy: false, error: "", deliveryError: "" };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fakeClient() {
    return {
        connectionId: "12345678-1234-1234-1234-123456789abc",
        get: vi.fn<(path: string) => Promise<unknown>>(async path => {
            if (path === "/notification-settings") return settings();
            throw new Error(`Unexpected GET: ${path}`);
        }),
        mutate: vi.fn<(request: PanelMutation, guard: () => void) => Promise<unknown>>(async () => {
            throw new Error("Unexpected mutation");
        }),
    };
}
type Binding = {
    client: ReturnType<typeof fakeClient>;
    accountId: string;
    projects: string[];
    scopes: readonly string[];
    permissionsRevision: string;
    current(): boolean;
    onAuthError(error: unknown): void;
};
interface State {
    phase: "idle" | "permission" | "loading" | "ready" | "offline";
    settings: PanelNotificationSettings | null;
    busy: boolean;
    error: string;
    deliveryError: string;
}
interface Runtime {
    previewTicketReminderNotification(project?: "majestic" | "russia-online"): void;
    ticketRemindersState: { get(): State; set(patch: Partial<State>): void; };
    syncTicketReminders(binding: Binding): void;
    refreshTicketReminders(): Promise<void>;
    setDiscordReminders(enabled: boolean): Promise<void>;
    stopTicketReminders(): void;
    invalidateTicketReminders(event?: string): void;
}
type EngineOptions = ReminderOptions;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); vi.useRealTimers(); });

function harness() {
    const client = fakeClient();
    const binding: Binding = {
        client, accountId, projects: ["majestic", "russia-online"], scopes: [...scopes],
        permissionsRevision: "permissions-v1", current: vi.fn(() => true), onAuthError: vi.fn(),
    };
    const storage = { get: vi.fn(async (_key: string): Promise<unknown> => undefined), set: vi.fn(async (_key: string, _value: unknown) => {}) };
    const showReminderNotification = vi.fn();
    const openReminderChannel = vi.fn(() => true);
    const reminderSoundPolicy = vi.fn<NonNullable<EngineOptions["projectSound"]>>(() => ({ enabled: true, revision: 0 }));
    const playTicketReminder = vi.fn(async (valid: () => boolean, _ticket?: ReminderPlaybackTicket) => valid());
    const prepareTicketSound = vi.fn(), stopTicketReminderSound = vi.fn();
    const engines: {
        options: EngineOptions;
        running: boolean;
        start: ReturnType<typeof vi.fn>;
        stop: ReturnType<typeof vi.fn>;
        invalidate: ReturnType<typeof vi.fn>;
        refresh: ReturnType<typeof vi.fn>;
    }[] = [];
    const createReminderController = vi.fn((options: EngineOptions) => {
        const engine = {
            options, running: false,
            start: vi.fn(() => { engine.running = true; }),
            stop: vi.fn(() => { engine.running = false; }),
            invalidate: vi.fn(), refresh: vi.fn(async () => {}),
        };
        engines.push(engine);
        return engine;
    });
    const dependencies: Record<string, unknown> = {
        "../core/panelClient": { PanelError },
        "../core/panelReminders": { createReminderController, parseNotificationSettings, parseAssignedSnapshot },
        "../platform": { storage },
        "../core/reminderDestination": { reminderDestination },
        "../reminderNavigation": { openReminderChannel },
        "./reminderNoticeStore": { showReminderNotification, clearReminderNotifications: vi.fn() },
        "./ticketSound": { reminderSoundPolicy, playTicketReminder, prepareTicketSound, stopTicketReminderSound },
        "./observable": {
            createObservable<T extends object>(initial: T) {
                let value = initial;
                return { get: () => value, set: (patch: Partial<T>) => { value = { ...value, ...patch }; } };
            },
        },
    };
    const exports = {} as Runtime;
    runInNewContext(code, {
        exports,
        Date,
        performance,
        require: (id: string) => { if (!(id in dependencies)) throw new Error(`Unexpected import: ${id}`); return dependencies[id]; },
    });
    cleanups.push(exports.stopTicketReminders);
    const running = () => engines.filter(e => e.running);
    async function ready(initial = settings()) {
        client.get.mockResolvedValueOnce(initial);
        exports.syncTicketReminders(binding);
        await exports.refreshTicketReminders();
        expect(exports.ticketRemindersState.get()).toMatchObject({ phase: "ready", settings: initial, busy: false });
    }
    return { ...exports, client, binding, storage, showReminderNotification, openReminderChannel, reminderSoundPolicy, playTicketReminder, prepareTicketSound, stopTicketReminderSound, createReminderController, engines, running, ready,
        state: () => exports.ticketRemindersState.get() };
}

describe("ticket reminder adapter", () => {
    const mappedTicket = (project: "majestic" | "russia-online" = "majestic"): ReminderPlaybackTicket => ({
        ticketId: "panel:opaque:42", project, guildId: project === "majestic" ? "530693013622489088" : "1089530150540034181",
        channelId: "323456789012345678", waitingCycleId: "cycle-1", reminderId: "reminder-1", cycle: 1,
    });
    const assigned = (ticket = mappedTicket()) => ({
        accountId, revision: "assigned-1", serverTime: "2026-10-20T12:00:00Z", checkedAt: "2026-10-20T12:00:00Z",
        maxAgeSeconds: 75, discordEnabled: true, tickets: [{
            ...ticket, assigneeAccountId: accountId, state: "waiting_support", waitingSince: "2026-10-20T11:50:00Z", reminderAt: "2026-10-20T11:55:00Z",
        }],
    });
    it.each(["majestic", "russia-online"] as const)("A29 displays %s and opens only the freshly verified exact assignment", async project => {
        const h = harness(); await h.ready();
        const ticket = mappedTicket(project);
        await h.running()[0].options.play(() => true, ticket);
        const [shownProject, options] = h.showReminderNotification.mock.calls[0];
        expect(shownProject).toBe(project);
        expect(options.valid()).toBe(true);
        h.client.get.mockClear(); h.client.get.mockResolvedValueOnce(assigned(ticket));
        expect(await options.open(() => true)).toBe(true);
        expect(h.client.get).toHaveBeenCalledExactlyOnceWith("/tickets/assigned");
        expect(h.openReminderChannel).toHaveBeenCalledExactlyOnceWith(ticket, expect.any(Function));
        expect(h.client.mutate).not.toHaveBeenCalled();
        expect(h.storage.set).not.toHaveBeenCalled();
    });
    it.each(["missing", "guild mismatch", "opaque channel"] as const)("A29 shows a non-clickable card when mapping is %s", async reason => {
        const h = harness(); await h.ready();
        const ticket = mappedTicket();
        if (reason === "missing") ticket.channelId = null;
        if (reason === "guild mismatch") ticket.guildId = "1089530150540034181";
        if (reason === "opaque channel") ticket.channelId = "42";
        await h.running()[0].options.play(() => true, ticket);
        expect(h.showReminderNotification.mock.calls[0][1].open).toBeUndefined();
        expect(h.openReminderChannel).not.toHaveBeenCalled();
    });
    it.each(["account", "assignee", "answered", "cycle", "channel", "guild", "missing", "disabled", "stale"] as const)("A29 refuses click after %s changes", async reason => {
        const h = harness(); await h.ready();
        await h.running()[0].options.play(() => true, mappedTicket());
        const options = h.showReminderNotification.mock.calls[0][1];
        const data = assigned();
        if (reason === "account") data.accountId = otherAccountId;
        if (reason === "assignee") data.tickets[0].assigneeAccountId = otherAccountId;
        if (reason === "answered") Object.assign(data.tickets[0], { state: "waiting_player", waitingSince: null, waitingCycleId: null, reminderAt: null, reminderId: null });
        if (reason === "cycle") data.tickets[0].waitingCycleId = "new-cycle";
        if (reason === "channel") data.tickets[0].channelId = "423456789012345678";
        if (reason === "guild") data.tickets[0].guildId = "1089530150540034181";
        if (reason === "missing") data.tickets = [];
        if (reason === "disabled") data.discordEnabled = false;
        if (reason === "stale") data.checkedAt = "2026-10-20T11:58:00Z";
        h.client.get.mockResolvedValueOnce(data);
        expect(await options.open(() => true)).toBe(false);
        expect(h.openReminderChannel).not.toHaveBeenCalled();
        expect(h.client.mutate).not.toHaveBeenCalled();
    });
    it.each(["dismiss", "logout", "account", "permissions"] as const)("A29 cancels an in-flight click on %s", async reason => {
        const h = harness(); await h.ready();
        await h.running()[0].options.play(() => true, mappedTicket());
        const options = h.showReminderNotification.mock.calls[0][1];
        const response = deferred<unknown>(); h.client.get.mockReturnValueOnce(response.promise);
        let live = true;
        const pending = options.open(() => live);
        if (reason === "dismiss") live = false;
        if (reason === "logout") h.stopTicketReminders();
        if (reason === "account") (h.binding.current as ReturnType<typeof vi.fn>).mockReturnValue(false);
        if (reason === "permissions") h.binding.scopes = [];
        response.resolve(assigned());
        expect(await pending).toBe(false);
        expect(h.openReminderChannel).not.toHaveBeenCalled();
    });
    it("A29 honors navigation Retry-After without repeated reads", async () => {
        const h = harness(); await h.ready();
        await h.running()[0].options.play(() => true, mappedTicket());
        const options = h.showReminderNotification.mock.calls[0][1];
        h.client.get.mockClear();
        h.client.get.mockRejectedValueOnce(new PanelError("rate_limited", 429, 120000));
        expect(await options.open(() => true)).toBe(false);
        expect(await options.open(() => true)).toBe(false);
        expect(h.client.get).toHaveBeenCalledOnce();
        expect(h.openReminderChannel).not.toHaveBeenCalled();
    });
    it("A29 routes a click's 401 through existing auth invalidation without navigation", async () => {
        const h = harness(); await h.ready();
        await h.running()[0].options.play(() => true, mappedTicket());
        const failure = new PanelError("session_revoked", 401);
        h.client.get.mockRejectedValueOnce(failure);
        expect(await h.showReminderNotification.mock.calls[0][1].open(() => true)).toBe(false);
        expect(h.binding.onAuthError).toHaveBeenCalledExactlyOnceWith(failure);
        expect(h.openReminderChannel).not.toHaveBeenCalled();
    });
    it.each(["majestic", "russia-online"] as const)("A29 manual %s preview passes no navigation closure or fake record", project => {
        const h = harness();
        h.previewTicketReminderNotification(project);
        expect(h.showReminderNotification).toHaveBeenCalledExactlyOnceWith(project);
        expect(h.client.get).not.toHaveBeenCalled();
        expect(h.playTicketReminder).not.toHaveBeenCalled();
        expect(h.openReminderChannel).not.toHaveBeenCalled();
    });
    it.each([false, true])("manually previews the real showReminderNotification without API/audio/controller/storage mutations (connected=%s)", async connected => {
        const h = harness(); if (connected) await h.ready();
        const before = structuredClone(h.state());
        for (const spy of [h.client.get, h.client.mutate, h.storage.get, h.storage.set, h.createReminderController, h.stopTicketReminderSound, h.prepareTicketSound]) spy.mockClear();
        expect(h.showReminderNotification).not.toHaveBeenCalled();
        h.previewTicketReminderNotification();
        expect(h.showReminderNotification).toHaveBeenCalledExactlyOnceWith("majestic");
        expect(h.state()).toEqual(before);
        for (const spy of [h.client.get, h.client.mutate, h.storage.get, h.storage.set, h.createReminderController, h.stopTicketReminderSound, h.prepareTicketSound, h.playTicketReminder]) expect(spy).not.toHaveBeenCalled();
    });

    it("contains host showReminderNotification failures during manual preview without changing reminder state", () => {
        const h = harness(); const before = structuredClone(h.state());
        h.showReminderNotification.mockImplementationOnce(() => { throw Error("host unavailable"); });
        expect(() => h.previewTicketReminderNotification()).not.toThrow();
        expect(h.state()).toEqual(before); expect(h.client.get).not.toHaveBeenCalled();
    });

    it("passes local project eligibility into selection without changing API master settings", async () => {
        const h = harness(); await h.ready();
        h.reminderSoundPolicy.mockImplementation(project => ({ enabled: project === "russia-online", revision: 2 }));
        expect(h.running()[0].options.projectSound?.("majestic")).toEqual({ enabled: false, revision: 2 });
        const ticket: ReminderPlaybackTicket = { ticketId: "42", channelId: null, guildId: null, project: "majestic", waitingCycleId: "cycle", reminderId: "reminder", cycle: 1 };
        expect(await h.running()[0].options.play(() => true, ticket)).toBe(false);
        expect(await h.running()[0].options.play(() => true, { ...ticket, project: "russia-online" })).toBe(true);
        expect(h.state().settings?.discordEnabled).toBe(true);
        expect(h.client.mutate).not.toHaveBeenCalled();
    });

    it("global API disable invalidates a project playback awaiting decode before PATCH resolves", async () => {
        const h = harness(); await h.ready();
        const decode = deferred<void>(), patch = deferred<unknown>(); let started = false;
        h.playTicketReminder.mockImplementationOnce(async valid => { await decode.promise; started = valid(); return started; });
        const ticket: ReminderPlaybackTicket = { ticketId: "42", channelId: null, guildId: null, project: "russia-online", waitingCycleId: "cycle", reminderId: "reminder", cycle: 1 };
        const playing = h.running()[0].options.play(() => true, ticket);
        h.client.mutate.mockReturnValueOnce(patch.promise);
        const disabling = h.setDiscordReminders(false);
        decode.resolve(); expect(await playing).toBe(false); expect(started).toBe(false);
        expect(h.stopTicketReminderSound).toHaveBeenCalled();
        expect(h.showReminderNotification).not.toHaveBeenCalled();
        patch.resolve(settings(false, "v2")); await disabling;
    });

    it("passes the chosen technical ticket context to the guarded audio call", async () => {
        const h = harness(); await h.ready();
        const ticket: ReminderPlaybackTicket = { ticketId: "regional:42", channelId: null, guildId: null, project: "majestic",
            waitingCycleId: "cycle-1", reminderId: "reminder-1", cycle: 7 };
        expect(await h.running()[0].options.play(() => true, ticket)).toBe(true);
        expect(h.playTicketReminder.mock.calls[0][1]).toEqual(ticket);
    });
    it("prepares audio in the enable gesture and stops active reminders immediately on disable", async () => {
        const h = harness(); await h.ready(settings(false));
        h.client.mutate.mockResolvedValueOnce(settings(true, "v2"));
        const enabling = h.setDiscordReminders(true);
        expect(h.prepareTicketSound).toHaveBeenCalledExactlyOnceWith("reminder");
        await enabling;
        h.stopTicketReminderSound.mockClear();
        const write = deferred<unknown>(); h.client.mutate.mockReturnValueOnce(write.promise);
        const disabling = h.setDiscordReminders(false);
        expect(h.stopTicketReminderSound).toHaveBeenCalledOnce();
        write.resolve(settings(false, "v3")); await disabling;
    });
    it("does not reject a successful audio receipt when the host showReminderNotification fails", async () => {
        const h = harness(); await h.ready();
        h.showReminderNotification.mockImplementation(() => { throw Error("host disposed"); });
        await expect(h.running()[0].options.play(() => true, { ticketId: "42", project: "majestic", guildId: null, channelId: null,
            waitingCycleId: "cycle", reminderId: "reminder", cycle: 1 })).resolves.toBe(true);
    });
    it.each([[], ...scopes.map(missing => scopes.filter(scope => scope !== missing))].map(granted => ({ granted })))(
        "requires every requested scope before reading or mutating ($granted)", async ({ granted }) => {
            const h = harness();
            h.binding.scopes = granted;
            h.syncTicketReminders(h.binding);
            h.syncTicketReminders({ ...h.binding });
            await h.refreshTicketReminders();
            await h.setDiscordReminders(true);
            expect(h.state()).toEqual({ ...idle, phase: "permission" });
            expect(h.client.get).not.toHaveBeenCalled();
            expect(h.client.mutate).not.toHaveBeenCalled();
            expect(h.createReminderController).not.toHaveBeenCalled();
            expect(h.storage.set).not.toHaveBeenCalled();
        },
    );

    it("coalesces pending settings reads for an unchanged binding and starts only after settings arrive", async () => {
        const h = harness();
        const read = deferred<unknown>();
        h.client.get.mockReturnValueOnce(read.promise);
        h.syncTicketReminders(h.binding);
        h.syncTicketReminders({ ...h.binding, projects: [...h.binding.projects], scopes: [...scopes] });
        const first = h.refreshTicketReminders(), second = h.refreshTicketReminders();
        expect(h.state()).toMatchObject({ phase: "loading", settings: null });
        expect(h.client.get).toHaveBeenCalledExactlyOnceWith("/notification-settings");
        expect(h.running()).toHaveLength(0);
        read.resolve(settings());
        await Promise.all([first, second]);
        expect(h.state().phase).toBe("ready");
        expect(h.running()).toHaveLength(1);
        expect(h.client.get).toHaveBeenCalledTimes(1);
    });

    it("passes the verified context, assigned-ticket reader and storage to the engine", async () => {
        const h = harness();
        await h.ready();
        const engine = h.running()[0];
        expect(engine.options).toMatchObject({ accountId, projects: h.binding.projects, storage: h.storage });
        expect(engine.options.storage).toBe(h.storage);
        expect(engine.options.current()).toEqual({
            accountId, projects: h.binding.projects, sessionId: h.client.connectionId,
            permissionsRevision: h.binding.permissionsRevision, enabled: true,
        });
        const snapshot = { revision: "assigned-v1" };
        h.client.get.mockResolvedValueOnce(snapshot);
        await expect(engine.options.get()).resolves.toBe(snapshot);
        expect(h.client.get).toHaveBeenLastCalledWith("/tickets/assigned");
        engine.invalidate.mockClear();
        h.invalidateTicketReminders("tickets.changed");
        expect(engine.invalidate).toHaveBeenCalledExactlyOnceWith("tickets.changed");
        h.binding.current = () => false;
        expect(engine.options.current()).toBeNull();
        await expect(engine.options.play(() => true)).resolves.toBe(false);
    });

    it.each([false, true])("GET 403 enters permission and requires reconnect (previously ready: %s)", async previouslyReady => {
        const h = harness();
        if (previouslyReady) await h.ready();
        h.client.get.mockRejectedValueOnce(new PanelError("insufficient_scope", 403));
        if (!previouslyReady) h.syncTicketReminders(h.binding);
        await h.refreshTicketReminders();
        expect(h.state()).toMatchObject({ phase: "permission", busy: false });
        expect(h.state().error).toContain("Подключите аккаунт заново");
        expect(h.running()).toHaveLength(0);
        for (const engine of h.engines) {
            expect(engine.options.current()).toMatchObject({ enabled: false });
            await expect(engine.options.play(() => true)).resolves.toBe(false);
        }
        const reads = h.client.get.mock.calls.length;
        await h.refreshTicketReminders();
        h.syncTicketReminders({ ...h.binding });
        await h.setDiscordReminders(true);
        expect(h.client.get).toHaveBeenCalledTimes(reads);
        expect(h.client.mutate).not.toHaveBeenCalled();
        expect(h.binding.onAuthError).not.toHaveBeenCalled();
        expect(h.playTicketReminder).not.toHaveBeenCalled();
        const reconnected = fakeClient();
        reconnected.connectionId = "12345678-1234-1234-1234-123456789def";
        h.syncTicketReminders({ ...h.binding, client: reconnected });
        await h.refreshTicketReminders();
        expect(reconnected.get).toHaveBeenCalledExactlyOnceWith("/notification-settings");
        expect(h.state()).toMatchObject({ phase: "ready", error: "", settings: settings() });
        expect(h.running()).toHaveLength(1);
    });

    it.each([new PanelError("network_error"), new PanelError("server_error", 500)])(
        "other settings read errors stay offline and retry after backoff ($code)", async error => {
            vi.useFakeTimers({ toFake: ["Date"] });
            const h = harness();
            await h.ready();
            const engine = h.running()[0];
            h.client.get.mockRejectedValueOnce(error);
            await h.refreshTicketReminders();
            expect(h.state()).toMatchObject({ phase: "offline", busy: false });
            expect(h.state().error).toContain("Повторите проверку");
            expect(h.running()).toHaveLength(0);
            expect(engine.options.current()).toMatchObject({ enabled: false });
            expect(h.binding.onAuthError).not.toHaveBeenCalled();
            await expect(engine.options.play(() => true)).resolves.toBe(false);
            await h.refreshTicketReminders();
            expect(h.client.get).toHaveBeenCalledTimes(2);
            vi.setSystemTime(Date.now() + 10000);
            await h.refreshTicketReminders();
            expect(h.client.get).toHaveBeenCalledTimes(3);
            expect(h.state()).toMatchObject({ phase: "ready", error: "" });
            expect(engine.options.current()).toMatchObject({ enabled: true });
            expect(h.running()).toHaveLength(1);
            expect(h.client.mutate).not.toHaveBeenCalled();
        },
    );

    it.each([true, false])("PATCHes only discordEnabled=%s with the saved version, stopping delivery until verified", async enabled => {
        const h = harness();
        await h.ready(settings(!enabled, "opaque-v7"));
        const write = deferred<unknown>();
        h.client.mutate.mockImplementationOnce((_request, guard) => { guard(); return write.promise; });
        const updating = h.setDiscordReminders(enabled);
        expect(h.client.mutate).toHaveBeenCalledExactlyOnceWith({
            path: "/notification-settings", method: "PATCH", version: "opaque-v7", body: { discordEnabled: enabled },
        }, expect.any(Function));
        expect(h.state()).toMatchObject({ busy: true, settings: settings(!enabled, "opaque-v7") });
        expect(h.running()).toHaveLength(0);
        for (const engine of h.engines) {
            expect(engine.options.current()).toMatchObject({ enabled: false });
            await expect(engine.options.play(() => true)).resolves.toBe(false);
        }
        await h.setDiscordReminders(!enabled);
        await h.refreshTicketReminders();
        expect(h.client.mutate).toHaveBeenCalledTimes(1);
        expect(h.client.get).toHaveBeenCalledTimes(1);
        write.resolve(settings(enabled, "opaque-v8"));
        await updating;
        expect(h.state()).toMatchObject({ phase: "ready", busy: false, error: "", settings: settings(enabled, "opaque-v8") });
        expect(h.engines.at(-1)!.options.current()).toMatchObject({ enabled });
        if (enabled) expect(h.running()).toHaveLength(1);
        expect(h.playTicketReminder).not.toHaveBeenCalled();
        expect(h.storage.set).not.toHaveBeenCalled();
    });

    it.each([
        { error: new PanelError("conflict", 412), message: "Настройки изменились на панели" },
        { error: new PanelError("network_error"), message: "Результат сохранения не подтверждён" },
    ])("keeps delivery stopped after $error.code until explicit reread, without replaying PATCH", async ({ error, message }) => {
        const h = harness();
        await h.ready();
        h.client.mutate.mockRejectedValueOnce(error);
        await h.setDiscordReminders(false);
        expect(h.state()).toMatchObject({ phase: "offline", busy: false });
        expect(h.state().error).toContain(message);
        expect(h.running()).toHaveLength(0);
        for (const engine of h.engines) await expect(engine.options.play(() => true)).resolves.toBe(false);
        await h.setDiscordReminders(false);
        await flush();
        expect(h.client.get).toHaveBeenCalledTimes(1);
        expect(h.client.mutate).toHaveBeenCalledTimes(1);
        const reread = deferred<unknown>();
        h.client.get.mockReturnValueOnce(reread.promise);
        const retry = h.refreshTicketReminders();
        expect(h.running()).toHaveLength(0);
        expect(h.client.get).toHaveBeenLastCalledWith("/notification-settings");
        reread.resolve(settings(true, "verified-v9"));
        await retry;
        expect(h.state()).toMatchObject({ phase: "ready", busy: false, error: "", settings: settings(true, "verified-v9") });
        expect(h.running()).toHaveLength(1);
        expect(h.client.mutate).toHaveBeenCalledTimes(1);
        expect(h.playTicketReminder).not.toHaveBeenCalled();
    });

    it.each(["before", "after"] as const)("ignores a settings read that resolves %s the newer PATCH", async timing => {
        const h = harness();
        await h.ready();
        const stale = deferred<unknown>(), write = deferred<unknown>();
        h.client.get.mockReturnValueOnce(stale.promise);
        const reading = h.refreshTicketReminders();
        h.client.mutate.mockReturnValueOnce(write.promise);
        const updating = h.setDiscordReminders(false);
        if (timing === "before") {
            stale.resolve(settings(true, "stale-v0"));
            await reading;
            expect(h.state()).toMatchObject({ busy: true, settings: settings() });
            expect(h.running()).toHaveLength(0);
        }
        write.resolve(settings(false, "patch-v2"));
        await updating;
        if (timing === "after") {
            stale.resolve(settings(true, "stale-v0"));
            await reading;
        }
        expect(h.state()).toMatchObject({ phase: "ready", busy: false, settings: settings(false, "patch-v2") });
        expect(h.client.mutate).toHaveBeenCalledTimes(1);
    });

    it.each(["read", "patch"] as const)("stop clears state and ignores late %s responses and engine callbacks", async operation => {
        const h = harness();
        await h.ready();
        const engine = h.running()[0];
        engine.options.onState?.({ status: "unavailable" });
        expect(h.state().deliveryError).not.toBe("");
        const response = deferred<unknown>();
        let pending: Promise<void>;
        if (operation === "read") {
            h.client.get.mockReturnValueOnce(response.promise);
            pending = h.refreshTicketReminders();
        } else {
            h.client.mutate.mockReturnValueOnce(response.promise);
            pending = h.setDiscordReminders(false);
        }
        h.stopTicketReminders();
        expect(h.state()).toEqual(idle);
        expect(h.running()).toHaveLength(0);
        expect(engine.options.current()).toBeNull();
        if (operation === "patch") expect(() => h.client.mutate.mock.calls[0][1]()).toThrow(PanelError);
        response.resolve(settings(operation !== "patch", "late-v2"));
        await pending;
        engine.options.onState?.({ status: "unavailable" });
        await expect(engine.options.play(() => true)).resolves.toBe(false);
        expect(h.state()).toEqual(idle);
        expect(h.playTicketReminder).not.toHaveBeenCalled();
        expect(h.showReminderNotification).not.toHaveBeenCalled();
    });

    it.each(["read", "patch"] as const)("switching accounts clears state and rejects the previous account's late %s", async operation => {
        const h = harness();
        await h.ready();
        const oldEngine = h.running()[0];
        oldEngine.options.onState?.({ status: "unavailable" });
        const stale = deferred<unknown>();
        let pending: Promise<void>;
        if (operation === "read") {
            h.client.get.mockReturnValueOnce(stale.promise);
            pending = h.refreshTicketReminders();
        } else {
            h.client.mutate.mockReturnValueOnce(stale.promise);
            pending = h.setDiscordReminders(false);
        }
        const nextClient = fakeClient(), nextRead = deferred<unknown>();
        nextClient.get.mockReturnValueOnce(nextRead.promise);
        h.syncTicketReminders({ ...h.binding, client: nextClient, accountId: otherAccountId });
        expect(h.state()).toEqual({ ...idle, phase: "loading" });
        expect(oldEngine.running).toBe(false);
        expect(oldEngine.options.current()).toBeNull();
        stale.resolve(settings(operation !== "patch", "old-account-v2"));
        await pending;
        oldEngine.options.onState?.({ status: "unavailable" });
        expect(h.state()).toEqual({ ...idle, phase: "loading" });
        await expect(oldEngine.options.play(() => true)).resolves.toBe(false);
        const reading = h.refreshTicketReminders();
        nextRead.resolve(settings(true, "new-account-v1"));
        await reading;
        expect(h.state()).toMatchObject({ phase: "ready", settings: settings(true, "new-account-v1") });
        expect(h.running()).toHaveLength(1);
        expect(h.running()[0].options.current()).toMatchObject({ accountId: otherAccountId });
    });

    it("rebinds when the permission revision changes", async () => {
        const h = harness();
        await h.ready();
        const oldEngine = h.running()[0];
        h.syncTicketReminders({ ...h.binding, permissionsRevision: "permissions-v2" });
        await h.refreshTicketReminders();
        expect(oldEngine.stop).toHaveBeenCalled();
        expect(oldEngine.options.current()).toBeNull();
        expect(h.running()).toHaveLength(1);
        expect(h.running()[0].options.current()).toMatchObject({ permissionsRevision: "permissions-v2" });
    });

    it("maps engine status to delivery errors and clears them after recovery", async () => {
        const h = harness();
        await h.ready();
        const engine = h.running()[0];
        engine.options.onState?.({ status: "unavailable" });
        expect(h.state().deliveryError).toContain("Напоминания приостановлены");
        engine.options.onState?.({ status: "ready" });
        expect(h.state().deliveryError).toBe("");
    });

    it("keeps the engine context disabled when the initial settings disable Discord reminders", async () => {
        const h = harness();
        await h.ready(settings(false));
        expect(h.engines).toHaveLength(1);
        expect(h.engines[0].options.current()).toMatchObject({
            accountId, permissionsRevision: h.binding.permissionsRevision, enabled: false,
        });
        await expect(h.engines[0].options.play(() => true)).resolves.toBe(false);
        expect(h.playTicketReminder).not.toHaveBeenCalled();
        expect(h.showReminderNotification).not.toHaveBeenCalled();
    });

    it("disables the engine context and never plays after switching Discord reminders off", async () => {
        const h = harness();
        await h.ready();
        const engine = h.running()[0];
        h.client.mutate.mockResolvedValueOnce(settings(false, "disabled-v2"));
        await h.setDiscordReminders(false);
        expect(engine.options.current()).toMatchObject({ enabled: false });
        await expect(engine.options.play(() => true)).resolves.toBe(false);
        for (const e of h.engines) await expect(e.options.play(() => true)).resolves.toBe(false);
        expect(h.playTicketReminder).not.toHaveBeenCalled();
        expect(h.showReminderNotification).not.toHaveBeenCalled();
    });

    it("checks the engine validity guard before invoking sound", async () => {
        const h = harness();
        await h.ready();
        const play = h.running()[0].options.play;
        await expect(play(() => false)).resolves.toBe(false);
        expect(h.playTicketReminder).not.toHaveBeenCalled();
        await expect(play(() => true, { ticketId: "42", project: "majestic", guildId: null, channelId: null,
            waitingCycleId: "cycle", reminderId: "reminder", cycle: 1 })).resolves.toBe(true);
        expect(h.playTicketReminder).toHaveBeenCalledOnce();
        expect(h.showReminderNotification).toHaveBeenCalledExactlyOnceWith("majestic", { valid: expect.any(Function) });
    });

    it.each(["engine", "stop", "busy", "disabled"] as const)("rechecks %s validity inside deferred audio playback", async invalidation => {
        const h = harness();
        await h.ready();
        let engineValid = true;
        const audio = deferred<void>();
        h.playTicketReminder.mockImplementationOnce(async valid => { await audio.promise; return valid(); });
        const playing = h.running()[0].options.play(() => engineValid);
        expect(h.playTicketReminder).toHaveBeenCalledOnce();
        let updating: Promise<void> | undefined;
        const write = deferred<unknown>();
        if (invalidation === "engine") engineValid = false;
        if (invalidation === "stop") h.stopTicketReminders();
        if (invalidation === "busy" || invalidation === "disabled") {
            h.client.mutate.mockReturnValueOnce(write.promise);
            updating = h.setDiscordReminders(false);
            if (invalidation === "disabled") { write.resolve(settings(false, "disabled-v2")); await updating; }
        }
        audio.resolve();
        await expect(playing).resolves.toBe(false);
        expect(h.showReminderNotification).not.toHaveBeenCalled();
        if (invalidation === "busy") { write.resolve(settings(false, "disabled-v2")); await updating; }
    });

    it.each([
        new PanelError("unauthorized", 401), new PanelError("session_revoked"), new PanelError("refresh_uncertain"),
        new PanelError("not_authenticated"), new PanelError("invalid_grant"), new PanelError("vault_error"),
    ])("forwards fatal GET authentication errors to the parent ($code)", async error => {
        const h = harness();
        h.client.get.mockRejectedValueOnce(error);
        h.syncTicketReminders(h.binding);
        await h.refreshTicketReminders();
        expect(h.binding.onAuthError).toHaveBeenCalledExactlyOnceWith(error);
        expect(h.running()).toHaveLength(0);
        expect(h.client.mutate).not.toHaveBeenCalled();
    });

    it("forwards assigned-ticket and PATCH 401 errors, letting the parent stop the session", async () => {
        const h = harness();
        await h.ready();
        const error = new PanelError("unauthorized", 401);
        h.client.get.mockRejectedValueOnce(error);
        await expect(h.running()[0].options.get()).rejects.toBe(error);
        expect(h.binding.onAuthError).toHaveBeenCalledExactlyOnceWith(error);
        h.binding.onAuthError = vi.fn(() => h.stopTicketReminders());
        h.client.mutate.mockRejectedValueOnce(error);
        await h.setDiscordReminders(false);
        expect(h.binding.onAuthError).toHaveBeenCalledExactlyOnceWith(error);
        expect(h.state()).toEqual(idle);
        expect(h.running()).toHaveLength(0);
    });

    it("ignores a late auth error from a stopped binding", async () => {
        const h = harness(), response = deferred<unknown>();
        h.client.get.mockReturnValueOnce(response.promise);
        h.syncTicketReminders(h.binding);
        const reading = h.refreshTicketReminders();
        h.stopTicketReminders();
        response.reject(new PanelError("unauthorized", 401));
        await reading;
        expect(h.binding.onAuthError).not.toHaveBeenCalled();
        expect(h.state()).toEqual(idle);
    });
});
