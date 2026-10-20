/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useRef, useState } from "@webpack/common";

import { cancelPanelLogin, connectPanel, logoutPanel, openPanelPage, panel, reloadPanel, retryPanelPreferences } from "./panel";
import { IconLogout, IconRefresh } from "./svg";
import { SupportedServers } from "./SupportedServers";

type Action = "connect" | "cancel" | "reload" | "logout" | "save";

export function PanelConnection({ compact = false }: { compact?: boolean; }) {
    const p = panel.use();
    const phase = p.enabled ? p.phase : "idle";
    const [busy, setBusy] = useState<Action | null>(null);
    const [actionError, setActionError] = useState("");
    const activeAction = useRef<{ kind: Action; } | null>(null);
    const waiting = phase === "connecting" || phase === "pending" || phase === "loading";
    const ending = busy === "cancel" || busy === "logout";
    const labels = {
        idle: "Подключите аккаунт панели",
        connecting: "Подключаемся к панели…",
        pending: "Ожидаем подтверждение входа",
        loading: "Загружаем библиотеку…",
        ready: "Библиотека загружена",
        offline: "Нет связи с панелью",
        error: "Не удалось подключиться"
    };

    const run = (action: Action, fn: () => Promise<void>) => {
        // Cancellation/logout can interrupt a pending connection or refresh.
        const { current } = activeAction;
        if (current && (current.kind === "cancel" || current.kind === "logout" || (action !== "cancel" && action !== "logout"))) return;
        const ownAction = { kind: action };
        activeAction.current = ownAction;
        setBusy(action); setActionError("");
        void (async () => {
            try { await fn(); } catch {
                // Controller errors are already translated. Never render/log a thrown response.
                if (activeAction.current === ownAction) setActionError("Не удалось выполнить действие. Попробуйте снова.");
            } finally {
                if (activeAction.current === ownAction) { activeAction.current = null; setBusy(null); }
            }
        })();
    };
    const reopen = () => {
        setActionError("");
        try { openPanelPage(); } catch { setActionError("Не удалось открыть панель. Попробуйте снова."); }
    };
    const error = p.error || actionError;

    if (!compact && (phase === "ready" || phase === "offline")) return <section className="vc-stx-setting-section vc-stx-setting-card" aria-label="Аккаунт и синхронизация">
        <h3>Аккаунт</h3>
        <div className="vc-stx-account-summary">
            <div><strong>{p.name || "Аккаунт панели"}</strong>
                <div className={"vc-stx-connection-state" + (phase === "ready" ? " ready" : "")} role="status"><span aria-hidden="true" />
                    {phase === "offline" ? "Нет связи" : "Подключён"}
                </div>
            </div>
            <div className="vc-stx-account-meta">
                {phase === "offline" && <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={busy !== null} onClick={() => run("reload", reloadPanel)}><IconRefresh />{busy === "reload" ? "Подключаемся…" : "Повторить"}</button>}
                <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={ending} onClick={() => run("logout", logoutPanel)}><IconLogout />{busy === "logout" ? "Выходим…" : "Выйти"}</button>
            </div>
        </div>
        {error && <p className="vc-stx-form-error" role="alert">{error}</p>}
        {p.preferencesError && <p className="vc-stx-form-error" role="alert">{p.preferencesError === "read" ? "Не удалось прочитать настройки списка. Для повторной попытки войдите заново." : "Не удалось сохранить настройки списка."}</p>}
        {p.preferencesError === "write" && <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={busy !== null} onClick={() => run("save", retryPanelPreferences)}>{busy === "save" ? "Сохраняем…" : "Повторить сохранение"}</button>}
        {!p.persistent && <p className="vc-stx-hint">После перезапуска Discord потребуется войти снова.</p>}
        <SupportedServers />
    </section>;

    return <section className={compact ? "vc-stx-login-scene" : "vc-stx-setting-section vc-stx-setting-card"} aria-label="Подключение к панели">
        {compact ? <h2>Вход через панель</h2> : <h3>Аккаунт и синхронизация</h3>}
        <div className={waiting ? "vc-stx-login-progress" : "vc-stx-connection-state" + (phase === "ready" ? " ready" : "")} role="status">
            <span className={waiting ? "vc-stx-login-spinner" : undefined} aria-hidden="true" />{labels[phase]}
        </div>
        {phase === "idle" && <p className="vc-stx-login-copy">Войдите, чтобы загрузить FAQ и личные шаблоны.</p>}
        {phase === "pending" && <>
            <p className="vc-stx-login-copy">Сверьте код на панели и подтвердите вход.</p>
            {p.code && <div className="vc-stx-login-code"><span>Код подтверждения</span><strong>{p.code}</strong></div>}
        </>}
        {phase === "ready" && <p>Аккаунт: <strong>{p.name || "Аккаунт панели"}</strong></p>}
        {phase === "offline" && <p className="vc-stx-login-copy">Повторите загрузку библиотеки, чтобы продолжить работу.</p>}
        {(phase === "ready" || phase === "offline") && <>
            <p className="vc-stx-local-note"><strong>{p.persistent
                ? "Вход сохранён в защищённом хранилище."
                : "Вход действует до перезапуска Discord."}</strong></p>
            {p.sync === "live" && <p className="vc-stx-local-note" role="status">Изменения появляются автоматически.</p>}
            {p.sync === "retrying" && <p className="vc-stx-local-note" role="status">Восстанавливаем связь. Пока проверяем изменения периодически.</p>}
        </>}
        {error && <p className="vc-stx-form-error" role="alert">{error}</p>}
        {p.preferencesError === "read" && <p className="vc-stx-form-error" role="alert">Не удалось прочитать настройки списка. Изменения в этом сеансе не сохраняются. Для повторного чтения войдите заново.</p>}
        {p.preferencesError === "write" && <p className="vc-stx-form-error" role="alert">Не удалось сохранить настройки списка. Изменения пока только в памяти — повторите сохранение перед выходом.</p>}
        <div className={compact ? "vc-stx-login-actions" : "vc-stx-lib-actions"}>
            {p.preferencesError === "write" && <button type="button" className="vc-stx-btn" disabled={busy !== null} onClick={() => run("save", retryPanelPreferences)}>
                {busy === "save" ? "Сохраняем…" : "Повторить сохранение"}
            </button>}
            {(phase === "idle" || phase === "error") && <button type="button" className="vc-stx-btn" disabled={busy !== null} onClick={() => run("connect", connectPanel)}>
                {phase === "error" ? "Повторить вход" : "Войти через панель"}
            </button>}
            {phase === "pending" && p.url && <button type="button" className="vc-stx-btn" disabled={ending} onClick={reopen}>Открыть панель повторно</button>}
            {waiting && <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={ending} onClick={() => run("cancel", cancelPanelLogin)}>
                {busy === "cancel" ? "Отменяем…" : "Отмена"}
            </button>}
            {(phase === "ready" || phase === "offline") && <button type="button" className="vc-stx-btn" disabled={busy !== null} onClick={() => run("reload", reloadPanel)}>
                {busy === "reload" ? "Обновляем…" : phase === "offline" ? "Повторить загрузку" : "Обновить библиотеку"}
            </button>}
            {(phase === "ready" || phase === "offline" || (phase === "error" && p.enabled)) && <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={ending} onClick={() => run("logout", logoutPanel)}>
                {busy === "logout" ? "Выходим…" : "Выйти"}
            </button>}
        </div>
    </section>;
}
