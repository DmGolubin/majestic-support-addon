/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavigationRouter } from "@webpack/common";

import { PanelClient, PanelError } from "../core/panelClient";
import { createReminderController, parseAssignedSnapshot, parseNotificationSettings, ReminderPlaybackTicket, ReminderProject } from "../core/panelReminders";
import { reminderDestination } from "../core/reminderDestination";
import { storage } from "../platform";
import { openReminderChannel } from "../reminderNavigation";
import { createObservable } from "./observable";
import { clearReminderNotifications, showReminderNotification } from "./reminderNoticeStore";
import { playTicketReminder, prepareTicketSound, reminderSoundPolicy, stopTicketReminderSound } from "./ticketSound";

type Settings = ReturnType<typeof parseNotificationSettings>;
type Binding = { client: PanelClient; accountId: string; projects: string[]; permissionsRevision: string; scopes: readonly string[]; current(): boolean; onAuthError(error: unknown): void; };
export const ticketRemindersState = createObservable({
    phase: "idle" as "idle" | "permission" | "loading" | "ready" | "offline",
    settings: null as Settings | null, busy: false, error: "", deliveryError: "",
});
const REQUIRED = ["tickets:assigned:read", "notifications:settings:read", "notifications:settings:write"];
let binding: Binding | null = null;
let controller: ReturnType<typeof createReminderController> | null = null;
let revision = 0;
let settingsRead: Promise<void> | null = null;
let settingsRevision = 0;
let settingsRetryAt = 0;
let settingsFailures = 0;
let navigationRetryAt = 0;

/** A fresh read only; no delivery claim/receipt or notification-settings mutation. */
async function openAssignedTicket(b: Binding, own: number, ticket: ReminderPlaybackTicket, currentNotice: () => boolean): Promise<boolean> {
    const currentBinding = () => current(b, own) && REQUIRED.every(scope => b.scopes.includes(scope))
        && b.projects.includes(ticket.project) && currentNotice();
    if (!currentBinding() || Date.now() < navigationRetryAt || !reminderDestination(ticket)) return false;
    const started = performance.now();
    // Coalesce rapid clicks across the bounded set of cards; transport Retry-After is shared.
    navigationRetryAt = Date.now() + 1000;
    try {
        const snapshot = parseAssignedSnapshot(await get(b, "/tickets/assigned"), b.accountId, b.projects);
        const elapsed = performance.now() - started;
        if (!currentBinding() || !snapshot.discordEnabled || elapsed < 0 || !Number.isFinite(elapsed)
            || snapshot.serverTime - snapshot.checkedAt + elapsed > 75000) return false;
        const assigned = snapshot.tickets.find(row => row.project === ticket.project && row.ticketId === ticket.ticketId
            && row.state === "waiting_support" && row.waitingCycleId === ticket.waitingCycleId
            && row.reminderId === ticket.reminderId && row.guildId === ticket.guildId && row.channelId === ticket.channelId);
        return !!assigned && openReminderChannel(ticket, currentBinding);
    } catch (error) {
        if (current(b, own)) {
            const retry = error instanceof PanelError ? error.retryAfterMs : undefined;
            navigationRetryAt = Date.now() + Math.max(5000, typeof retry === "number" && Number.isFinite(retry) ? retry : 0,
                error instanceof PanelError && error.status === 429 ? 60000 : 0);
        }
        return false;
    }
}

// User-supplied sample belongs to RO under the production project/guild mapping.
// It is never treated as an assigned ticket or sent to the delivery controller.
const reminderSample = { project: "russia-online", guildId: "1089530150540034181", channelId: "1562132664499175564" } as const;
function openReminderSample(currentNotice: () => boolean): boolean {
    try {
        const destination = reminderDestination(reminderSample);
        if (!destination || !currentNotice()) return false;
        // Explicit test navigation must also work for an unopened/uncached ticket.
        // Discord enforces access; production assigned-ticket navigation stays strict.
        NavigationRouter.transitionTo(`/channels/${destination.guildId}/${destination.channelId}`);
        return true;
    } catch { return false; }
}

/** Manual sample only: no controller, API, sound, receipt or history access. */
export function previewTicketReminderNotification(project: ReminderProject = "majestic"): void {
    try {
        showReminderNotification(project, { test: true, valid: () => true,
            ...(project === reminderSample.project && reminderDestination(reminderSample)
                ? { open: async (live: () => boolean) => openReminderSample(live) } : {}) });
    } catch { /* UI is observational. */ }
}

function deferSettings(error: unknown, failedRead = false) {
    const failure = error instanceof PanelError ? error : null;
    const retryAfter = failure?.retryAfterMs;
    const serverDelay = typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter : failure?.status === 429 ? 60000 : 0;
    // A write conflict/uncertain write needs an immediate confirming GET; never
    // replay the PATCH. Only a server delay or a failed read postpones that GET.
    if (!failedRead && !serverDelay) return;
    // Repeated library syncs and retry clicks share one backoff, including failures
    // without an HTTP response. A malformed settings response is not an empty record.
    settingsFailures = Math.min(settingsFailures + 1, 5);
    const delay = Math.max(serverDelay, Math.min(120000, 10000 * 2 ** (settingsFailures - 1)));
    settingsRetryAt = Math.max(settingsRetryAt, Date.now() + delay);
}

export function stopTicketReminders() {
    clearReminderNotifications();
    navigationRetryAt = 0;
    stopTicketReminderSound();
    revision++; settingsRevision++;
    settingsRetryAt = 0;
    settingsFailures = 0;
    controller?.stop(); controller = null; binding = null; settingsRead = null;
    ticketRemindersState.set({ phase: "idle", settings: null, busy: false, error: "", deliveryError: "" });
}

function current(b: Binding, own: number) { return binding === b && own === revision && b.current(); }
async function get(b: Binding, path: string) {
    try { return await b.client.get(path); }
    catch (error) {
        if (binding === b && error instanceof PanelError && (error.status === 401
            || ["session_revoked", "refresh_uncertain", "not_authenticated", "invalid_grant", "vault_error"].includes(error.code))) b.onAuthError(error);
        throw error;
    }
}

export function syncTicketReminders(next: Binding) {
    const same = binding && binding.client === next.client && binding.accountId === next.accountId
        && binding.permissionsRevision === next.permissionsRevision
        && JSON.stringify(binding.projects) === JSON.stringify(next.projects)
        && JSON.stringify(binding.scopes) === JSON.stringify(next.scopes);
    if (same) { void refreshTicketReminders(); return; }
    stopTicketReminders(); binding = next;
    if (!REQUIRED.every(scope => next.scopes.includes(scope))) {
        ticketRemindersState.set({ phase: "permission" }); return;
    }
    const own = revision;
    controller = createReminderController({
        accountId: next.accountId, projects: next.projects,
        get: () => get(next, "/tickets/assigned"), storage,
        projectSound: reminderSoundPolicy,
        current: () => current(next, own) && next.client.connectionId ? {
            accountId: next.accountId, projects: next.projects, sessionId: next.client.connectionId,
            permissionsRevision: next.permissionsRevision,
            enabled: ticketRemindersState.get().phase === "ready" && !ticketRemindersState.get().busy
                && ticketRemindersState.get().settings?.discordEnabled === true,
        } : null,
        play: async (valid, ticket) => {
            if (!current(next, own)) return false;
            const canPlay = () => valid() && current(next, own) && ticketRemindersState.get().phase === "ready"
                && !ticketRemindersState.get().busy && ticketRemindersState.get().settings?.discordEnabled === true
                && (!ticket || reminderSoundPolicy(ticket.project).enabled);
            if (!canPlay()) return false;
            const played = await playTicketReminder(canPlay, ticket);
            if (played && ticket && canPlay()) {
                // Keep the exact technical record selected by the receipt/audio gate.
                const target = { ...ticket };
                const sessionId = next.client.connectionId, accountId = next.accountId, permissions = next.permissionsRevision;
                const soundRevision = reminderSoundPolicy(target.project).revision;
                // Playback validity belongs to one snapshot. Delivered cards outlive routine
                // polling; navigation separately requires a fresh matching assignment.
                const noticeValid = () => {
                    const state = ticketRemindersState.get(), sound = reminderSoundPolicy(target.project);
                    return current(next, own) && next.client.connectionId === sessionId && next.accountId === accountId
                        && next.permissionsRevision === permissions && next.projects.includes(target.project)
                        && REQUIRED.every(scope => next.scopes.includes(scope)) && state.phase === "ready"
                        && !state.busy && state.settings?.discordEnabled === true && sound.enabled && sound.revision === soundRevision;
                };
                try {
                    showReminderNotification(target.project, { valid: noticeValid,
                        ticket: { key: target.ticketId, label: /^[0-9]{1,20}$/.test(target.ticketId) ? `#${target.ticketId}` : "Тикет",
                            ...(typeof target.waitingMs === "number" && Number.isFinite(target.waitingMs) && target.waitingMs >= 0
                                ? { waitingMs: target.waitingMs } : {}) },
                        ...(reminderDestination(target) ? { open: (live: () => boolean) => openAssignedTicket(next, own, target, live) } : {}) });
                } catch { /* Notification UI cannot undo a successful audio receipt. */ }
            }
            return played;
        },
        onState: state => {
            if (current(next, own) && (state.status === "unavailable" || state.status === "stopped")) clearReminderNotifications();
            if (current(next, own) && state.status !== "refreshing") ticketRemindersState.set({
                deliveryError: state.status === "unavailable" ? "Не удалось проверить назначенные тикеты. Напоминания приостановлены." : "",
            });
        },
    });
    void refreshTicketReminders();
}

export async function refreshTicketReminders(): Promise<void> {
    const b = binding, own = revision;
    if (!b || !current(b, own) || ticketRemindersState.get().phase === "permission" || ticketRemindersState.get().busy) return;
    if (settingsRead) return settingsRead;
    if (Date.now() < settingsRetryAt) return;
    const readRevision = ++settingsRevision;
    ticketRemindersState.set({ phase: ticketRemindersState.get().settings ? "ready" : "loading" });
    const task = (async () => {
        try {
            const settings = parseNotificationSettings(await get(b, "/notification-settings"));
            if (!current(b, own) || readRevision !== settingsRevision) return;
            if (settings.projects.some(p => !b.projects.includes(p.project))) throw new Error("Invalid projects");
            settingsFailures = 0;
            ticketRemindersState.set({ phase: "ready", settings, error: "" });
            controller?.start();
            controller?.invalidate();
        } catch (error) {
            if (!current(b, own)) return;
            deferSettings(error, true);
            if (readRevision !== settingsRevision) return;
            controller?.stop();
            ticketRemindersState.set({ phase: error instanceof PanelError && error.status === 403 ? "permission" : "offline", error: error instanceof PanelError && error.status === 403
                ? "Нет доступа к настройкам напоминаний. Подключите аккаунт заново."
                : "Не удалось загрузить настройки напоминаний. Повторите проверку." });
        }
    })();
    settingsRead = task;
    try { await task; } finally { if (settingsRead === task) settingsRead = null; }
}

export async function setDiscordReminders(enabled: boolean): Promise<void> {
    return patchReminderSettings({ discordEnabled: enabled }, settings => settings.discordEnabled === enabled, enabled);
}

export async function setDiscordReminderMinutes(project: ReminderProject, minutes: number | null): Promise<void> {
    if (project !== "majestic" && project !== "russia-online") return;
    if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 120)) return;
    return patchReminderSettings({ projects: [{ project, discordReminderMinutes: minutes }] }, settings =>
        settings.projects.some(row => row.project === project && row.discordReminderMinutes === minutes));
}

async function patchReminderSettings(body: { discordEnabled: boolean } | {
    projects: { project: ReminderProject; discordReminderMinutes: number | null; }[];
}, verify: (settings: Settings) => boolean, prepareSound = false): Promise<void> {
    const b = binding, own = revision, state = ticketRemindersState.get();
    if (!b || !current(b, own) || state.phase !== "ready" || !state.settings || state.busy) return;
    // Unlock while the checkbox's user gesture is still on the stack, before PATCH.
    if ("discordEnabled" in body) {
        if (prepareSound) prepareTicketSound("reminder");
        else stopTicketReminderSound();
    }
    clearReminderNotifications();
    settingsRevision++; settingsRead = null;
    controller?.stop();
    ticketRemindersState.set({ busy: true, error: "" });
    try {
        const raw = await b.client.mutate({ path: "/notification-settings", method: "PATCH", version: state.settings.version, body }, () => {
            if (!current(b, own)) throw new PanelError("cancelled");
        });
        const settings = parseNotificationSettings(raw);
        if (!current(b, own)) return;
        if (!verify(settings) || settings.projects.some(p => !b.projects.includes(p.project))) throw new PanelError("invalid_response");
        settingsFailures = 0;
        ticketRemindersState.set({ settings, phase: "ready", error: "" });
    } catch (error) {
        if (!current(b, own)) return;
        deferSettings(error);
        if (error instanceof PanelError && error.status === 401) { b.onAuthError(error); return; }
        ticketRemindersState.set({ phase: "offline", error: error instanceof PanelError && error.status === 412
            ? "Настройки изменились на панели. Повторите проверку и выберите нужное значение."
            : "Результат сохранения не подтверждён. Повторите проверку настроек." });
    } finally {
        if (binding === b && own === revision) {
            ticketRemindersState.set({ busy: false });
            if (current(b, own) && ticketRemindersState.get().phase === "ready") controller?.start();
        }
    }
}

export function invalidateTicketReminders(event?: string) {
    clearReminderNotifications();
    controller?.invalidate(event);
}
