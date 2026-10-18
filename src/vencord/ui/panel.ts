/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxDispatcher, UserStore } from "@webpack/common";

import { PLUGIN_VERSION } from "../buildInfo";
import { parseProfile, parseSnapshot } from "../core/panelCatalog";
import { PanelClient, PanelError } from "../core/panelClient";
import { createPanelEventStream } from "../core/panelEvents";
import { createPanelPreferencesStorage } from "../core/panelPreferences";
import { PANEL_ORIGIN } from "../core/panelProtocol";
import { createPanelTransport } from "../core/panelTransport";
import { StorageLike, Store, STORE_KEY } from "../core/state";
import { htmlToDiscordText } from "../panelHtml";
import { ensurePanelPermission } from "../panelPermission";
import { createPanelVault } from "../panelVault";
import { storage } from "../platform";
import { disableDemo, enableDemo } from "./demo";
import { confirmedForeign, supersede } from "./flow";
import { createObservable } from "./observable";
import { captureWindowTarget, nextGeneration, windowEditor } from "./op";
import { libraryIsFresh, panelAccess, realStore, selectStore, setFreshnessCheck, ui } from "./uiState";

type Phase = "idle" | "connecting" | "pending" | "loading" | "ready" | "offline" | "error";
export const panel = createObservable({ enabled: true, phase: "idle" as Phase, code: "", url: "", error: "", name: "", checkedAt: 0,
    persistent: false, preferencesError: "" as "" | "read" | "write", sync: "idle" as "idle" | "connecting" | "live" | "retrying" });
let client: PanelClient | null = null;
let library: Store | null = null;
let preferences: { storage: StorageLike; loaded: boolean; writable: boolean; } | null = null;
let epoch = 0;
let fingerprint = "";
let permissions = "";
let accountId: string | null = null;
let boundAccountId: string | null = null;
let loading: Promise<boolean> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
let retryAt = 0;
let syncRevision = 0;
let resyncPending = false;
let stream: AbortController | null = null;
let streamTimer: ReturnType<typeof setTimeout> | undefined;
let streamFailures = 0;
const readEvents = createPanelEventStream();
const cleanups = new Set<Promise<void>>();
function trackCleanup(task: Promise<void>): Promise<void> {
    cleanups.add(task);
    void task.then(() => cleanups.delete(task), () => cleanups.delete(task));
    return task;
}
async function finishCleanups() {
    while (cleanups.size) await Promise.all([...cleanups].map(task => task.catch(() => {})));
}

function invalidate() {
    nextGeneration(); supersede(); confirmedForeign.clear();
    ui.set({ inline: null, menu: null, dialog: null, compose: [] });
}

function wipe() {
    // Let already captured preference writes finish before a later login reads the same account slot.
    if (library) {
        library.closePanelPreferences();
        void trackCleanup(library.flush().catch(() => {}));
    }
    epoch++; clearTimeout(timer); loading = null; fingerprint = ""; permissions = ""; accountId = null; boundAccountId = null; failures = 0; retryAt = 0;
    stream?.abort(); stream = null; clearTimeout(streamTimer); streamTimer = undefined; streamFailures = 0;
    syncRevision++; resyncPending = false;
    panelAccess.set({ ready: false, accountId: null, projects: [], checkedAt: 0 });
    invalidate(); ui.set({ management: false });
    library?.replacePanelCatalog({ templates: [], personal: [], folders: [] });
    library = null; preferences = null;
    panel.set({ phase: "idle", code: "", url: "", error: "", name: "", checkedAt: 0, persistent: false, preferencesError: "", sync: "idle" });
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
        vault_error: "Не удалось прочитать или сохранить защищённый вход. Попробуйте войти снова.",
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

function terminateSession(active: PanelClient, error: unknown) {
    if (client !== active) return;
    client = null;
    // cancel clears saved credentials too, including a restored session without a device code.
    void trackCleanup(active.cancel()).catch(() => {});
    wipe(); panel.set({ phase: "error", error: message(error) });
}

/** Events invalidate in-flight snapshots as well as already displayed templates. */
function requestResync(clearCatalog: boolean) {
    syncRevision++; resyncPending = true;
    panelAccess.set({ ready: false, checkedAt: 0 }); invalidate();
    if (clearCatalog) {
        library?.clearPanelCatalog(); fingerprint = "";
    }
    panel.set({ phase: "loading", checkedAt: 0 });
    if (!loading) void loadLibrary();
}

function startEvents() {
    const active = client, own = epoch;
    if (!active?.connectionId || stream || streamTimer) return;
    const controller = new AbortController(); stream = controller;
    panel.set({ sync: "connecting" });
    void (async () => {
        let tokenExpired = false;
        let retryAfter = 0;
        const started = Date.now();
        try {
            await active.streamAuthorized(async (token, sessionSignal) => {
                const abort = () => controller.abort();
                sessionSignal.addEventListener("abort", abort, { once: true });
                if (sessionSignal.aborted) controller.abort();
                try {
                    await readEvents(token, controller.signal, event => {
                        if (own !== epoch || client !== active || controller.signal.aborted) return;
                        panel.set({ sync: "live" });
                        if (event.type === "session.revoked") {
                            terminateSession(active, new PanelError("session_revoked", 401));
                        } else if (event.type === "token.expired") tokenExpired = true;
                        else if (["library.changed", "permissions.changed", "resync.required"].includes(event.type)) {
                            requestResync(event.type === "permissions.changed");
                        }
                        // Ticket events belong to the ticket assistant, not the template catalog.
                    });
                } finally { sessionSignal.removeEventListener("abort", abort); }
            });
            if (own !== epoch || controller.signal.aborted) return;
            if (tokenExpired) await active.refreshForStream();
        } catch (error) {
            if (own !== epoch || client !== active) return;
            if (error instanceof PanelError && (["session_revoked", "refresh_uncertain", "not_authenticated", "access_denied", "invalid_grant", "vault_error", "connection_mismatch"].includes(error.code)
                || error.status === 401 || error.status === 403)) {
                terminateSession(active, error); return;
            }
            retryAfter = error instanceof PanelError ? error.retryAfterMs ?? 0 : 0;
        } finally {
            if (stream === controller) stream = null;
        }
        if (own !== epoch || client !== active || controller.signal.aborted) return;
        // A rapid successful handshake followed by EOF still backs off: no reconnect storm.
        streamFailures = Date.now() - started >= 30000 ? 0 : Math.min(streamFailures + 1, 6);
        const delay = tokenExpired ? 250 : Math.max(retryAfter, Math.min(60000, 1000 * 2 ** streamFailures) * (0.8 + Math.random() * 0.4));
        panel.set({ sync: "retrying" });
        streamTimer = setTimeout(() => { streamTimer = undefined; if (own === epoch) startEvents(); }, Math.min(delay, 2147483647));
    })();
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
    const revision = syncRevision;
    resyncPending = false;
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
                invalidate(); library?.clearPanelCatalog();
                fingerprint = "";
                panel.set({ phase: "loading", checkedAt: 0 });
            }
            const catalog = parseSnapshot(await active.get("/snapshot"), profile, htmlToDiscordText);
            if (own !== epoch || !library) return false;
            if (revision !== syncRevision) return false;
            if (profile.accountId !== UserStore.getCurrentUser()?.id) throw new PanelError("account_mismatch");
            const prefs = preferences;
            let savedPreferences: unknown;
            const restorePreferences = !!prefs && !prefs.loaded;
            if (restorePreferences) {
                let readable = false;
                try {
                    savedPreferences = await prefs.storage.get(STORE_KEY);
                    readable = true;
                } catch {
                    // Do not overwrite unread preferences with defaults after a storage failure.
                    if (own === epoch) panel.set({ preferencesError: "read" });
                }
                if (own !== epoch || revision !== syncRevision || !library) return false;
                if (profile.accountId !== UserStore.getCurrentUser()?.id) throw new PanelError("account_mismatch");
                prefs.loaded = true; prefs.writable = readable;
            }
            const next = JSON.stringify({ accountId: catalog.accountId, revision: catalog.revision, permissionsRevision: catalog.permissionsRevision,
                templates: catalog.templates, personal: catalog.personal, folders: catalog.folders });
            if (next !== fingerprint) {
                invalidate(); library.replacePanelCatalog(catalog); fingerprint = next;
                if (restorePreferences && savedPreferences !== undefined) library.restorePanelPreferences(savedPreferences);
                library.savePanelPreferences();
            }
            accountId = profile.accountId; permissions = nextPermissions; failures = 0; retryAt = 0;
            panelAccess.set({ ready: true, accountId: profile.accountId, projects: profile.projects, checkedAt: started });
            panel.set({ phase: "ready", name: profile.name, checkedAt: started, error: "", code: "", url: "" });
            schedule(own);
            startEvents();
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
                terminateSession(active, error);
            }
            return false;
        }
    };
    const task = run(); loading = task;
    try { return await task; } finally {
        if (loading === task) {
            loading = null;
            if (resyncPending && own === epoch && Date.now() >= retryAt) void loadLibrary();
        }
    }
}

async function beginPanel(restore: boolean) {
    const editor = windowEditor();
    const previous = client; client = null;
    if (previous) void trackCleanup(previous.cancel()).catch(() => {});
    disableDemo(); wipe();
    const own = epoch;
    if (!restore) { captureWindowTarget(editor); ui.set({ windowOpen: true }); }
    const discordId = UserStore.getCurrentUser()?.id;
    if (!discordId) return;
    boundAccountId = discordId;
    panelAccess.set({ enabled: true, ready: false });
    panel.set({ enabled: true, phase: restore ? "loading" : "connecting" });
    let active: PanelClient | null = null;
    try {
        // Old clients must finish clearing the shared slot before a new native vault handle claims it.
        await finishCleanups();
        if (own !== epoch) return;
        const permission = await ensurePanelPermission(!restore);
        if (own !== epoch) return;
        if (permission !== "ready") {
            panel.set({ phase: restore && permission === "required" ? "idle" : "error", error: permission === "restart"
                ? "Доступ к панели разрешён. Полностью закройте и запустите Discord, затем повторите вход."
                : permission === "required"
                    ? restore ? "" : "Для входа разрешите соединение с панелью в окне Vencord."
                    : "Не удалось проверить разрешение на соединение с панелью. Перезапустите Discord." });
            return;
        }
        const vault = await createPanelVault(discordId);
        if (own !== epoch) return;
        const prefs = { storage: createPanelPreferencesStorage(storage, discordId), loaded: false, writable: false };
        preferences = prefs;
        library = new Store({
            get: key => prefs.storage.get(key),
            set: async (key, value) => {
                if (!prefs.writable) return;
                try {
                    await prefs.storage.set(key, value);
                    if (own === epoch) panel.set({ preferencesError: "" });
                } catch {
                    if (own === epoch) panel.set({ preferencesError: "write" });
                    throw new Error("Не удалось сохранить настройки библиотеки панели");
                }
            }
        }, true);
        library.data.previewOpen = false;
        selectStore(library);
        panel.set({ persistent: !!vault });
        active = new PanelClient(createPanelTransport(), { vault, accountId: discordId }); client = active;
        setFreshnessCheck(async () => libraryIsFresh() || await loadLibrary());
        if (restore) {
            if (!await active.restore()) {
                if (own === epoch) { active.dispose(); client = null; panel.set({ phase: "idle" }); }
                return;
            }
        } else await active.login(device => {
            if (own !== epoch) return;
            panel.set({ phase: "pending", code: device.userCode, url: device.verificationUriComplete });
            openPanelPage();
        });
        if (own !== epoch) return;
        panel.set({ phase: "loading", code: "", url: "" });
        await loadLibrary();
    } catch (error) {
        if (own !== epoch) return;
        client = null; if (active) void trackCleanup(active.cancel()).catch(() => {}); wipe();
        panel.set({ phase: "error", error: message(error) });
    }
}

export async function connectPanel() { await beginPanel(false); }
export async function restorePanel() { await beginPanel(true); }

export function openPanelPage() {
    window.open(panel.get().url || PANEL_ORIGIN + "/connect", "_blank", "noopener,noreferrer");
}

export async function cancelPanelLogin() {
    const previous = client; client = null; wipe();
    const own = epoch;
    try { if (previous) await trackCleanup(previous.cancel()); }
    catch { if (own === epoch) panel.set({ error: "Локальный вход отменён. Если доступ уже разрешён, отключите устройство на панели." }); }
}

export async function logoutPanel() {
    const previous = client; client = null; wipe();
    const own = epoch;
    try { if (previous) await trackCleanup(previous.logout()); }
    catch { if (own === epoch) panel.set({ error: "Локальный вход завершён. Не удалось отозвать устройство на панели — отключите его в разделе подключений." }); }
}

export async function reloadPanel() {
    if (client) { if (Date.now() < retryAt) return; clearTimeout(timer); await loadLibrary(); }
    else await connectPanel();
}

/** Retry the current in-memory preferences without losing them through logout. */
export async function retryPanelPreferences() {
    if (!library || !preferences?.loaded || !preferences.writable) return;
    library.savePanelPreferences();
    await library.flush().catch(() => {}); // The storage adapter exposes failure in panel state.
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
    const disconnected = () => { if (panel.get().enabled) void logoutPanel(); };
    const resume = () => {
        if (!panel.get().enabled) return;
        if (boundAccountId && boundAccountId !== UserStore.getCurrentUser()?.id) { void logoutPanel(); return; }
        if (cleanups.size) return;
        if (client) {
            if (!client.connectionId) return; // Focus commonly returns before device confirmation.
            if (!libraryIsFresh()) {
                // The contract has no heartbeat. Replace a possibly half-open connection after sleep.
                stream?.abort(); stream = null;
                void loadLibrary();
            }
            startEvents(); // An existing Retry-After timer is still respected.
        }
        else if (panel.get().phase === "idle" && UserStore.getCurrentUser()?.id) void restorePanel();
    };
    FluxDispatcher.subscribe("LOGOUT", disconnected);
    FluxDispatcher.subscribe("CONNECTION_OPEN", resume);
    const changedAccount = () => {
        if (boundAccountId && boundAccountId !== UserStore.getCurrentUser()?.id) disconnected();
    };
    UserStore.addChangeListener(changedAccount);
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    resume();
    return () => {
        FluxDispatcher.unsubscribe("LOGOUT", disconnected);
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", resume);
        UserStore.removeChangeListener(changedAccount);
        window.removeEventListener("online", resume);
        window.removeEventListener("focus", resume);
    };
}
