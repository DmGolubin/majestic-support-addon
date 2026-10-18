/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxDispatcher, UserStore } from "@webpack/common";

import { PLUGIN_VERSION } from "../buildInfo";
import { parseProfile, parseSnapshot } from "../core/panelCatalog";
import { PanelClient, PanelError } from "../core/panelClient";
import { PANEL_ORIGIN } from "../core/panelProtocol";
import { createPanelTransport } from "../core/panelTransport";
import { Store } from "../core/state";
import { htmlToDiscordText } from "../panelHtml";
import { disableDemo, enableDemo } from "./demo";
import { confirmedForeign, supersede } from "./flow";
import { createObservable } from "./observable";
import { captureWindowTarget, nextGeneration, windowEditor } from "./op";
import { libraryIsFresh, panelAccess, realStore, selectStore, setFreshnessCheck, ui } from "./uiState";

type Phase = "idle" | "connecting" | "pending" | "loading" | "ready" | "offline" | "error";
export const panel = createObservable({ enabled: true, phase: "idle" as Phase, code: "", url: "", error: "", name: "", checkedAt: 0 });
let client: PanelClient | null = null;
let library: Store | null = null;
let epoch = 0;
let fingerprint = "";
let permissions = "";
let accountId: string | null = null;
let loading: Promise<boolean> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
let retryAt = 0;

function invalidate() {
    nextGeneration(); supersede(); confirmedForeign.clear();
    ui.set({ inline: null, menu: null, dialog: null, compose: [] });
}

function wipe() {
    epoch++; clearTimeout(timer); loading = null; fingerprint = ""; permissions = ""; accountId = null; failures = 0; retryAt = 0;
    panelAccess.set({ ready: false, accountId: null, projects: [], checkedAt: 0 });
    invalidate(); ui.set({ management: false });
    library?.replacePanelCatalog({ templates: [], personal: [], folders: [] });
    library = null;
    panel.set({ phase: "idle", code: "", url: "", error: "", name: "", checkedAt: 0 });
}

function message(error: unknown): string {
    const code = error instanceof PanelError ? error.code : "invalid_response";
    const labels: Record<string, string> = {
        plugin_disabled: "API панели пока выключен. Дождитесь включения администратором.",
        access_denied: "Вход не подтверждён. Можно попробовать снова.",
        expired_token: "Код истёк. Начните вход заново.",
        session_revoked: "Доступ отозван. Войдите снова.",
        invalid_grant: "Сессия завершена. Войдите снова.",
        reauthentication_required: "Не удалось обновить сессию. Войдите снова.",
        refresh_uncertain: "Не удалось подтвердить обновление сессии. Войдите снова.",
        request_timeout: "Панель не ответила вовремя. Попробуйте снова.",
        account_mismatch: "На панели и в Discord должны быть открыты одинаковые аккаунты.",
        upgrade_required: "Для подключения нужна новая версия плагина.",
        rate_limited: "Слишком много запросов. Повторим позже.",
        network_error: "Нет связи с панелью. Повторим подключение.",
        timeout: "Панель не ответила вовремя. Повторим подключение.",
        invalid_response: "Ответ панели не соответствует контракту. Загрузка остановлена."
    };
    return labels[code] ?? "Не удалось подключиться к панели. Попробуйте снова.";
}

function supportsVersion(minimum: string) {
    const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null;
    const current = parse(PLUGIN_VERSION), required = parse(minimum);
    if (!current || !required) return false;
    for (let i = 0; i < 3; i++) if (current[i] !== required[i]) return current[i] > required[i];
    return true;
}

function schedule(own: number, retryAfter = 0) {
    clearTimeout(timer);
    if (epoch !== own || !client) return;
    const delay = failures ? Math.max(retryAfter, Math.min(120000, 5000 * 2 ** Math.min(failures, 5)) * (0.8 + Math.random() * 0.4)) : 50000 + Math.random() * 20000;
    retryAt = failures ? Date.now() + delay : 0;
    timer = setTimeout(() => void loadLibrary(), Math.min(delay, 2147483647));
}

async function loadLibrary(): Promise<boolean> {
    if (loading) return loading;
    if (Date.now() < retryAt) return false;
    const active = client, own = epoch;
    if (!active) return false;
    const run = async () => {
        const started = Date.now();
        try {
            const profile = parseProfile(await active.get("/me"));
            if (own !== epoch) return false;
            if (profile.connectionId !== active.connectionId || profile.accountId !== UserStore.getCurrentUser()?.id || (accountId && accountId !== profile.accountId)) throw new PanelError("account_mismatch");
            if (!supportsVersion(profile.minimumPluginVersion)) throw new PanelError("upgrade_required");
            const nextPermissions = JSON.stringify([profile.permissionsRevision, [...profile.projects].sort(), [...profile.scopes].sort()]);
            if (permissions && nextPermissions !== permissions) {
                // Rights already changed: the old library must disappear BEFORE a slow snapshot completes.
                panelAccess.set({ ready: false, projects: [], checkedAt: 0 });
                invalidate(); library?.replacePanelCatalog({ templates: [], personal: [], folders: [] });
                fingerprint = "";
                panel.set({ phase: "loading", checkedAt: 0 });
            }
            const catalog = parseSnapshot(await active.get("/snapshot"), profile, htmlToDiscordText);
            if (own !== epoch || !library) return false;
            if (profile.accountId !== UserStore.getCurrentUser()?.id) throw new PanelError("account_mismatch");
            const next = JSON.stringify({ accountId: catalog.accountId, revision: catalog.revision, permissionsRevision: catalog.permissionsRevision,
                templates: catalog.templates, personal: catalog.personal, folders: catalog.folders });
            if (next !== fingerprint) {
                invalidate(); library.replacePanelCatalog(catalog); fingerprint = next;
            }
            accountId = profile.accountId; permissions = nextPermissions; failures = 0; retryAt = 0;
            panelAccess.set({ ready: true, accountId: profile.accountId, projects: profile.projects, checkedAt: started });
            panel.set({ phase: "ready", name: profile.name, checkedAt: started, error: "", code: "", url: "" });
            schedule(own);
            return true;
        } catch (error) {
            if (own !== epoch) return false;
            panelAccess.set({ ready: false }); invalidate();
            const transient = error instanceof PanelError && error.code !== "refresh_uncertain" && (error.status === 429 || error.status >= 500 || ["network_error", "timeout", "request_timeout"].includes(error.code));
            if (transient) {
                failures++;
                panel.set({ phase: "offline", error: message(error) });
                schedule(own, error.retryAfterMs);
            } else {
                client = null; void active.cancel().catch(() => {}); wipe();
                panel.set({ phase: "error", error: message(error) });
            }
            return false;
        }
    };
    const task = run(); loading = task;
    try { return await task; } finally { if (loading === task) loading = null; }
}

export async function connectPanel() {
    const editor = windowEditor();
    const previous = client; client = null;
    if (previous) void previous.cancel().catch(() => {});
    disableDemo(); wipe();
    captureWindowTarget(editor); ui.set({ windowOpen: true });
    library = new Store({ get: async () => undefined, set: async () => {} }, true);
    library.setPreviewOpen(false);
    selectStore(library);
    panelAccess.set({ enabled: true, ready: false });
    panel.set({ enabled: true, phase: "connecting" });
    const active = new PanelClient(createPanelTransport()); client = active;
    const own = epoch;
    setFreshnessCheck(async () => libraryIsFresh() || await loadLibrary());
    try {
        await active.login(device => {
            if (own !== epoch) return;
            panel.set({ phase: "pending", code: device.userCode, url: device.verificationUriComplete });
            openPanelPage();
        });
        if (own !== epoch) return;
        panel.set({ phase: "loading", code: "", url: "" });
        await loadLibrary();
    } catch (error) {
        if (own !== epoch) return;
        client = null; void active.cancel().catch(() => {}); wipe();
        panel.set({ phase: "error", error: message(error) });
    }
}

export function openPanelPage() {
    window.open(panel.get().url || PANEL_ORIGIN + "/connect", "_blank", "noopener,noreferrer");
}

export async function cancelPanelLogin() {
    const previous = client; client = null; wipe();
    const own = epoch;
    try { await previous?.cancel(); }
    catch { if (own === epoch) panel.set({ error: "Локальный вход отменён. Если доступ уже разрешён, отключите устройство на панели." }); }
}

export async function logoutPanel() {
    const previous = client; client = null; wipe();
    const own = epoch;
    try { await previous?.logout(); }
    catch { if (own === epoch) panel.set({ error: "Локальный вход завершён. Не удалось отозвать устройство на панели — отключите его в разделе подключений." }); }
}

export async function reloadPanel() {
    if (client) { if (Date.now() < retryAt) return; clearTimeout(timer); await loadLibrary(); }
    else await connectPanel();
}

/** Only explicit user actions can switch to unrelated local/demo data. */
export async function useLocalLibrary() {
    const editor = windowEditor();
    const closing = logoutPanel(), own = epoch;
    await closing;
    if (own !== epoch) return;
    panel.set({ enabled: false }); panelAccess.set({ enabled: false });
    disableDemo(); selectStore(realStore);
    captureWindowTarget(editor); ui.set({ windowOpen: true });
}
export async function useDemoLibrary() {
    const closing = logoutPanel(), own = epoch;
    await closing;
    if (own !== epoch) return;
    panel.set({ enabled: false }); panelAccess.set({ enabled: false });
    enableDemo(true);
}

export function disposePanel() {
    const previous = client; client = null; previous?.dispose(); wipe();
    setFreshnessCheck(async () => false);
}

/** Discord logout must immediately remove the other account's templates from the UI. */
export function startPanel() {
    const disconnected = () => { if (panel.get().enabled) disposePanel(); };
    FluxDispatcher.subscribe("LOGOUT", disconnected);
    return () => FluxDispatcher.unsubscribe("LOGOUT", disconnected);
}
