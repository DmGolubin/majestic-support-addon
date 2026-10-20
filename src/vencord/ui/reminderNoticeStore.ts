/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
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
    valid(): boolean; open?: (current: () => boolean) => Promise<boolean>;
}
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
const alive = (id: number) => {
    try {
        const action = actions.get(id);
        return !!action && (interacting(action.project) || performance.now() < action.expires) && action.valid()
            && actions.get(id) === action;
    } catch { return false; }
};
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
        for (const id of [...actions.keys()]) if (!alive(id)) dismissReminderNotification(id);
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
        if (count <= 1) delete expanded[project];
        if (count === 0) interactions.delete(project);
    }
    reminderNotifications.set({ items, expanded });
    if (!actions.size) { clearTimeout(timer); timer = undefined; }
}
export function dismissReminderNotification(id: number) {
    actions.delete(id);
    publish(reminderNotifications.get().items.filter(item => item.id !== id));
}
export function dismissReminderNotificationGroup(project: ReminderProject) {
    for (const [id, action] of actions) if (action.project === project) actions.delete(id);
    publish(reminderNotifications.get().items.filter(item => item.project !== project));
}
export function toggleReminderNotificationGroup(project: ReminderProject) {
    const state = reminderNotifications.get();
    if (state.items.filter(item => item.project === project).length <= 1) return;
    reminderNotifications.set({ expanded: { ...state.expanded, [project]: !state.expanded[project] } });
}
export function setReminderNotificationInteraction(project: ReminderProject, source: "pointer" | "focus", active: boolean) {
    if (source !== "pointer" && source !== "focus") return;
    // Entering an already-expired group must not revive it; validity still runs while paused.
    for (const [id, action] of [...actions]) if (action.project === project && !alive(id)) dismissReminderNotification(id);
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
    clearTimeout(timer); timer = undefined; actions.clear(); interactions.clear();
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
        if (action.project === project && action.key === key) { actions.delete(id); replaced.add(id); }
    }
    const id = ++sequence;
    const created = performance.now();
    const waitingMs = typeof ticket?.waitingMs === "number" && Number.isFinite(ticket.waitingMs)
        && ticket.waitingMs >= 0 && ticket.waitingMs <= Number.MAX_SAFE_INTEGER ? ticket.waitingMs : null;
    const action: Action = { project, key, created, waitingMs, expires: created + TTL, valid: options?.valid ?? (() => true), open: options?.open };
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
        id, project, test: !options || options.test === true, clickable: !!options?.open, busy: false, error: "", ticketLabel, waitingMinutes, waitingOrder,
    }].slice(-50);
    const keep = new Set(items.map(item => item.id));
    for (const key of actions.keys()) if (!keep.has(key)) actions.delete(key);
    publish(items);
    schedule();
}

export async function activateReminderNotification(id: number) {
    const item = reminderNotifications.get().items.find(row => row.id === id), action = actions.get(id);
    if (!item || !action?.open || item.busy) return;
    const current = () => actions.get(id) === action && alive(id);
    if (!current()) { dismissReminderNotification(id); return; }
    const patch = (values: Partial<Notice>) => reminderNotifications.set({
        items: reminderNotifications.get().items.map(row => row.id === id ? { ...row, ...values } : row),
    });
    patch({ busy: true, error: "" });
    let opened = false;
    try { opened = await action.open(current); } catch { /* Generic UI error, never host/API details. */ }
    if (!current() || opened) dismissReminderNotification(id);
    else patch({ busy: false, error: item.test ? "Тестовый тикет недоступен. Проверьте доступ к каналу." : "Тикет недоступен. Повторите проверку." });
}
