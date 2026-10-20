import { reminderDestination } from "../src/core/reminderDestination";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PanelError } from "../src/core/panelClient";
import { parseNotificationSettings, type PanelNotificationSettings, type ReminderOptions } from "../src/core/panelReminders";
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
    ticketRemindersState: { get(): State; set(patch: Partial<State>): void; };
    syncTicketReminders(binding: Binding): void;
    refreshTicketReminders(): Promise<void>;
    setDiscordReminders(enabled: boolean): Promise<void>;
    stopTicketReminders(): void;
    invalidateTicketReminders(event?: string): void;
}
type EngineOptions = ReminderOptions;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-19T00:00:00Z")); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function harness() {
    const client = fakeClient();
    const binding: Binding = {
        client, accountId, projects: ["majestic", "russia-online"], scopes: [...scopes],
        permissionsRevision: "permissions-v1", current: vi.fn(() => true), onAuthError: vi.fn(),
    };
    const storage = { get: vi.fn(async (_key: string): Promise<unknown> => undefined), set: vi.fn(async (_key: string, _value: unknown) => {}) };
    const showReminderNotification = vi.fn();
    const openReminderChannel = vi.fn(() => true);
    const reminderSoundPolicy = vi.fn(() => ({ enabled: true, revision: 0 }));
    const playTicketReminder = vi.fn(async (valid: () => boolean) => valid());
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
        "../core/panelReminders": { createReminderController, parseNotificationSettings },
        "../platform": { storage },
        "../core/reminderDestination": { reminderDestination },
        "../reminderNavigation": { openReminderChannel },
        "./reminderNoticeStore": { showReminderNotification, clearReminderNotifications: vi.fn() },
        "./ticketSound": { reminderSoundPolicy, playTicketReminder, prepareTicketSound: vi.fn(), stopTicketReminderSound: vi.fn() },
        "./observable": {
            createObservable<T extends object>(initial: T) {
                let value = initial;
                return { get: () => value, set: (patch: Partial<T>) => { value = { ...value, ...patch }; } };
            },
        },
    };
    const exports = {} as Runtime;
    runInNewContext(code, {
        exports, Date,
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
    return { ...exports, client, binding, storage, showReminderNotification, reminderSoundPolicy, playTicketReminder, createReminderController, engines, running, ready,
        state: () => exports.ticketRemindersState.get() };
}

describe("reminder settings rate limits", () => {
    it.each([
        new PanelError("network_error"), new PanelError("transport_error"),
        new PanelError("http_error", 503), new Error("Malformed settings"),
    ])("backs off repeated settings failures without revoking the session: %s", async error => {
        const h = harness(); await h.ready(); h.client.get.mockClear();
        h.client.get.mockRejectedValue(error);
        await h.refreshTicketReminders();
        for (let i = 0; i < 100; i++) {
            h.syncTicketReminders({ ...h.binding }); await h.refreshTicketReminders();
        }
        expect(h.client.get).toHaveBeenCalledOnce();
        expect(h.state().phase).toBe("offline");
        expect(h.binding.onAuthError).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(9999);
        await h.refreshTicketReminders(); expect(h.client.get).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        await h.refreshTicketReminders(); expect(h.client.get).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(19999);
        await h.refreshTicketReminders(); expect(h.client.get).toHaveBeenCalledTimes(2);
        h.client.get.mockResolvedValue(settings());
        await vi.advanceTimersByTimeAsync(1);
        await h.refreshTicketReminders();
        expect(h.state().phase).toBe("ready");
    });

    it.each([120000, undefined])("bounds reads after 429 Retry-After=%s despite repeated library sync/reloads", async retryAfter => {
        const h = harness(); await h.ready(); h.client.get.mockClear();
        h.client.get.mockRejectedValueOnce(new PanelError("rate_limited", 429, retryAfter));
        await h.refreshTicketReminders();
        for (let i = 0; i < 100; i++) {
            h.syncTicketReminders({ ...h.binding }); await h.refreshTicketReminders();
        }
        expect(h.client.get).toHaveBeenCalledOnce();
        expect(h.state().phase).toBe("offline"); expect(h.binding.onAuthError).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync((retryAfter ?? 60000) - 1);
        await h.refreshTicketReminders(); expect(h.client.get).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        await h.refreshTicketReminders(); expect(h.client.get).toHaveBeenCalledTimes(2);
        expect(h.state().phase).toBe("ready");
    });

    it("does not transfer an old binding's delayed 429 to a replacement session", async () => {
        const h = harness(); await h.ready(); const old = deferred<unknown>();
        h.client.get.mockReturnValueOnce(old.promise); const pending = h.refreshTicketReminders();
        h.stopTicketReminders(); const next = fakeClient();
        h.syncTicketReminders({ ...h.binding, client: next }); await h.refreshTicketReminders();
        old.reject(new PanelError("rate_limited", 429, 120000)); await pending;
        await h.refreshTicketReminders(); expect(next.get).toHaveBeenCalledTimes(2);
        expect(h.state().phase).toBe("ready");
    });
});
