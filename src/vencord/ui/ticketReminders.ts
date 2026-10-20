/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PanelClient, PanelError } from "../core/panelClient";
import { createReminderController, parseNotificationSettings } from "../core/panelReminders";
import { storage, toast } from "../platform";
import { createObservable } from "./observable";
import { playTicketReminder, prepareTicketSound, stopTicketReminderSound } from "./ticketSound";

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
        current: () => current(next, own) && next.client.connectionId ? {
            accountId: next.accountId, projects: next.projects, sessionId: next.client.connectionId,
            permissionsRevision: next.permissionsRevision,
            enabled: ticketRemindersState.get().phase === "ready" && !ticketRemindersState.get().busy
                && ticketRemindersState.get().settings?.discordEnabled === true,
        } : null,
        play: async (valid: () => boolean) => {
            if (!current(next, own)) return false;
            const canPlay = () => valid() && current(next, own) && ticketRemindersState.get().phase === "ready"
                && !ticketRemindersState.get().busy && ticketRemindersState.get().settings?.discordEnabled === true;
            if (!canPlay()) return false;
            const played = await playTicketReminder(canPlay);
            if (played && canPlay()) {
                try { toast("Игрок ждёт ответа в назначенном вам тикете", "message"); } catch { /* A host toast must not invalidate successful playback. */ }
            }
            return played;
        },
        onState: state => {
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
    const b = binding, own = revision, state = ticketRemindersState.get();
    if (!b || !current(b, own) || state.phase !== "ready" || !state.settings || state.busy) return;
    // Unlock while the checkbox's user gesture is still on the stack, before PATCH.
    if (enabled) prepareTicketSound("reminder");
    else stopTicketReminderSound();
    settingsRevision++; settingsRead = null;
    controller?.stop();
    ticketRemindersState.set({ busy: true, error: "" });
    try {
        const raw = await b.client.mutate({ path: "/notification-settings", method: "PATCH", version: state.settings.version, body: { discordEnabled: enabled } }, () => {
            if (!current(b, own)) throw new PanelError("cancelled");
        });
        const settings = parseNotificationSettings(raw);
        if (!current(b, own)) return;
        if (settings.discordEnabled !== enabled || settings.projects.some(p => !b.projects.includes(p.project))) throw new PanelError("invalid_response");
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

export function invalidateTicketReminders(event?: string) { controller?.invalidate(event); }
