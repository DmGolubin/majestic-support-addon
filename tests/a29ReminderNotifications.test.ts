import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reminderDestination } from "../src/core/reminderDestination";
import { createReminderController, parseAssignedSnapshot, parseNotificationSettings, ReminderOptions } from "../src/core/panelReminders";
import { PanelError } from "../src/core/panelClient";

const compile = (file: string) => ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const storeCode = compile("../src/vencord/ui/reminderNoticeStore.ts");
const componentCode = compile("../src/vencord/ui/ReminderNotifications.tsx");
const navigationCode = compile("../src/vencord/reminderNavigation.ts");
const commonCode = compile("../betterdiscord/shims/common.ts");
const adapterCode = compile("../src/vencord/ui/ticketReminders.ts");
const all = (node: any): any[] => Array.isArray(node) ? node.flatMap(all)
    : node && typeof node === "object" ? [node, ...all(node.props?.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join("")
    : node && typeof node === "object" ? text(node.props?.children) : typeof node === "string" ? node : "";
const target = { ticketId: "opaque:42", project: "majestic" as const, guildId: "530693013622489088", channelId: "323456789012345678", waitingCycleId: "cycle", reminderId: "reminder", cycle: 1 };
const load = (code: string, deps: Record<string, unknown>, globals: object = {}) => {
    const exports: any = {};
    runInNewContext(code, { exports, ...globals, require: (id: string) => {
        if (!(id in deps)) throw Error("Unexpected import " + id); return deps[id];
    } });
    return exports;
};
function notices() {
    vi.useFakeTimers();
    const store = load(storeCode, { "./observable": { createObservable: (initial: any) => {
        let value = initial;
        return { get: () => value, use: () => value, set: (patch: any) => { value = { ...value, ...patch }; } };
    } } }, { performance: { now: () => Date.now() }, setTimeout, clearTimeout });
    const component = load(componentCode, { "./reminderNoticeStore": store, "./ProjectIcon": { ProjectIcon: "ProjectIcon" },
        "./svg": { IconClose: "IconClose" }, "./reminder-notifications.css": {} },
    { React: { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) } });
    return { ...store, render: () => component.ReminderNotifications(), items: () => store.reminderNotifications.get().items };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("manual reminder sample navigation", () => {
    function sample(destination = reminderDestination) {
        const h = notices();
        const channel = { id: "1562132664499175564", guild_id: "1089530150540034181" };
        const common = { ChannelStore: { getChannel: vi.fn((): typeof channel | null => channel) },
            PermissionStore: { can: vi.fn(() => true) }, NavigationRouter: { transitionTo: vi.fn() } };
        const forbidden = vi.fn(() => { throw Error("Preview touched delivery/API/storage/audio"); });
        const adapter = load(adapterCode, {
            "@webpack/common": common,
            "../core/panelClient": { PanelError }, "../core/reminderDestination": { reminderDestination: destination },
            "../core/panelReminders": { parseAssignedSnapshot: forbidden, parseNotificationSettings: forbidden, createReminderController: forbidden },
            "../platform": { storage: { get: forbidden, set: forbidden } }, "../reminderNavigation": { openReminderChannel: forbidden },
            "./reminderNoticeStore": h,
            "./ticketSound": { playTicketReminder: forbidden, reminderSoundPolicy: forbidden, prepareTicketSound: forbidden, stopTicketReminderSound: vi.fn() },
            "./observable": { createObservable: (value: any) => ({ get: () => value, set: (patch: any) => { value = { ...value, ...patch }; } }) },
        }, { Date, performance: { now: () => Date.now() } });
        return { ...h, ...adapter, channel, common, forbidden };
    }
    it("uses the production project mapping and rechecks it before navigating", async () => {
        const route = { guildId: "1089530150540034181", channelId: "1562132664499175564" };
        expect(reminderDestination({ ...route, project: "russia-online" })).toEqual(route);
        expect(reminderDestination({ ...route, project: "majestic" })).toBeNull();
        const destination = vi.fn(reminderDestination), h = sample(destination);
        h.previewTicketReminderNotification("russia-online");
        expect(h.items()[0].clickable).toBe(true);
        destination.mockReturnValue(null);
        await h.activateReminderNotification(h.items()[0].id);
        expect(h.common.NavigationRouter.transitionTo).not.toHaveBeenCalled();
        h.previewTicketReminderNotification("russia-online");
        expect(h.items().at(-1).clickable).toBe(false);
        expect(h.forbidden).not.toHaveBeenCalled();
    });
    it("opens the exact user sample only on click with the real button styling and a test label", async () => {
        const h = sample();
        h.previewTicketReminderNotification("russia-online");
        expect(h.items()[0]).toMatchObject({ test: true, clickable: true, project: "russia-online" });
        expect(h.common.ChannelStore.getChannel).not.toHaveBeenCalled();
        const button = all(h.render()).find(n => n.props.className === "vc-stx-reminder-open");
        expect(button.props).toMatchObject({ type: "button", "aria-label": "Открыть тестовый тикет · Россия Онлайн" });
        expect(text(button)).toBe("Открыть тикет");
        expect(text(h.render())).toContain("Тестовое уведомление");
        button.props.onClick();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.common.ChannelStore.getChannel).not.toHaveBeenCalled();
        expect(h.common.PermissionStore.can).not.toHaveBeenCalled();
        expect(h.common.NavigationRouter.transitionTo).toHaveBeenCalledExactlyOnceWith("/channels/1089530150540034181/1562132664499175564");
        expect(h.items()).toEqual([]);
        expect(h.forbidden).not.toHaveBeenCalled();
    });
    it("does not borrow the RO sample for Majestic", async () => {
        const h = sample(); h.previewTicketReminderNotification("majestic");
        expect(h.items()[0]).toMatchObject({ test: true, clickable: false, project: "majestic" });
        expect(text(h.render())).toContain("Тестовый тикет для этого проекта не задан");
        expect(all(h.render()).some(n => n.props.className === "vc-stx-reminder-open")).toBe(false);
        await h.activateReminderNotification(h.items()[0].id);
        expect(h.common.ChannelStore.getChannel).not.toHaveBeenCalled();
        expect(h.common.NavigationRouter.transitionTo).not.toHaveBeenCalled();
        expect(h.forbidden).not.toHaveBeenCalled();
    });
    it.each(["uncached", "locally denied"])("opens the explicit RO sample when %s without API/audio/storage or cache permission checks", async state => {
        const h = sample(); h.previewTicketReminderNotification("russia-online");
        if (state === "uncached") h.common.ChannelStore.getChannel.mockReturnValue(null);
        if (state === "locally denied") h.common.PermissionStore.can.mockReturnValue(false);
        await h.activateReminderNotification(h.items()[0].id);
        expect(h.common.NavigationRouter.transitionTo).toHaveBeenCalledExactlyOnceWith("/channels/1089530150540034181/1562132664499175564");
        expect(h.common.ChannelStore.getChannel).not.toHaveBeenCalled();
        expect(h.common.PermissionStore.can).not.toHaveBeenCalled();
        expect(h.forbidden).not.toHaveBeenCalled();
        expect(h.items()).toEqual([]);
    });
    it("keeps a clear test error when the router fails", async () => {
        const h = sample(); h.previewTicketReminderNotification("russia-online");
        h.common.NavigationRouter.transitionTo.mockImplementation(() => { throw Error("private host detail"); });
        await h.activateReminderNotification(h.items()[0].id);
        expect(h.items()[0]).toMatchObject({ test: true, busy: false });
        expect(text(h.render())).toContain("Тестовый тикет недоступен");
        expect(text(h.render())).not.toContain("private host detail");
        expect(h.forbidden).not.toHaveBeenCalled();
    });
    it.each(["dismiss", "expire", "stop"])("rejects a test callback after %s", async action => {
        const h = sample(); h.previewTicketReminderNotification("russia-online");
        const id = h.items()[0].id;
        if (action === "dismiss") h.dismissReminderNotification(id);
        if (action === "expire") await vi.advanceTimersByTimeAsync(45000);
        if (action === "stop") h.stopTicketReminders();
        await h.activateReminderNotification(id);
        expect(h.common.NavigationRouter.transitionTo).not.toHaveBeenCalled();
        expect(h.forbidden).not.toHaveBeenCalled();
    });
});

describe("A29 custom reminder cards", () => {
    it("keeps delivered cards clickable across real controller polls without repeating receipts", async () => {
        const h = notices();
        vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
        const accountId = "123456789012345678";
        const sound = { enabled: true, revision: 1 };
        let receipts: any;
        const storage = {
            get: vi.fn(async () => receipts),
            set: vi.fn(async (_key: string, value: unknown) => { receipts = structuredClone(value); }),
        };
        const navigate = vi.fn(() => true);
        const client = { connectionId: "session-A", get: vi.fn(async (path: string) => {
            if (path === "/notification-settings") return { version: "settings-1", thresholdSource: "telegram", discordEnabled: true,
                projects: [{ project: "majestic", personalReminderMinutes: 5, telegramEnabled: true }] };
            return { accountId, revision: "snapshot", serverTime: new Date(Date.now()).toISOString(), checkedAt: new Date(Date.now()).toISOString(),
                maxAgeSeconds: 75, discordEnabled: true, tickets: ["first", "second"].map((ticketId, index) => ({
                    ...target, ticketId, channelId: String(BigInt(target.channelId) + BigInt(index)), assigneeAccountId: accountId,
                    state: "waiting_support", waitingSince: "2026-10-20T11:50:00Z", reminderAt: "2026-10-20T11:55:00Z",
                })) };
        }) };
        const adapter = load(adapterCode, {
            "@webpack/common": {},
            "../core/panelClient": { PanelError }, "../core/reminderDestination": { reminderDestination },
            "../core/panelReminders": { parseAssignedSnapshot, parseNotificationSettings,
                createReminderController: (options: ReminderOptions) => createReminderController({ ...options, random: () => 0.5, clock: {
                    now: () => Date.now(), setTimeout, clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
                } }) },
            "../platform": { storage }, "../reminderNavigation": { openReminderChannel: navigate },
            "./reminderNoticeStore": h,
            "./ticketSound": { playTicketReminder: async (valid: () => boolean) => valid(), reminderSoundPolicy: () => sound,
                prepareTicketSound() {}, stopTicketReminderSound() {} },
            "./observable": { createObservable: (initial: any) => {
                let value = initial;
                return { get: () => value, set: (patch: any) => { value = { ...value, ...patch }; } };
            } },
        }, { Date, performance: { now: () => Date.now() } });
        try {
            adapter.syncTicketReminders({ client, accountId, projects: ["majestic"], permissionsRevision: "rights-1",
                scopes: ["tickets:assigned:read", "notifications:settings:read", "notifications:settings:write"],
                current: () => true, onAuthError: vi.fn() });
            await vi.advanceTimersByTimeAsync(0);
            expect(h.items()).toHaveLength(1);
            const first = h.items()[0].id;
            await vi.advanceTimersByTimeAsync(6000);
            expect(h.items().map((item: any) => item.id)).toEqual([first, first + 1]);
            expect(storage.set).toHaveBeenCalledTimes(2);
            expect(receipts.receipts).toHaveLength(2);
            await h.activateReminderNotification(first);
            expect(navigate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ticketId: "first", channelId: target.channelId }), expect.any(Function));
            expect(h.items()).toHaveLength(1);
            expect(storage.set).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(38000);
            expect(h.items()).toHaveLength(1);
            sound.enabled = false;
            await vi.advanceTimersByTimeAsync(1000);
            expect(h.items()).toHaveLength(0);
        } finally { adapter.stopTicketReminders(); }
    });
    it("uses project icons/names and distinct classes with explicit non-navigable previews", async () => {
        const h = notices();
        h.showReminderNotification("majestic"); h.showReminderNotification("russia-online");
        const tree = h.render();
        expect(all(tree).filter(n => n.type === "ProjectIcon").map(n => n.props.project)).toEqual(["mj", "ro"]);
        expect(text(tree)).toContain("Majestic");
        expect(text(tree)).toContain("Россия Онлайн");
        expect(all(tree).filter(n => n.props.className === "vc-stx-reminder-test")).toHaveLength(2);
        expect(all(tree).filter(n => n.type === "section").map(n => n.props.className))
            .toEqual(["vc-stx-reminder-notice vc-stx-reminder-notice-mj", "vc-stx-reminder-notice vc-stx-reminder-notice-ro"]);
        expect(all(tree).filter(n => n.props.role === "status")).toHaveLength(2);
        expect(all(tree).filter(n => n.type === "a" || n.props.className === "vc-stx-reminder-open")).toHaveLength(0);
        expect(JSON.stringify(h.items())).not.toContain("ticketId");
        for (const item of h.items()) await h.activateReminderNotification(item.id);
        expect(h.items()).toHaveLength(2);
    });
    it("does not offer a guessed route when the real reminder lacks mapping", () => {
        const h = notices(); h.showReminderNotification("majestic", { valid: () => true });
        expect(text(h.render())).toContain("Переход к тикету недоступен");
        expect(all(h.render()).some(n => n.props.className === "vc-stx-reminder-open")).toBe(false);
        expect(h.items()[0].test).toBe(false);
    });
    it("uses accessible buttons, locks double activation, and clears only after successful navigation", async () => {
        const h = notices();
        let finish!: (value: boolean) => void;
        const open = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
        h.showReminderNotification("russia-online", { valid: () => true, open });
        const id = h.items()[0].id;
        const pending = h.activateReminderNotification(id);
        await h.activateReminderNotification(id);
        const button = all(h.render()).find(n => n.props.className === "vc-stx-reminder-open");
        expect(button.props).toMatchObject({ type: "button", disabled: true, "aria-busy": true, "aria-label": "Открыть назначенный тикет · Россия Онлайн" });
        expect(open).toHaveBeenCalledOnce();
        finish(true); await pending;
        expect(h.items()).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });
    it("dismissal invalidates a pending click before its callback can navigate", async () => {
        const h = notices();
        let finish!: () => void;
        const navigate = vi.fn();
        const open = vi.fn(async (current: () => boolean) => {
            await new Promise<void>(resolve => { finish = resolve; });
            if (!current()) return false;
            navigate(); return true;
        });
        h.showReminderNotification("majestic", { valid: () => true, open });
        const id = h.items()[0].id, pending = h.activateReminderNotification(id);
        all(h.render()).find(n => n.props.className === "vc-stx-reminder-dismiss").props.onClick();
        finish(); await pending;
        expect(navigate).not.toHaveBeenCalled();
        expect(h.items()).toEqual([]);
    });
    it("bounds cards/timers and expires stale callbacks, logout state and previews", async () => {
        const h = notices(); let valid = true;
        h.showReminderNotification("majestic", { valid: () => valid, open: vi.fn() });
        const id = h.items()[0].id;
        for (let i = 0; i < 6; i++) h.showReminderNotification(i % 2 ? "majestic" : "russia-online");
        expect(h.items()).toHaveLength(3);
        expect(h.items().some((row: any) => row.id === id)).toBe(false);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(45000);
        expect(h.items()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
        h.showReminderNotification("majestic", { valid: () => valid });
        valid = false; await vi.advanceTimersByTimeAsync(1000);
        expect(h.items()).toEqual([]);
        h.showReminderNotification("majestic"); h.clearReminderNotifications();
        expect(h.render()).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    });
    it("renders only generic errors and never host exception details", async () => {
        const h = notices();
        h.showReminderNotification("majestic", { valid: () => true, open: async () => { throw Error("secret-token /home/private"); } });
        await h.activateReminderNotification(h.items()[0].id);
        expect(text(h.render())).toContain("Тикет недоступен. Повторите проверку.");
        expect(text(h.render())).not.toContain("secret");
        expect(h.items()[0].busy).toBe(false);
    });
});

describe("A29 exact-channel host navigation", () => {
    function navigation() {
        const channel: any = { id: target.channelId, guild_id: target.guildId };
        const common = { ChannelStore: { getChannel: vi.fn(() => channel) }, PermissionStore: { can: vi.fn(() => true) },
            NavigationRouter: { transitionTo: vi.fn() } };
        const { openReminderChannel } = load(navigationCode, { "@webpack/common": common, "./core/reminderDestination": { reminderDestination } });
        return { channel, common, openReminderChannel };
    }
    it("navigates through the host router only after matching guild/channel and view permission", () => {
        const h = navigation();
        expect(h.openReminderChannel(target, () => true)).toBe(true);
        expect(h.common.PermissionStore.can).toHaveBeenCalledExactlyOnceWith(1024n, h.channel);
        expect(h.common.NavigationRouter.transitionTo).toHaveBeenCalledExactlyOnceWith(`/channels/${target.guildId}/${target.channelId}`);
    });
    it.each(["missing channel", "wrong channel", "wrong guild", "denied", "unavailable", "stale"] as const)("fails closed for %s", reason => {
        const h = navigation();
        if (reason === "missing channel") h.common.ChannelStore.getChannel.mockReturnValue(null);
        if (reason === "wrong channel") h.channel.id = "423456789012345678";
        if (reason === "wrong guild") h.channel.guild_id = "1089530150540034181";
        if (reason === "denied") h.common.PermissionStore.can.mockReturnValue(false);
        if (reason === "unavailable") h.common.PermissionStore.can.mockImplementation(() => { throw Error("missing capability"); });
        expect(h.openReminderChannel(target, () => reason !== "stale")).toBe(false);
        expect(h.common.NavigationRouter.transitionTo).not.toHaveBeenCalled();
    });
    it.each([null, "42", "../channel", "18446744073709551616"])("never guesses a channel from the opaque ticketId (%s)", channelId => {
        expect(reminderDestination({ ...target, channelId })).toBeNull();
    });
    it("BD resolves the mangled router lazily and fails safely when absent", () => {
        const routed = vi.fn();
        function router(path: string) { routed(path); return "transitionTo - Transitioning to"; }
        const webpack = { getModule: vi.fn((filter: (value: unknown) => boolean) => filter(router) ? router : undefined) };
        const resolvers: Record<string, () => any> = {};
        const exports = load(commonCode, { "./host": { api: () => ({ React: {}, Webpack: webpack }), byKeys() {},
            hostStore: (name: string) => ({ name }), lazy: (resolve: () => any, label: string) => { resolvers[label] = resolve; return {}; } } });
        expect(webpack.getModule).not.toHaveBeenCalled();
        expect(exports.PermissionStore.name).toBe("PermissionStore");
        resolvers.NavigationRouter().transitionTo("/channels/known");
        expect(routed).toHaveBeenCalledExactlyOnceWith("/channels/known");
        webpack.getModule.mockReturnValue(undefined);
        expect(resolvers.NavigationRouter()).toBeUndefined();
    });
});
