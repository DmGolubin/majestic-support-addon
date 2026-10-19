/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxDispatcher, UserStore } from "@webpack/common";

import { PLUGIN_VERSION } from "../buildInfo";
import { diagnosticJournal as journal } from "../core/diagnosticJournal";
import { PanelCatalog, PanelCatalogValidationError, parseFolderRecord, parsePersonalRecord, parseProfile, parseSnapshot, supportsPanelVersion } from "../core/panelCatalog";
import { PanelClient, PanelError } from "../core/panelClient";
import { createPanelEventStream } from "../core/panelEvents";
import { createPanelPreferencesStorage } from "../core/panelPreferences";
import { PANEL_ORIGIN, PanelMutation, panelMutationScope } from "../core/panelProtocol";
import { createPanelTransport } from "../core/panelTransport";
import { StorageLike, Store, STORE_KEY } from "../core/state";
import { htmlToDiscordText } from "../panelHtml";
import { ensurePanelPermission } from "../panelPermission";
import { createPanelVault } from "../panelVault";
import { storage } from "../platform";
import { disableDemo, enableDemo } from "./demo";
import { confirmedForeign, supersede } from "./flow";
import { createObservable } from "./observable";
import { invalidateTicketReminders, stopTicketReminders, syncTicketReminders } from "./ticketReminders";
import { captureWindowTarget, nextGeneration, windowEditor } from "./op";
import { libraryIsFresh, panelAccess, realStore, selectStore, setFreshnessCheck, ui } from "./uiState";

type Phase = "idle" | "connecting" | "pending" | "loading" | "ready" | "offline" | "error";
export const panel = createObservable({ enabled: true, phase: "idle" as Phase, code: "", url: "", error: "", name: "", checkedAt: 0,
    persistent: false, preferencesError: "" as "" | "read" | "write", sync: "idle" as "idle" | "connecting" | "live" | "retrying" });
export const panelPersonal = createObservable({ catalog: null as PanelCatalog | null, connectionId: "", scopes: [] as string[], generation: 0, busy: false });
function clearPersonal() {
    try { stopTicketReminders(); }
    finally { panelPersonal.set({ catalog: null, connectionId: "", scopes: [], generation: panelPersonal.get().generation + 1, busy: false }); }
}
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
let resyncQueued = false;
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

function cleanupPanelStep(name: string, cleanup: () => void) {
    try { cleanup(); }
    catch (error) { console.error(`[SupportTemplates] panel cleanup: ${name}`, error); }
}

function invalidate() {
    nextGeneration(); supersede(); confirmedForeign.clear();
    ui.set({ inline: null, menu: null, dialog: null, compose: [] });
}

function wipe() {
    // Invalidate and detach resources before callbacks/host APIs can throw or re-enter.
    const previousLibrary = library, previousStream = stream, previousTimer = timer, previousStreamTimer = streamTimer;
    library = null; preferences = null; stream = null; timer = streamTimer = undefined;
    epoch++; loading = null; fingerprint = ""; permissions = ""; accountId = null; boundAccountId = null; failures = 0; retryAt = 0;
    streamFailures = 0; syncRevision++; resyncPending = false; resyncQueued = false;
    cleanupPanelStep("library timer", () => clearTimeout(previousTimer));
    cleanupPanelStep("stream timer", () => clearTimeout(previousStreamTimer));
    cleanupPanelStep("event stream", () => previousStream?.abort());
    cleanupPanelStep("personal state", clearPersonal);
    // Let already captured preference writes finish before a later login reads the same account slot.
    if (previousLibrary) {
        cleanupPanelStep("close preferences", () => previousLibrary.closePanelPreferences());
        cleanupPanelStep("flush preferences", () => { void trackCleanup(previousLibrary.flush().catch(() => {})); });
    }
    cleanupPanelStep("access", () => panelAccess.set({ ready: false, accountId: null, projects: [], checkedAt: 0 }));
    cleanupPanelStep("insert generation", nextGeneration);
    cleanupPanelStep("pending dialogs", supersede);
    cleanupPanelStep("foreign confirmations", () => confirmedForeign.clear());
    cleanupPanelStep("UI", () => ui.set({ inline: null, menu: null, dialog: null, compose: [], management: false }));
    cleanupPanelStep("catalog", () => previousLibrary?.replacePanelCatalog({ templates: [], personal: [], folders: [] }));
    cleanupPanelStep("connection state", () => panel.set({ phase: "idle", code: "", url: "", error: "", name: "", checkedAt: 0, persistent: false, preferencesError: "", sync: "idle" }));
}

function message(error: unknown): string {
    if (error instanceof PanelCatalogValidationError && error.kind === "data") {
        return "Не удалось проверить содержимое библиотеки панели. Повторим загрузку. Вставка недоступна до успешной проверки.";
    }
    const code = error instanceof PanelError ? error.code : "invalid_response";
    const labels: Record<string, string> = {
        plugin_disabled: "Подключение к панели пока недоступно. Попробуйте позже.",
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
        transport_error: "Нет связи с панелью. Повторим подключение.",
        timeout: "Панель не ответила вовремя. Повторим подключение.",
        invalid_response: "Ответ панели не соответствует контракту. Загрузка остановлена."
    };
    return labels[code] ?? "Не удалось подключиться к панели. Попробуйте снова.";
}

function terminateSession(active: PanelClient, error: unknown) {
    if (client !== active) return;
    journal.record("auth.terminated", { code: error instanceof PanelError ? error.code : "unknown", status: error instanceof PanelError ? error.status : 0 }, true);
    client = null;
    // cancel clears saved credentials too, including a restored session without a device code.
    void trackCleanup(active.cancel()).catch(() => {});
    wipe(); panel.set({ phase: "error", error: message(error) });
}

/** Events invalidate in-flight snapshots as well as already displayed templates. */
function requestResync(clearCatalog: boolean) {
    invalidateTicketReminders();
    syncRevision++; resyncPending = true;
    panelAccess.set({ ready: false, checkedAt: 0 }); invalidate();
    if (clearCatalog) {
        clearPersonal();
        library?.clearPanelCatalog(); fingerprint = "";
    }
    panel.set({ phase: "loading", checkedAt: 0 });
    if (!loading && !resyncQueued) {
        const own = epoch;
        resyncQueued = true;
        // Invalidate synchronously, but capture one revision after this event burst.
        void Promise.resolve().then(() => {
            if (own !== epoch) return;
            resyncQueued = false;
            if (resyncPending) void loadLibrary();
        });
    }
}

function startEvents() {
    const active = client, own = epoch;
    if (!active?.connectionId || stream || streamTimer) return;
    const controller = new AbortController(); stream = controller;
    panel.set({ sync: "connecting" });
    journal.record("stream.start");
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
                        journal.record("stream.event", { event: event.type }, event.type === "session.revoked");
                        panel.set({ sync: "live" });
                        if (event.type === "session.revoked") {
                            terminateSession(active, new PanelError("session_revoked", 401));
                        } else if (event.type === "token.expired") {
                            tokenExpired = true;
                            stopTicketReminders();
                        }
                        else if (["library.changed", "permissions.changed", "resync.required"].includes(event.type)) {
                            requestResync(event.type === "permissions.changed");
                        }
                        if (["tickets.changed", "tickets.unavailable", "resync.required"].includes(event.type)) invalidateTicketReminders(event.type);
                    });
                } finally { sessionSignal.removeEventListener("abort", abort); }
            });
            if (own !== epoch || controller.signal.aborted) return;
            if (tokenExpired) {
                await active.refreshForStream();
                if (own === epoch && client === active) requestResync(false);
            }
        } catch (error) {
            journal.record("stream.failure", { code: error instanceof PanelError ? error.code : "unknown", status: error instanceof PanelError ? error.status : 0 }, true);
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
        journal.record("stream.retry", { retryAfterMs: delay, failures: streamFailures });
        const due = Date.now() + Math.ceil(delay);
        const reconnect = () => {
            if (own !== epoch || client !== active) return;
            const remaining = due - Date.now();
            if (remaining > 0) { streamTimer = setTimeout(reconnect, Math.min(remaining, 2147483647)); return; }
            streamTimer = undefined;
            startEvents();
        };
        streamTimer = setTimeout(reconnect, Math.min(Math.ceil(delay), 2147483647));
    })();
}

function schedule(own: number, retryAfter = 0) {
    clearTimeout(timer);
    if (epoch !== own || !client) return;
    // Timers truncate fractions; use the same whole milliseconds for the timer and retry guard.
    const delay = Math.ceil(failures ? Math.max(retryAfter, Math.min(120000, 5000 * 2 ** Math.min(failures, 5)) * (0.8 + Math.random() * 0.4)) : 50000 + Math.random() * 20000);
    retryAt = failures ? Date.now() + delay : 0;
    const due = Date.now() + delay;
    const poll = () => {
        if (epoch !== own || !client) return;
        const remaining = due - Date.now();
        if (remaining > 0) { timer = setTimeout(poll, Math.min(remaining, 2147483647)); return; }
        timer = undefined;
        void loadLibrary();
    };
    timer = setTimeout(poll, Math.min(delay, 2147483647));
}

function terminalReadError(error: unknown): boolean {
    return error instanceof PanelError && (error.status === 401 || error.status === 403
        || ["session_revoked", "refresh_uncertain", "not_authenticated", "access_denied", "invalid_grant", "vault_error", "connection_mismatch"].includes(error.code));
}

async function loadLibrary(): Promise<boolean> {
    if (loading) return loading;
    if (Date.now() < retryAt) return false;
    const active = client, own = epoch;
    if (!active) return false;
    const revision = syncRevision;
    resyncPending = false;
    const run = async () => {
        let started = Date.now();
        try {
            let profile: ReturnType<typeof parseProfile>;
            let catalog: ReturnType<typeof parseSnapshot>;
            let nextPermissions: string;
            for (let attempt = 0; ; attempt++) {
                started = Date.now();
                const initial = accountId === null;
                let rawProfile: unknown;
                let initialSnapshot: PromiseSettledResult<unknown> | undefined;
                if (initial) {
                    // No catalog is exposed yet. Overlap authenticated reads, but wait for
                    // both outcomes so a transient failure cannot hide a revocation.
                    const [me, snapshot] = await Promise.allSettled([active.get("/me"), active.get("/snapshot")]);
                    if (me.status === "rejected" && terminalReadError(me.reason)) throw me.reason;
                    if (snapshot.status === "rejected" && terminalReadError(snapshot.reason)) throw snapshot.reason;
                    if (me.status === "rejected") {
                        // Both parallel reads share the next retry; preserve the longer server delay.
                        if (me.reason instanceof PanelError && snapshot.status === "rejected" && snapshot.reason instanceof PanelError) {
                            throw new PanelError(me.reason.code, me.reason.status, Math.max(me.reason.retryAfterMs ?? 0, snapshot.reason.retryAfterMs ?? 0));
                        }
                        throw me.reason;
                    }
                    rawProfile = me.value; initialSnapshot = snapshot;
                } else rawProfile = await active.get("/me");
                if (own !== epoch || revision !== syncRevision || !library) return false;
                profile = parseProfile(rawProfile);
                if (profile.connectionId !== active.connectionId || profile.accountId !== UserStore.getCurrentUser()?.id || (accountId && accountId !== profile.accountId)) throw new PanelError("account_mismatch");
                if (!supportsPanelVersion(PLUGIN_VERSION, profile.minimumPluginVersion)) throw new PanelError("upgrade_required");
                nextPermissions = JSON.stringify([profile.permissionsRevision, [...profile.projects].sort(), [...profile.scopes].sort()]);
                if (permissions && nextPermissions !== permissions) {
                    clearPersonal();
                    // Rights already changed: the old library must disappear BEFORE a slow snapshot completes.
                    panelAccess.set({ ready: false, projects: [], checkedAt: 0 });
                    invalidate(); library?.clearPanelCatalog();
                    fingerprint = "";
                    panel.set({ phase: "loading", checkedAt: 0 });
                }
                if (initialSnapshot?.status === "rejected") throw initialSnapshot.reason;
                const rawSnapshot = initialSnapshot ? initialSnapshot.value : await active.get("/snapshot");
                if (own !== epoch || revision !== syncRevision || !library) return false;
                if (profile.accountId !== UserStore.getCurrentUser()?.id) throw new PanelError("account_mismatch");
                const snapshot = rawSnapshot as { schemaVersion?: unknown; accountId?: unknown; permissionsRevision?: unknown; } | null;
                // The two reads are not atomic. A newer rights revision needs a fresh pair,
                // not session cancellation. Invalid identity/revision metadata still uses strict parsing.
                if (snapshot && !Array.isArray(snapshot) && snapshot.schemaVersion === 1 && snapshot.accountId === profile.accountId
                    && typeof snapshot.permissionsRevision === "string" && snapshot.permissionsRevision.trim()
                    && snapshot.permissionsRevision.length <= 512 && !/[\u0000-\u001f\u007f]/.test(snapshot.permissionsRevision)
                    && snapshot.permissionsRevision !== profile.permissionsRevision) {
                    clearPersonal();
                    panelAccess.set({ ready: false, projects: [], checkedAt: 0 });
                    invalidate(); library.clearPanelCatalog(); fingerprint = "";
                    panel.set({ phase: "loading", checkedAt: 0 });
                    if (attempt === 0) continue;
                    // One retry per load. Keep credentials but stop automatic polling until
                    // an explicit reload or a new external resync/resume trigger.
                    clearTimeout(timer);
                    panel.set({ phase: "offline", error: "Права панели изменились во время загрузки. Повторите загрузку библиотеки." });
                    return false;
                }
                catalog = parseSnapshot(rawSnapshot, profile, htmlToDiscordText);
                break;
            }
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
            panelPersonal.set({ catalog, connectionId: profile.connectionId, scopes: profile.scopes });
            panelAccess.set({ ready: true, accountId: profile.accountId, projects: profile.projects, checkedAt: started });
            panel.set({ phase: "ready", name: profile.name, checkedAt: started, error: "", code: "", url: "" });
            syncTicketReminders({ client: active, accountId: profile.accountId, permissionsRevision: profile.permissionsRevision,
                projects: profile.projects.map(p => p === "mj" ? "majestic" : "russia-online"), scopes: profile.scopes,
                current: () => own === epoch && client === active && UserStore.getCurrentUser()?.id === profile.accountId && panel.get().phase === "ready",
                onAuthError: error => terminateSession(active, error),
            });
            schedule(own);
            startEvents();
            return true;
        } catch (error) {
            if (own !== epoch) return false;
            journal.record("panel.load_failure", { code: error instanceof PanelError ? error.code : "invalid_response", status: error instanceof PanelError ? error.status : 0 }, true);
            // Superseded payload errors cannot fail a newer resync. Auth/storage failures
            // still fail closed, and transient failures retain their retry delay below.
            const terminal = terminalReadError(error);
            // Even a superseded read's rate limit/network backoff applies to the next read.
            const transient = !terminal && ((error instanceof PanelCatalogValidationError && error.kind === "data")
                || (error instanceof PanelError && (error.status === 429 || error.status >= 500 || ["network_error", "transport_error", "timeout", "request_timeout"].includes(error.code))));
            if (revision !== syncRevision && !terminal && !transient) return false;
            panelAccess.set({ ready: false }); invalidate();
            stopTicketReminders();
            if (transient) {
                failures++;
                panel.set({ phase: "offline", error: message(error) });
                schedule(own, error instanceof PanelError ? error.retryAfterMs : 0);
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

async function beginPanel(restore: boolean, writeAccess = !restore, reminderAccess = !restore) {
    const editor = windowEditor();
    const management = ui.get().management;
    const previous = client; client = null;
    if (previous) void trackCleanup(previous.cancel()).catch(() => {});
    disableDemo(); wipe();
    if (!restore && management) ui.set({ management: true });
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
        active = new PanelClient(createPanelTransport(), { vault, accountId: discordId, writeAccess, reminderAccess }); client = active;
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
        journal.record("auth.login_failure", { code: error instanceof PanelError ? error.code : "unknown", status: error instanceof PanelError ? error.status : 0 }, true);
        client = null; if (active) void trackCleanup(active.cancel()).catch(() => {}); wipe();
        panel.set({ phase: "error", error: message(error) });
    }
}

export async function connectPanel() { journal.record("user.login", {}, true); await beginPanel(false); }
export async function restorePanel() { await beginPanel(true); }

/** Explicit user action only. Existing read-only credentials remain valid until this is chosen. */
export async function authorizePanelEditing() { await beginPanel(false, true); }

/** Additional ticket/settings scopes require a new confirmation on the panel. */
export async function authorizePanelReminders() {
    const writeAccess = panelPersonal.get().scopes.includes("personal:write");
    await beginPanel(false, writeAccess, true);
}

export function panelWriteMessage(error: unknown): string {
    if (!(error instanceof PanelError)) return "Не удалось подтвердить запись. Черновик сохранён в этом окне.";
    if (error.status === 412 || error.code === "version_conflict") return "Запись изменена на панели. Ваш черновик сохранён. Сравните с текущей записью; повторное сохранение заблокировано до вашего решения.";
    const labels: Record<string, string> = {
        insufficient_scope: "Для редактирования нужно явно разрешить запись на панели.",
        name_exists: "Такое название уже занято. Выберите другое.",
        invalid_request: "Проверьте название, текст, команду, проект и папку.",
        not_found: "Запись удалена или больше недоступна. Черновик не отправлен повторно.",
        cancelled: "Аккаунт или права изменились. Операция остановлена.",
        write_busy: "Дождитесь завершения текущей записи.",
        stale_library: "Сначала восстановите соединение и обновите библиотеку.",
        idempotency_conflict: "Ключ сохранения уже использован с другим содержимым. Обновите библиотеку.",
    };
    return labels[error.code] ?? "Результат записи не подтверждён. Повторите ту же операцию; черновик остаётся в этом окне.";
}

/** One action captures JSON, version and UUID once. Reuse this function for uncertain retries. */
export function preparePanelWrite(input: PanelMutation): () => Promise<{ refreshed: boolean }> {
    const request: PanelMutation = JSON.parse(JSON.stringify(input));
    const scope = panelMutationScope(request);
    const active = client, own = epoch, generation = panelPersonal.get().generation;
    const owner = boundAccountId;
    let confirmed = false, conflicted = false;
    // Also validates delayed/replayed responses against the palette at first dispatch.
    let submittedColors: string[] | null = null;
    const guard = () => {
        if (!active || client !== active || own !== epoch || generation !== panelPersonal.get().generation
            || !owner || owner !== UserStore.getCurrentUser()?.id) throw new PanelError("cancelled");
        const { catalog, scopes } = panelPersonal.get();
        if (!catalog || catalog.accountId !== owner) throw new PanelError("stale_library");
        if (!scopes.includes(scope)) throw new PanelError("insufficient_scope", 403);
        const body = request.body as Record<string, unknown> | undefined;
        const personal = scope === "personal:write";
        const id = request.path.split("/")[2];
        const existing = personal ? catalog.personalRecords.find(t => t.id === id) : catalog.folderRecords.find(f => f.id === id);
        // Missing records may be the result of an uncertain delete. Retrying with its original
        // If-Match is safe; the server remains the authority for absence and access.
        if ((body?.shared || (existing && "shared" in existing && existing.shared)) && catalog.projects.length !== 2) throw new PanelError("forbidden", 403);
        const project = body?.project === "majestic" ? "mj" : body?.project === "russia-online" ? "ro" : undefined;
        if (project && !catalog.projects.includes(project)) throw new PanelError("forbidden", 403);
    };
    const validateDraft = () => {
        // Once dispatch is possible, only the server can resolve an uncertain action.
        // Changed dependencies must not replace its captured body or create UUID.
        if (submittedColors !== null) return;
        const catalog = panelPersonal.get().catalog!;
        const body = request.body as Record<string, unknown> | undefined;
        const project = body?.project === "majestic" ? "mj" : body?.project === "russia-online" ? "ro" : undefined;
        if (body?.color && !catalog.colors.includes(body.color as string)) throw new PanelError("invalid_request");
        if (body?.folderId) {
            const folder = catalog.folderRecords.find(f => f.id === body.folderId);
            if (!folder || (!body.shared && project && folder.project !== project)) throw new PanelError("invalid_request");
        }
    };
    guard();
    validateDraft();
    return async () => {
        guard();
        if (conflicted) throw new PanelError("version_conflict", 412);
        if (panelPersonal.get().busy) throw new PanelError("write_busy");
        panelPersonal.set({ busy: true });
        try {
            if (!libraryIsFresh() && !await loadLibrary()) throw new PanelError("stale_library");
            guard();
            if (!confirmed) {
                const raw = await active!.mutate(request, () => {
                    guard();
                    if (!libraryIsFresh()) throw new PanelError("stale_library");
                    validateDraft();
                    submittedColors ??= [...panelPersonal.get().catalog!.colors];
                });
                guard();
                const result = raw as Record<string, unknown> | null;
                const catalog = panelPersonal.get().catalog!;
                try {
                    if (request.method === "DELETE") {
                        if (!result || result.success !== true) throw new Error();
                    } else {
                        const record = scope === "folders:write" ? parseFolderRecord(result?.folder, catalog.projects)
                            : parsePersonalRecord(result?.template, catalog.projects, submittedColors!);
                        if (request.method === "PATCH" && record.id !== request.path.split("/")[2]) throw new Error();
                    }
                } catch { throw new PanelError("invalid_response"); }
                confirmed = true;
            }
            // Invalidate reads begun before the mutation; publish only a fresh server snapshot.
            syncRevision++; resyncPending = false;
            panelAccess.set({ ready: false, checkedAt: 0 }); invalidate();
            panel.set({ phase: "loading", checkedAt: 0 });
            if (loading) await loading;
            const refreshed = await loadLibrary();
            guard();
            return { refreshed };
        } catch (error) {
            if (own === epoch && client === active) {
                if (error instanceof PanelError && (error.status === 412 || error.code === "version_conflict")) {
                    conflicted = true;
                    syncRevision++; resyncPending = false;
                    panelAccess.set({ ready: false, checkedAt: 0 }); invalidate();
                    panel.set({ phase: "loading", checkedAt: 0 });
                    if (loading) await loading;
                    await loadLibrary(); // Draft and its original version are never replaced here.
                } else if (error instanceof PanelError && (error.status === 401
                    || ["session_revoked", "refresh_uncertain", "not_authenticated", "access_denied", "invalid_grant", "vault_error", "connection_mismatch"].includes(error.code))) {
                    terminateSession(active!, error);
                } else if (error instanceof PanelError && error.status === 403 && error.code !== "insufficient_scope") requestResync(true);
            }
            throw error;
        } finally {
            if (own === epoch && generation === panelPersonal.get().generation) panelPersonal.set({ busy: false });
        }
    };
}

export function openPanelPage() {
    window.open(panel.get().url || PANEL_ORIGIN + "/connect", "_blank", "noopener,noreferrer");
}

export async function cancelPanelLogin() {
    journal.record("user.cancel", {}, true);
    const previous = client; client = null; wipe();
    const own = epoch;
    try { if (previous) await trackCleanup(previous.cancel()); }
    catch { if (own === epoch) panel.set({ error: "Локальный вход отменён. Если доступ уже разрешён, отключите устройство на панели." }); }
}

export async function logoutPanel(reason: "user" | "discord_logout" | "account_changed" = "user") {
    journal.record("auth.logout", { reason }, true);
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
    const previous = client, off = offPanelEvents;
    client = null; offPanelEvents = null;
    cleanupPanelStep("subscriptions", () => off ? off() : retryPanelUnsubscribes());
    cleanupPanelStep("client", () => previous?.dispose());
    cleanupPanelStep("session", wipe);
    cleanupPanelStep("freshness", () => setFreshnessCheck(async () => false));
}

let offPanelEvents: (() => void) | null = null;
// Only failed removals survive teardown. Their callbacks are inert; later stop/start may retry.
const pendingPanelUnsubscribes = new Set<() => void>();
function retryPanelUnsubscribes() {
    for (const remove of [...pendingPanelUnsubscribes]) {
        if (!pendingPanelUnsubscribes.delete(remove)) continue; // A reentrant cleanup may have drained it.
        for (let attempt = 0; attempt < 2; attempt++) {
            try { remove(); break; }
            catch (error) {
                if (attempt === 1) {
                    pendingPanelUnsubscribes.add(remove);
                    console.error("[SupportTemplates] panel unsubscribe failed after two attempts", error);
                }
            }
        }
    }
}

/** Discord logout must immediately remove the other account's templates from the UI. */
export function startPanel() {
    if (offPanelEvents) return offPanelEvents;
    retryPanelUnsubscribes();
    // Do not accumulate another generation of subscriptions while the host still refuses removal.
    if (pendingPanelUnsubscribes.size) throw new Error("SupportTemplates: panel subscriptions could not be released");
    let live = true;
    const removals = new Set<() => void>();
    const off = () => {
        live = false;
        if (offPanelEvents === off) offPanelEvents = null;
        for (const remove of removals) pendingPanelUnsubscribes.add(remove);
        removals.clear();
        retryPanelUnsubscribes();
    };
    const listen = (add: () => void, remove: () => void) => {
        removals.add(remove); // Host subscriptions may throw AFTER attaching the callback.
        add();
    };
    const disconnected = () => { if (live && panel.get().enabled) void logoutPanel("discord_logout"); };
    const resume = () => {
        if (!live || !panel.get().enabled) return;
        if (boundAccountId && boundAccountId !== UserStore.getCurrentUser()?.id) { void logoutPanel("account_changed"); return; }
        if (cleanups.size) return;
        if (client) {
            if (!client.connectionId) { client.resumeLogin(); return; }
            invalidateTicketReminders();
            if (!libraryIsFresh()) {
                // The contract has no heartbeat. Replace a possibly half-open connection after sleep.
                stream?.abort(); stream = null;
                void loadLibrary();
            }
            startEvents(); // An existing Retry-After timer is still respected.
        }
        else if (panel.get().phase === "idle" && UserStore.getCurrentUser()?.id) void restorePanel();
    };
    const changedAccount = () => {
        if (live && boundAccountId && boundAccountId !== UserStore.getCurrentUser()?.id) void logoutPanel("account_changed");
    };
    const visible = () => { if (live && document.visibilityState === "visible") resume(); };
    offPanelEvents = off;
    try {
        listen(() => FluxDispatcher.subscribe("LOGOUT", disconnected), () => FluxDispatcher.unsubscribe("LOGOUT", disconnected));
        listen(() => FluxDispatcher.subscribe("CONNECTION_OPEN", resume), () => FluxDispatcher.unsubscribe("CONNECTION_OPEN", resume));
        listen(() => UserStore.addChangeListener(changedAccount), () => UserStore.removeChangeListener(changedAccount));
        listen(() => window.addEventListener("online", resume), () => window.removeEventListener("online", resume));
        listen(() => window.addEventListener("focus", resume), () => window.removeEventListener("focus", resume));
        listen(() => document.addEventListener("visibilitychange", visible), () => document.removeEventListener("visibilitychange", visible));
        resume();
        return off;
    } catch (error) {
        disposePanel();
        throw error; // Cleanup diagnostics must never replace the original startup error.
    }
}
