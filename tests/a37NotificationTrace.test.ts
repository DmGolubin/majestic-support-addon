import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticJournal, diagnosticData } from "../src/core/diagnosticJournal";
import { reminderDestination } from "../src/core/reminderDestination";
import { bridgeFS, payload, storageModule } from "./a22DiagnosticStorageHarness";

const compile = (file: string) => ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const storeCode = compile("src/vencord/ui/reminderNoticeStore.ts");
const adapterCode = compile("src/vencord/ui/ticketReminders.ts");
const BASE = Date.parse("2026-10-21T12:00:00Z");
const SECRET = "AUTH_SECRET_private_ticket_content";
type Event = { event: string; data: Record<string, string | number | boolean> };
type DiskTrace = { events: Event[]; text: string; select(name: string): Event["data"][] };
const roots: string[] = [], journals: DiagnosticJournal[] = [];
const observable = { createObservable: (value: any) => ({
    get: () => value, set: (patch: any) => { value = { ...value, ...patch }; },
}) };
function load(code: string, dependencies: Record<string, unknown>) {
    const exports: any = {};
    runInNewContext(code, { exports, performance, Date, setTimeout, clearTimeout, require: (id: string) => {
        if (!(id in dependencies)) throw Error(`Unexpected dependency ${id}`);
        return dependencies[id];
    } });
    return exports;
}
function fixture(distribution: "standalone" | "betterdiscord"): {
    [key: string]: any; journal: DiagnosticJournal; persisted(): Event[]; disk(): Promise<DiskTrace>;
} {
    const journal = new DiagnosticJournal();
    journals.push(journal);
    let saved = "";
    const write = vi.fn((value: string) => { saved = value; });
    journal.start({ read: () => null, write }, { continuous: true });
    journal.clear();
    const store = load(storeCode, { "./observable": observable, "../core/diagnosticJournal": { diagnosticJournal: journal } });
    const state = () => store.reminderNotifications.get();
    const show = (key: string, project = "majestic", extra: object = {}) => {
        store.showReminderNotification(project, { valid: () => true,
            ticket: { key, label: SECRET, waitingMs: 120000 }, ...extra });
        return state().items.at(-1)?.id as number;
    };
    const persisted = (): Event[] => {
        journal.flush();
        return JSON.parse(saved).events.filter((event: Event) => event.event.startsWith("ui.notification_"));
    };
    async function disk() {
        const events = persisted();
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "SupportTemplates-a37-notification-"));
        roots.push(root);
        // Standalone/Vencord's native filesystem and BD's bridged filesystem use the same sanitizer.
        const deps = { root, fs: distribution === "betterdiscord" ? bridgeFS() : fs };
        const native = storageModule.createDiagnosticFileStorage(deps);
        const result = await native.save(JSON.stringify(payload({ distribution, journal: JSON.parse(saved) })));
        const text = fs.readFileSync(result.path, "utf8");
        const lines = text.split("\n").filter(line => / ui\.notification_[a-z]+ /.test(line));
        expect(lines.map(line => JSON.parse(line.slice(line.indexOf("{"))).data)).toEqual(events.map(event => event.data));
        const reloaded = JSON.parse((await storageModule.createDiagnosticFileStorage(deps).load()).state);
        expect(reloaded.events.filter((event: Event) => event.event.startsWith("ui.notification_"))).toEqual(events);
        expect(text).not.toContain(SECRET);
        return { events, text, select: (name: string) => events.filter(event => event.event === `ui.notification_${name}`).map(event => event.data) };
    }
    return { ...store, journal, write, show, state, persisted, disk };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(BASE); });
afterEach(() => {
    vi.restoreAllMocks();
    for (const journal of journals.splice(0)) journal.stop();
    vi.clearAllTimers(); vi.useRealTimers();
    for (const root of roots.splice(0)) {
        if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())
            || !path.basename(root).startsWith("SupportTemplates-a37-notification-")) throw Error("Unexpected fixture path");
        fs.rmSync(root, { recursive: true, force: true });
    }
});

describe.each(["standalone", "betterdiscord"] as const)("A37 persisted notification traces: %s", distribution => {
    it("records each show and independent group expansion, collapse and manual close without labels", async () => {
        const h = fixture(distribution);
        const first = h.show("regional:42"), second = h.show("43", "majestic", { test: true });
        h.show("51", "russia-online", { test: true }); h.show("52", "russia-online", { test: true });
        h.toggleReminderNotificationGroup("majestic"); h.toggleReminderNotificationGroup("russia-online");
        h.toggleReminderNotificationGroup("majestic");
        await vi.advanceTimersByTimeAsync(25);
        h.dismissReminderNotificationGroup("majestic");
        h.dismissReminderNotification(first); // Repeated dismissal must not invent another close.
        expect(h.state().expanded).toEqual({ "russia-online": true });
        const log = await h.disk();
        expect(log.select("show")).toEqual([
            { project: "majestic", ticketId: "regional:42", noticeId: first, test: false, groupCount: 1, durationMs: 0 },
            { project: "majestic", ticketId: "43", noticeId: second, test: true, groupCount: 2, durationMs: 0 },
            expect.objectContaining({ project: "russia-online", groupCount: 1, test: true }),
            expect.objectContaining({ project: "russia-online", groupCount: 2, test: true }),
        ]);
        expect(log.select("expand")).toEqual([
            { project: "majestic", groupCount: 2, testCount: 1, test: false, noticeId: first, reason: "manual" },
            expect.objectContaining({ project: "russia-online", groupCount: 2, testCount: 2, test: true, reason: "manual" }),
        ]);
        expect(log.select("collapse")).toEqual([expect.objectContaining({ project: "majestic", groupCount: 2, reason: "manual" })]);
        expect(log.select("close")).toEqual([first, second].map(noticeId => expect.objectContaining({
            project: "majestic", noticeId, reason: "manual", groupCount: 2, durationMs: 25,
        })));
        expect(log.text).not.toMatch(/ticketLabel|waitingOrder|waitingMinutes|waitingMs/);
    });

    it("correlates replacements and reports automatic collapse only when an expanded group shrinks", async () => {
        const h = fixture(distribution), old = h.show("42"), companion = h.show("43");
        h.toggleReminderNotificationGroup("majestic");
        const replacement = h.show("42");
        expect(h.state().expanded.majestic).toBe(true);
        h.dismissReminderNotification(replacement);
        h.toggleReminderNotificationGroup("majestic"); // Single row is not expandable.
        h.show("43", "majestic", { valid: () => false });
        expect(h.state().items).toEqual([]);
        const log = await h.disk();
        expect(log.select("show")).toHaveLength(3);
        expect(log.select("show")[2]).toMatchObject({ noticeId: replacement, previousNoticeId: old, reason: "replaced", groupCount: 2 });
        expect(log.select("close")).toEqual([
            expect.objectContaining({ noticeId: old, reason: "replaced" }),
            expect.objectContaining({ noticeId: replacement, reason: "manual" }),
            expect.objectContaining({ noticeId: companion, reason: "replaced" }),
        ]);
        expect(log.select("collapse")).toEqual([expect.objectContaining({ noticeId: companion, groupCount: 1, reason: "group_reduced" })]);
    });

    it("bounds notices at fifty and persists overflow and clear exactly once per shown notice", async () => {
        const h = fixture(distribution), first = h.show("0");
        for (let i = 1; i <= 50; i++) h.show(String(i), i % 2 ? "majestic" : "russia-online");
        expect(h.state().items).toHaveLength(50);
        h.clearReminderNotifications(); h.clearReminderNotifications();
        const log = await h.disk(), closed = log.select("close");
        expect(log.select("show")).toHaveLength(51);
        expect(closed[0]).toMatchObject({ noticeId: first, reason: "overflow" });
        expect(closed.filter(row => row.reason === "clear")).toHaveLength(50);
        expect(new Set(closed.map(row => row.noticeId)).size).toBe(51);
    });

    it("keeps pointer, focus and waiting-minute ticks silent, then expires after the renewed TTL", async () => {
        const h = fixture(distribution), id = h.show("42");
        h.setReminderNotificationInteraction("majestic", "pointer", true);
        h.setReminderNotificationInteraction("majestic", "focus", true);
        await vi.advanceTimersByTimeAsync(60000);
        h.setReminderNotificationInteraction("majestic", "pointer", false);
        await vi.advanceTimersByTimeAsync(60000);
        expect(h.state().items[0].waitingMinutes).toBe(4);
        expect(h.persisted()).toHaveLength(1);
        h.setReminderNotificationInteraction("majestic", "focus", false);
        await vi.advanceTimersByTimeAsync(44000);
        expect(h.state().items).toHaveLength(1);
        h.setReminderNotificationInteraction("majestic", "focus", false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.state().items).toEqual([]);
        const log = await h.disk();
        expect(log.events).toHaveLength(2);
        expect(log.select("close")).toEqual([expect.objectContaining({ noticeId: id, reason: "expired", durationMs: 165000 })]);
    });

    it.each([false, true])("records invalidation during interaction even if the validity callback throws: %s", async throws => {
        const h = fixture(distribution); let valid = true;
        const id = h.show("42", "majestic", { valid: () => { if (!valid && throws) throw Error(SECRET); return valid; } });
        h.setReminderNotificationInteraction("majestic", "pointer", true);
        valid = false; await vi.advanceTimersByTimeAsync(1000);
        expect(h.state().items).toEqual([]);
        expect((await h.disk()).select("close")).toEqual([expect.objectContaining({ noticeId: id, reason: "invalidated" })]);
    });

    it("records one navigation request and success with elapsed duration and a successful close", async () => {
        const h = fixture(distribution); let finish!: (value: boolean) => void;
        const open = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
        const id = h.show("42", "majestic", { open });
        await vi.advanceTimersByTimeAsync(10);
        const pending = h.activateReminderNotification(id);
        await h.activateReminderNotification(id); // Busy clicks are inert.
        await vi.advanceTimersByTimeAsync(35);
        finish(true); await pending;
        await h.activateReminderNotification(id); // Removed callbacks are inert.
        expect(open).toHaveBeenCalledOnce();
        expect(h.state().items).toEqual([]);
        const log = await h.disk();
        expect(log.select("navigate")).toEqual([
            expect.objectContaining({ noticeId: id, ticketId: "42", phase: "request", durationMs: 0, test: false }),
            expect.objectContaining({ noticeId: id, phase: "complete", outcome: "success", reason: "success", durationMs: 35 }),
        ]);
        expect(log.select("close")).toEqual([expect.objectContaining({ noticeId: id, reason: "success", durationMs: 45 })]);
    });

    it.each(["false", "throw"])("records navigation failure (%s) without content and leaves retry behavior intact", async mode => {
        const h = fixture(distribution), open = vi.fn(async () => { if (mode === "throw") throw Error(SECRET); return false; });
        const id = h.show("42", "majestic", { open });
        await h.activateReminderNotification(id);
        expect(h.state().items[0]).toMatchObject({ id, busy: false });
        expect(h.state().items[0].error).not.toBe("");
        open.mockResolvedValue(true);
        await h.activateReminderNotification(id);
        const log = await h.disk(), attempts = log.select("navigate");
        expect(attempts).toHaveLength(4);
        expect(attempts[1]).toMatchObject({ outcome: "failure", reason: mode === "throw" ? "callback_failed" : "navigation_failed" });
        expect(attempts[3]).toMatchObject({ outcome: "success" });
        expect(log.select("close")).toHaveLength(1);
    });

    it.each(["manual", "group", "replaced", "clear", "expired", "invalidated", "overflow"])(
        "never reports success for pending navigation after %s, even if the callback resolves true", async reason => {
            const h = fixture(distribution); let finish!: () => void, valid = true;
            const navigate = vi.fn();
            const id = h.show("regional:42", "majestic", { valid: () => valid, open: async (current: () => boolean) => {
                await new Promise<void>(resolve => { finish = resolve; });
                if (current()) navigate();
                return true; // A stale/misbehaving adapter must not create diagnostic success.
            } });
            const other = h.show("other:1", "russia-online");
            const pending = h.activateReminderNotification(id);
            let replacement: number | undefined;
            if (reason === "manual") h.dismissReminderNotification(id);
            if (reason === "group") h.dismissReminderNotificationGroup("majestic");
            if (reason === "replaced") replacement = h.show("regional:42");
            if (reason === "clear") h.clearReminderNotifications();
            if (reason === "expired") await vi.advanceTimersByTimeAsync(45000);
            if (reason === "invalidated") { valid = false; await vi.advanceTimersByTimeAsync(1000); }
            if (reason === "overflow") for (let i = 0; i < 49; i++) h.show(String(i));
            finish(); await pending;
            expect(navigate).not.toHaveBeenCalled();
            if (replacement) expect(h.state().items.some((item: any) => item.id === replacement)).toBe(true);
            if (!["clear", "expired"].includes(reason)) expect(h.state().items.some((item: any) => item.id === other)).toBe(true);
            const log = await h.disk();
            expect(log.select("navigate")).toEqual([
                expect.objectContaining({ noticeId: id, phase: "request" }),
                expect.objectContaining({ noticeId: id, phase: "complete", outcome: "cancelled", reason: reason === "group" ? "manual" : reason }),
            ]);
            expect(log.select("close").filter(row => row.noticeId === id)).toEqual([
                expect.objectContaining({ reason: reason === "group" ? "manual" : reason }),
            ]);
        });

    it("cancels an invalid guard at click before calling the adapter", async () => {
        const h = fixture(distribution); let valid = true;
        const open = vi.fn(async () => true), id = h.show("42", "majestic", { open, valid: () => valid });
        valid = false;
        await h.activateReminderNotification(id);
        expect(open).not.toHaveBeenCalled();
        const log = await h.disk();
        expect(log.select("navigate")[1]).toMatchObject({ outcome: "cancelled", reason: "invalidated" });
        expect(log.select("close")[0]).toMatchObject({ reason: "invalidated" });
    });

    it.each([false, true])("remembers a failed callback guard after validity returns and the callback resolves %s", async opened => {
        const h = fixture(distribution), navigate = vi.fn(), guards: boolean[] = []; let valid = true;
        const id = h.show("42", "majestic", { valid: () => valid, open: async (current: () => boolean) => {
            valid = false; guards.push(current());
            valid = true;
            const allowed = current();
            guards.push(allowed);
            if (allowed) navigate();
            return opened;
        } });
        await h.activateReminderNotification(id);
        // Assert outside open(): the store deliberately catches callback exceptions.
        expect(guards).toEqual([false, false]);
        expect(navigate).not.toHaveBeenCalled();
        expect(h.state().items).toEqual([]);
        const log = await h.disk();
        expect(log.select("navigate")[1]).toMatchObject({ noticeId: id, outcome: "cancelled", reason: "invalidated" });
        expect(log.select("close")).toEqual([expect.objectContaining({ noticeId: id, reason: "invalidated" })]);
    });

    it("does not invent a show/close for suppressed or reentrantly cleared candidates", async () => {
        const h = fixture(distribution), id = h.show("1");
        h.show("2", "majestic", { valid: () => { h.clearReminderNotifications(); return true; } });
        h.show("3", "majestic", { valid: () => { throw Error(SECRET); } });
        h.show("4", "not-a-project");
        h.toggleReminderNotificationGroup("majestic");
        expect(h.state().items).toEqual([]);
        const log = await h.disk();
        expect(log.events.map(event => event.event)).toEqual(["ui.notification_show", "ui.notification_close"]);
        expect(log.select("close")[0]).toMatchObject({ noticeId: id, reason: "clear" });
    });

    it("hashes opaque IDs idempotently and drops secrets, labels and unallowlisted fields on disk", async () => {
        const h = fixture(distribution), key = `private opaque ${SECRET}`;
        const id = h.show(key);
        h.show(key); // The same private key must correlate through the sanitizer.
        h.journal.record("ui.notification_navigate", {
            noticeId: id, project: "majestic", ticketId: key, phase: "complete", outcome: SECRET, reason: SECRET,
            title: SECRET, ticketLabel: SECRET, message: SECRET, error: SECRET, accessToken: SECRET, accountId: SECRET,
            url: `https://private.invalid/${SECRET}`, waitingOrder: -99999, groupCount: 1, test: false,
        });
        const log = await h.disk(), hashed = diagnosticData({ ticketId: key }).ticketId;
        expect(hashed).toMatch(/^h:[0-9a-f]{16}$/);
        expect(log.events.every(event => event.data.ticketId === hashed)).toBe(true);
        for (const event of log.events) expect(diagnosticData(event.data)).toEqual(event.data);
        expect(log.select("navigate")[0]).toEqual({ noticeId: id, project: "majestic", ticketId: hashed,
            phase: "complete", outcome: "unknown", reason: "unknown", groupCount: 1, test: false });
        expect(log.text).not.toMatch(/private opaque|private\.invalid|ticketLabel|accessToken|accountId|waitingOrder/);
    });

    it("persists the actual manual sample's test flag and navigation without API, receipt or audio work", async () => {
        const h = fixture(distribution), forbidden = vi.fn(() => { throw Error("Unexpected API/audio/storage operation"); });
        const transitionTo = vi.fn();
        const adapter = load(adapterCode, {
            "@webpack/common": { NavigationRouter: { transitionTo } },
            "../core/panelClient": {}, "../core/panelReminders": { createReminderController: forbidden },
            "../core/reminderDestination": { reminderDestination }, "../platform": { storage: { get: forbidden, set: forbidden } },
            "../reminderNavigation": { openReminderChannel: forbidden }, "./observable": observable,
            "./reminderNoticeStore": h, "./ticketSound": { playTicketReminder: forbidden, reminderSoundPolicy: forbidden },
        });
        adapter.previewTicketReminderNotification("russia-online");
        const id = h.state().items[0].id;
        await h.activateReminderNotification(id);
        expect(transitionTo).toHaveBeenCalledExactlyOnceWith("/channels/1089530150540034181/1562132664499175564");
        expect(forbidden).not.toHaveBeenCalled();
        const log = await h.disk();
        expect(log.events.every(event => event.data.test === true)).toBe(true);
        expect(log.select("navigate")[1]).toMatchObject({ noticeId: id, outcome: "success" });
        expect(log.select("show")[0]).not.toHaveProperty("ticketId");
    });

    it("contains thrown telemetry and failed persistence without changing card behavior", async () => {
        const h = fixture(distribution), record = vi.spyOn(h.journal, "record").mockImplementation(() => { throw Error(SECRET); });
        const open = vi.fn(async () => true), id = h.show("42", "majestic", { open });
        h.show("43"); h.toggleReminderNotificationGroup("majestic"); h.toggleReminderNotificationGroup("majestic");
        await expect(h.activateReminderNotification(id)).resolves.toBeUndefined();
        expect(open).toHaveBeenCalledOnce();
        expect(() => h.dismissReminderNotificationGroup("majestic")).not.toThrow();
        expect(h.state().items).toEqual([]);
        record.mockRestore();
        h.write.mockImplementationOnce(() => { throw Error(SECRET); });
        h.show("44"); h.journal.flush();
        expect(h.journal.storageFailed).toBe(true);
        h.clearReminderNotifications();
        const log = await h.disk();
        expect(log.events.map(event => event.event)).toEqual(["ui.notification_show", "ui.notification_close"]);
        expect(log.select("close")[0]).toMatchObject({ reason: "clear" });
    });
});
