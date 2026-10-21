/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { diagnosticJournal } from "../core/diagnosticJournal";
import { ReminderProject } from "../core/panelReminders";
import { createObservable } from "./observable";

export interface Notice {
    id: number;
    project: ReminderProject;
    test: boolean;
    clickable: boolean;
    busy: boolean;
    error: string;
    ticketLabel: string;
    waitingMinutes: number | null;
    /** Estimated wait start on this process's monotonic clock, not a UTC timestamp. Lower means older. */
    waitingOrder: number | null;
}
interface Action {
    project: ReminderProject; key?: string; expires: number; created: number; waitingMs: number | null;
    test: boolean; shown?: boolean; closedReason?: CloseReason;
    valid(): boolean; open?: (current: () => boolean) => Promise<boolean>;
}
type CloseReason = "manual" | "success" | "expired" | "invalidated" | "overflow" | "clear" | "replaced";
const TTL = 45000;
export const reminderNotifications = createObservable({ items: [] as Notice[], expanded: {} as Partial<Record<ReminderProject, boolean>> });
const actions = new Map<number, Action>();
const interactions = new Map<ReminderProject, { pointer: boolean; focus: boolean }>();
const interacting = (project: ReminderProject) => {
    const state = interactions.get(project);
    return !!(state?.pointer || state?.focus);
};
let sequence = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
function invalidReason(id: number): "expired" | "invalidated" | undefined {
    try {
        const action = actions.get(id);
        if (!action) return "invalidated";
        if (!interacting(action.project) && !(performance.now() < action.expires)) return "expired";
        if (!action.valid() || actions.get(id) !== action) return "invalidated";
    } catch { return "invalidated"; }
}
const alive = (id: number) => invalidReason(id) === undefined;
function traceNotice(event: "show" | "close" | "navigate", id: number, action: Action,
    data: Record<string, unknown> = {}, since = action.created) {
    try {
        diagnosticJournal.record(`ui.notification_${event}`, {
            project: action.project, ticketId: action.key, noticeId: id, test: action.test,
            groupCount: reminderNotifications.get().items.filter(item => item.project === action.project).length,
            durationMs: Math.max(0, performance.now() - since), ...data,
        });
    } catch { /* Diagnostics must never affect delivery, navigation or cleanup. */ }
}
function traceGroup(event: "expand" | "collapse", project: ReminderProject, items: Notice[], reason: "manual" | "group_reduced") {
    try {
        const rows = items.filter(item => item.project === project);
        diagnosticJournal.record(`ui.notification_${event}`, {
            project, groupCount: rows.length, testCount: rows.filter(item => item.test).length,
            test: rows.every(item => item.test), noticeId: rows[0]?.id, reason,
        });
    } catch { /* Group telemetry is observational too. */ }
}
function remove(id: number, reason: CloseReason) {
    const action = actions.get(id);
    if (!action) return;
    actions.delete(id);
    action.closedReason = reason;
    if (action.shown) traceNotice("close", id, action, { reason });
}
function minutesWaiting(action: Action, now = performance.now()): number | null {
    if (action.waitingMs === null) return null;
    const elapsed = Number.isFinite(now) ? Math.max(0, now - action.created) : 0;
    return Math.floor(Math.min(Number.MAX_SAFE_INTEGER, action.waitingMs + elapsed) / 60000);
}
function schedule() {
    clearTimeout(timer); timer = undefined;
    if (!actions.size) return;
    timer = setTimeout(() => {
        timer = undefined;
        for (const id of [...actions.keys()]) {
            const reason = invalidReason(id);
            if (reason) dismissReminderNotification(id, reason);
        }
        const now = performance.now();
        let changed = false;
        const items = reminderNotifications.get().items.map(item => {
            const action = actions.get(item.id);
            const waitingMinutes = action ? minutesWaiting(action, now) : item.waitingMinutes;
            if (waitingMinutes === item.waitingMinutes) return item;
            changed = true;
            return { ...item, waitingMinutes };
        });
        if (changed) reminderNotifications.set({ items });
        schedule();
    }, 1000);
}
function publish(items: Notice[]) {
    const expanded = { ...reminderNotifications.get().expanded };
    for (const project of ["majestic", "russia-online"] as const) {
        const count = items.filter(item => item.project === project).length;
        if (count <= 1) {
            if (count === 1 && expanded[project]) traceGroup("collapse", project, items, "group_reduced");
            delete expanded[project];
        }
        if (count === 0) interactions.delete(project);
    }
    reminderNotifications.set({ items, expanded });
    if (!actions.size) { clearTimeout(timer); timer = undefined; }
}
export function dismissReminderNotification(id: number, reason: CloseReason = "manual") {
    remove(id, reason);
    publish(reminderNotifications.get().items.filter(item => item.id !== id));
}
export function dismissReminderNotificationGroup(project: ReminderProject) {
    for (const [id, action] of actions) if (action.project === project) remove(id, "manual");
    publish(reminderNotifications.get().items.filter(item => item.project !== project));
}
export function toggleReminderNotificationGroup(project: ReminderProject) {
    const state = reminderNotifications.get();
    if (state.items.filter(item => item.project === project).length <= 1) return;
    reminderNotifications.set({ expanded: { ...state.expanded, [project]: !state.expanded[project] } });
    traceGroup(state.expanded[project] ? "collapse" : "expand", project, state.items, "manual");
}
export function setReminderNotificationInteraction(project: ReminderProject, source: "pointer" | "focus", active: boolean) {
    if (source !== "pointer" && source !== "focus") return;
    // Entering an already-expired group must not revive it; validity still runs while paused.
    for (const [id, action] of [...actions]) if (action.project === project) {
        const reason = invalidReason(id);
        if (reason) dismissReminderNotification(id, reason);
    }
    if (!reminderNotifications.get().items.some(item => item.project === project)) return;
    const wasActive = interacting(project);
    const state = interactions.get(project) ?? { pointer: false, focus: false };
    state[source] = active;
    interactions.set(project, state);
    if (wasActive && !interacting(project)) {
        for (const action of actions.values()) if (action.project === project) action.expires = performance.now() + TTL;
    }
}
export function clearReminderNotifications() {
    clearTimeout(timer); timer = undefined;
    for (const id of actions.keys()) remove(id, "clear");
    interactions.clear();
    reminderNotifications.set({ items: [], expanded: {} });
}

/** Fifty transient notices at most; private keys/actions never enter observable UI state. */
export function showReminderNotification(project: ReminderProject, options?: {
    valid(): boolean;
    test?: true;
    ticket?: { key: string; label: string; waitingMs?: number };
    open?: (current: () => boolean) => Promise<boolean>;
}) {
    if (project !== "majestic" && project !== "russia-online") return;
    const ticket = options?.ticket;
    const key = typeof ticket?.key === "string" && ticket.key.length > 0 && ticket.key.length <= 512 ? ticket.key : undefined;
    const replaced = new Set<number>();
    if (key !== undefined) for (const [id, action] of actions) {
        if (action.project === project && action.key === key) { remove(id, "replaced"); replaced.add(id); }
    }
    const id = ++sequence;
    const created = performance.now();
    const waitingMs = typeof ticket?.waitingMs === "number" && Number.isFinite(ticket.waitingMs)
        && ticket.waitingMs >= 0 && ticket.waitingMs <= Number.MAX_SAFE_INTEGER ? ticket.waitingMs : null;
    const action: Action = { project, key, created, waitingMs, test: !options || options.test === true,
        expires: created + TTL, valid: options?.valid ?? (() => true), open: options?.open };
    actions.set(id, action);
    if (!alive(id)) {
        actions.delete(id);
        publish(reminderNotifications.get().items.filter(item => !replaced.has(item.id)));
        return;
    }
    // Validity callbacks may clear notices during controller invalidation.
    if (!actions.has(id)) return;
    const ticketLabel = typeof ticket?.label === "string"
        ? ticket.label.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 80) || "Тикет" : "Тикет";
    const waitingMinutes = minutesWaiting(action);
    const waitingOrder = waitingMs === null ? null : created - waitingMs;
    const items = [...reminderNotifications.get().items.filter(item => !replaced.has(item.id)), {
        id, project, test: action.test, clickable: !!options?.open, busy: false, error: "", ticketLabel, waitingMinutes, waitingOrder,
    }].slice(-50);
    const keep = new Set(items.map(item => item.id));
    for (const key of actions.keys()) if (!keep.has(key)) remove(key, "overflow");
    action.shown = true;
    publish(items);
    traceNotice("show", id, action, { ...(replaced.size ? { previousNoticeId: [...replaced][0], reason: "replaced" } : {}) });
    schedule();
}

export async function activateReminderNotification(id: number) {
    const item = reminderNotifications.get().items.find(row => row.id === id), action = actions.get(id);
    if (!item || !action?.open || item.busy) return;
    let cancelled: CloseReason | undefined;
    const current = () => {
        if (cancelled !== undefined) return false;
        const reason = actions.get(id) === action ? invalidReason(id) : "invalidated";
        if (reason) cancelled ??= action.closedReason ?? reason;
        return cancelled === undefined;
    };
    const started = performance.now();
    traceNotice("navigate", id, action, { phase: "request" }, started);
    if (!current()) {
        traceNotice("navigate", id, action, { phase: "complete", outcome: "cancelled", reason: cancelled }, started);
        dismissReminderNotification(id, cancelled);
        return;
    }
    const patch = (values: Partial<Notice>) => reminderNotifications.set({
        items: reminderNotifications.get().items.map(row => row.id === id ? { ...row, ...values } : row),
    });
    patch({ busy: true, error: "" });
    let opened = false, failed = false;
    try { opened = await action.open(current); } catch { failed = true; /* Never record host/API details. */ }
    const live = current();
    // A guard that failed inside the callback cannot later become a successful navigation.
    const outcome = !live || cancelled ? "cancelled" : opened ? "success" : "failure";
    traceNotice("navigate", id, action, { phase: "complete", outcome,
        reason: outcome === "cancelled" ? cancelled : opened ? "success" : failed ? "callback_failed" : "navigation_failed" }, started);
    if (!live || opened) dismissReminderNotification(id, outcome === "cancelled" ? cancelled : "success");
    else patch({ busy: false, error: item.test ? "Тестовый тикет недоступен. Проверьте доступ к каналу." : "Тикет недоступен. Повторите проверку." });
}
