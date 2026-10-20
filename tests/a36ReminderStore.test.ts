import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";

const code = ts.transpileModule(readFileSync("src/vencord/ui/reminderNoticeStore.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function harness() {
    vi.useFakeTimers();
    const exports: any = {};
    const updates = vi.fn();
    runInNewContext(code, { exports, performance, setTimeout, clearTimeout, require: (id: string) => {
        if (id === "../core/diagnosticJournal") return { diagnosticJournal: { record() {} } };
        if (id !== "./observable") throw Error(`Unexpected dependency ${id}`);
        return { createObservable: (value: any) => ({ get: () => value, set: (patch: any) => { updates(patch); value = { ...value, ...patch }; } }) };
    } });
    const state = () => exports.reminderNotifications.get();
    const show = (key: string, project = "majestic", extra: object = {}) => {
        exports.showReminderNotification(project, { valid: () => true, ticket: { key, label: `#${key}`, waitingMs: 125000 }, ...extra });
        return state().items.at(-1)?.id;
    };
    return { ...exports, state, show, updates };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("keeps fifty flat notices with private keys and bounded display metadata", async () => {
    const h = harness(), open = vi.fn(async () => true);
    const old = h.show("opaque-private-key", "majestic", { open });
    for (let i = 0; i < 50; i++) h.show(String(i), i % 2 ? "majestic" : "russia-online");
    expect(h.state().items).toHaveLength(50);
    expect(h.state().items[0]).toMatchObject({ ticketLabel: "#0", waitingMinutes: 2 });
    expect(JSON.stringify(h.state())).not.toContain("opaque-private-key");
    expect(h.state().items.some((item: any) => "key" in item || "open" in item)).toBe(false);
    await h.activateReminderNotification(old);
    expect(open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
});

it("replaces a same-project ticket and invalidates its pending callback without touching another project", async () => {
    const h = harness(), navigate = vi.fn(), latest = vi.fn(async () => true);
    let finish!: () => void;
    const old = h.show("42", "majestic", { open: async (current: () => boolean) => {
        await new Promise<void>(resolve => { finish = resolve; });
        if (!current()) return false;
        navigate(); return true;
    } });
    const companion = h.show("43");
    h.toggleReminderNotificationGroup("majestic");
    const pending = h.activateReminderNotification(old);
    const other = h.show("42", "russia-online");
    const replacement = h.show("42", "majestic", { open: latest });
    expect(replacement).not.toBe(old);
    expect(h.state().items.map((item: any) => item.id)).toEqual([companion, other, replacement]);
    expect(h.state().expanded).toEqual({ majestic: true });
    finish(); await pending;
    expect(navigate).not.toHaveBeenCalled();
    expect(h.state().items.map((item: any) => item.id)).toEqual([companion, other, replacement]);
    await h.activateReminderNotification(replacement);
    expect(latest).toHaveBeenCalledOnce();
    expect(h.state().expanded).toEqual({});
});

it("does not retain the older action when its replacement is invalid", async () => {
    const h = harness(), open = vi.fn(async () => true);
    const id = h.show("42", "majestic", { open });
    h.show("42", "majestic", { valid: () => false });
    expect(h.state().items).toEqual([]);
    await h.activateReminderNotification(id);
    expect(open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
});

it("toggles groups independently and resets only the reduced group", () => {
    const h = harness(); h.show("1"); h.show("2"); h.show("1", "russia-online"); h.show("2", "russia-online");
    h.toggleReminderNotificationGroup("majestic"); h.toggleReminderNotificationGroup("russia-online");
    expect(h.state().expanded).toEqual({ majestic: true, "russia-online": true });
    h.toggleReminderNotificationGroup("majestic");
    expect(h.state().expanded).toEqual({ majestic: false, "russia-online": true });
    h.dismissReminderNotificationGroup("majestic");
    expect(h.state().expanded).toEqual({ "russia-online": true });
    h.show("3");
    expect(h.state().expanded.majestic).toBeUndefined();
    h.clearReminderNotifications();
    h.toggleReminderNotificationGroup("majestic");
    expect(h.state()).toEqual({ items: [], expanded: {} });
    expect(vi.getTimerCount()).toBe(0);
});

it("collapses 2-to-1-to-2 without losing pointer or focus interaction on the remaining ticket", async () => {
    const h = harness(); h.show("1"); const second = h.show("2");
    h.toggleReminderNotificationGroup("majestic");
    h.setReminderNotificationInteraction("majestic", "pointer", true);
    h.setReminderNotificationInteraction("majestic", "focus", true);
    h.dismissReminderNotification(second);
    expect(h.state().expanded).toEqual({});
    h.toggleReminderNotificationGroup("majestic");
    expect(h.state().expanded).toEqual({});
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.state().items).toHaveLength(1);
    h.setReminderNotificationInteraction("majestic", "pointer", false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.state().items).toHaveLength(1);
    h.show("3");
    expect(h.state().items).toHaveLength(2);
    expect(h.state().expanded).toEqual({});
    h.setReminderNotificationInteraction("majestic", "focus", false);
    await vi.advanceTimersByTimeAsync(45000);
    expect(h.state().items).toEqual([]);
});

it("advances waiting minutes while held using monotonic time and publishes only minute changes", async () => {
    const h = harness(); h.show("1");
    h.setReminderNotificationInteraction("majestic", "pointer", true);
    h.updates.mockClear();
    vi.setSystemTime(new Date("2099-01-01"));
    await vi.advanceTimersByTimeAsync(54000);
    expect(h.state().items[0].waitingMinutes).toBe(2);
    expect(h.updates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.state().items[0].waitingMinutes).toBe(3);
    expect(h.updates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120000);
    expect(h.state().items[0].waitingMinutes).toBe(5);
    expect(h.updates).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(h.state())).not.toMatch(/waitingMs|created/);
    h.show("1", "majestic", { ticket: { key: "1", label: "#1", waitingMs: 0 } });
    expect(h.state().items[0].waitingMinutes).toBe(0);
    h.updates.mockClear();
    await vi.advanceTimersByTimeAsync(59000);
    expect(h.updates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.state().items[0].waitingMinutes).toBe(1);
    expect(h.updates).toHaveBeenCalledTimes(1);
});

it("keeps precise ordering stable across minute ties and UTC changes", async () => {
    const h = harness();
    const younger = h.show("125", "majestic", { ticket: { key: "125", label: "#125", waitingMs: 125000 } });
    const older = h.show("170", "majestic", { ticket: { key: "170", label: "#170", waitingMs: 170000 } });
    h.show("unknown", "majestic", { ticket: { key: "unknown", label: "Тикет" } });
    h.setReminderNotificationInteraction("majestic", "pointer", true);
    const sorted = () => [...h.state().items].sort((a, b) =>
        a.waitingOrder === null ? b.waitingOrder === null ? a.id - b.id : 1
            : b.waitingOrder === null ? -1 : a.waitingOrder - b.waitingOrder || a.id - b.id);
    const order = h.state().items.map((item: any) => item.waitingOrder);
    expect(order).toEqual([-125000, -170000, null]);
    expect(h.state().items.map((item: any) => item.waitingMinutes)).toEqual([2, 2, null]);
    expect(sorted().map(item => item.id).slice(0, 2)).toEqual([older, younger]);
    vi.setSystemTime(new Date("2099-01-01"));
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.state().items.map((item: any) => item.waitingMinutes)).toEqual([2, 3, null]);
    expect(h.state().items.map((item: any) => item.waitingOrder)).toEqual(order);
    expect(sorted().map(item => item.id).slice(0, 2)).toEqual([older, younger]);
    vi.setSystemTime(new Date("1990-01-01"));
    await vi.advanceTimersByTimeAsync(45000);
    expect(h.state().items.map((item: any) => item.waitingMinutes)).toEqual([3, 3, null]);
    expect(h.state().items.map((item: any) => item.waitingOrder)).toEqual(order);
    expect(sorted().map(item => item.id).slice(0, 2)).toEqual([older, younger]);
    const sameAge = h.show("same-start", "majestic", { ticket: { key: "same-start", label: "Тикет", waitingMs: 180000 } });
    expect(h.state().items.at(-1).waitingOrder).toBe(order[0]);
    expect(sorted().map(item => item.id).slice(0, 3)).toEqual([older, younger, sameAge]);
    expect(sorted().at(-1).waitingOrder).toBeNull();
});

it("keeps an unknown wait unknown while held without periodic UI writes", async () => {
    const h = harness(); h.show("1", "majestic", { ticket: { key: "1", label: "Тикет" } });
    h.setReminderNotificationInteraction("majestic", "focus", true);
    h.updates.mockClear();
    await vi.advanceTimersByTimeAsync(180000);
    expect(h.state().items[0].waitingMinutes).toBeNull();
    expect(h.state().items[0].waitingOrder).toBeNull();
    expect(h.updates).not.toHaveBeenCalled();
});

it("pauses only the interacted group until both pointer and focus leave, then grants 45 seconds", async () => {
    const h = harness(); h.show("1"); h.show("2", "russia-online");
    await vi.advanceTimersByTimeAsync(44000);
    h.setReminderNotificationInteraction("majestic", "pointer", true);
    h.setReminderNotificationInteraction("majestic", "focus", true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.state().items.map((item: any) => item.project)).toEqual(["majestic"]);
    h.setReminderNotificationInteraction("majestic", "pointer", false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.state().items).toHaveLength(1);
    h.setReminderNotificationInteraction("majestic", "focus", false);
    await vi.advanceTimersByTimeAsync(44000);
    h.setReminderNotificationInteraction("majestic", "focus", false); // Repeated leave cannot extend TTL.
    expect(h.state().items).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.state().items).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
});

it.each(["invalid", "throws"])("keeps validation active during hover: %s", async mode => {
    const h = harness(); let valid = true;
    h.show("1", "majestic", { valid: () => { if (!valid && mode === "throws") throw Error("revoked"); return valid; } });
    h.toggleReminderNotificationGroup("majestic");
    h.setReminderNotificationInteraction("majestic", "pointer", true);
    valid = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.state()).toEqual({ items: [], expanded: {} });
    h.show("2");
    await vi.advanceTimersByTimeAsync(45000);
    expect(h.state().items).toEqual([]); // Previous hover state was removed.
});

it("does not revive expired notices when interaction starts before the next timer tick", () => {
    const h = harness(); h.show("1");
    vi.spyOn(performance, "now").mockReturnValue(45001);
    h.setReminderNotificationInteraction("majestic", "pointer", true);
    expect(h.state().items).toEqual([]);
    vi.restoreAllMocks();
});

it("group dismissal cancels pending navigation and preserves the other group", async () => {
    const h = harness(), navigate = vi.fn(); let finish!: () => void;
    const id = h.show("1", "majestic", { open: async (current: () => boolean) => {
        await new Promise<void>(resolve => { finish = resolve; });
        if (current()) navigate(); return current();
    } });
    h.show("2", "russia-online");
    const pending = h.activateReminderNotification(id);
    h.dismissReminderNotificationGroup("majestic"); finish(); await pending;
    expect(navigate).not.toHaveBeenCalled();
    expect(h.state().items.map((item: any) => item.project)).toEqual(["russia-online"]);
});

it.each([undefined, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("uses unknown waiting time for %s and sanitizes labels", waitingMs => {
    const h = harness(); h.show("1", "majestic", { ticket: { key: "private", label: "\u202e\n" + "x".repeat(120), waitingMs } });
    expect(h.state().items[0]).toMatchObject({ ticketLabel: "x".repeat(80), waitingMinutes: null });
    expect(JSON.stringify(h.state())).not.toContain("private");
});

it("contains reentrant validity cleanup without resurrecting a notice", () => {
    const h = harness(); h.show("1");
    h.show("2", "majestic", { valid: () => { h.clearReminderNotifications(); return true; } });
    expect(h.state()).toEqual({ items: [], expanded: {} });
    expect(vi.getTimerCount()).toBe(0);
});
