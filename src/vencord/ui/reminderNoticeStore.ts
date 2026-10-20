/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { ReminderProject } from "../core/panelReminders";
import { createObservable } from "./observable";

interface Notice {
    id: number;
    project: ReminderProject;
    test: boolean;
    clickable: boolean;
    busy: boolean;
    error: string;
}
interface Action { expires: number; valid(): boolean; open?: (current: () => boolean) => Promise<boolean>; }
export const reminderNotifications = createObservable({ items: [] as Notice[] });
const actions = new Map<number, Action>();
let sequence = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const alive = (id: number) => {
    try {
        const action = actions.get(id);
        return !!action && performance.now() < action.expires && action.valid();
    } catch { return false; }
};
function schedule() {
    clearTimeout(timer); timer = undefined;
    if (!actions.size) return;
    timer = setTimeout(() => {
        timer = undefined;
        for (const id of [...actions.keys()]) if (!alive(id)) dismissReminderNotification(id);
        schedule();
    }, 1000);
}
export function dismissReminderNotification(id: number) {
    actions.delete(id);
    reminderNotifications.set({ items: reminderNotifications.get().items.filter(item => item.id !== id) });
    if (!actions.size) { clearTimeout(timer); timer = undefined; }
}
export function clearReminderNotifications() {
    clearTimeout(timer); timer = undefined; actions.clear();
    reminderNotifications.set({ items: [] });
}

/** Three transient cards at most; preview has no navigation closure or delivery side effects. */
export function showReminderNotification(project: ReminderProject, options?: {
    valid(): boolean;
    open?: (current: () => boolean) => Promise<boolean>;
}) {
    if (project !== "majestic" && project !== "russia-online") return;
    const id = ++sequence;
    actions.set(id, { expires: performance.now() + 45000, valid: options?.valid ?? (() => true), open: options?.open });
    if (!alive(id)) { actions.delete(id); return; }
    // Validity callbacks may clear notices during controller invalidation.
    if (!actions.has(id)) return;
    const items = [...reminderNotifications.get().items, { id, project, test: !options, clickable: !!options?.open, busy: false, error: "" }].slice(-3);
    const keep = new Set(items.map(item => item.id));
    for (const key of actions.keys()) if (!keep.has(key)) actions.delete(key);
    reminderNotifications.set({ items });
    schedule();
}

export async function activateReminderNotification(id: number) {
    const item = reminderNotifications.get().items.find(row => row.id === id), action = actions.get(id);
    if (!item || !action?.open || item.test || item.busy) return;
    const current = () => actions.get(id) === action && alive(id);
    if (!current()) { dismissReminderNotification(id); return; }
    const patch = (values: Partial<Notice>) => reminderNotifications.set({
        items: reminderNotifications.get().items.map(row => row.id === id ? { ...row, ...values } : row),
    });
    patch({ busy: true, error: "" });
    let opened = false;
    try { opened = await action.open(current); } catch { /* Generic UI error, never host/API details. */ }
    if (!current() || opened) dismissReminderNotification(id);
    else patch({ busy: false, error: "Тикет недоступен. Повторите проверку." });
}
