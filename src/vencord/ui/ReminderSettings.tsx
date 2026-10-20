/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ProjectIcon } from "./ProjectIcon";
import { authorizePanelReminders } from "./panel";
import { refreshTicketReminders, setDiscordReminders, ticketRemindersState } from "./ticketReminders";

export function ReminderSettings({ children }: { children?: React.ReactNode; } = {}) {
    const { phase, settings, busy, error, deliveryError } = ticketRemindersState.use();
    const ready = phase === "ready" && !!settings;
    return <section className="vc-stx-setting-section vc-stx-ticket-section" aria-label="Личные напоминания">
        <header className="vc-stx-ticket-heading">
            <svg className="vc-stx-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            <h3>Личные напоминания</h3>
        </header>
        <p className="vc-stx-muted">Только назначенные вам тикеты, где игрок ждёт ответа.</p>
        {phase === "idle" ? <p className="vc-stx-muted">Войдите в аккаунт панели, чтобы подключить напоминания.</p>
            : phase === "permission" ? <>
                <p className="vc-stx-muted">Разрешите панели доступ к вашим тикетам и настройкам напоминаний.</p>
                <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => void authorizePanelReminders()}>Подключить напоминания</button>
            </> : <>
                <div className="vc-stx-reminder-master"><label className="vc-stx-check"><input type="checkbox" checked={settings?.discordEnabled ?? false} disabled={!ready || busy} onChange={e => void setDiscordReminders(e.currentTarget.checked)} />Напоминать в Discord</label><small>Общий переключатель для всех серверов</small></div>
                {phase === "loading" && <p className="vc-stx-muted" role="status">Загружаем настройки…</p>}
                {!children && !!settings?.projects.length && <ul className="vc-stx-reminder-thresholds" aria-label="Пороги личных напоминаний">{settings.projects.map(p => <li key={p.project}>
                    <span aria-hidden="true"><ProjectIcon project={p.project === "majestic" ? "mj" : "ro"} size={16} /></span>
                    <span>{p.project === "majestic" ? "Majestic" : "Россия Онлайн"}</span><strong>{p.personalReminderMinutes} мин</strong>
                </li>)}</ul>}
                <p className="vc-stx-muted">Порог меняется в Telegram. Звук и громкость — отдельно для каждого сервера.</p>
                {children}
                {busy && <p className="vc-stx-muted" role="status">Сохраняем…</p>}
            </>}
        {(error || deliveryError) && <p className="vc-stx-ticket-error" role="alert">{error || deliveryError}</p>}
        {(error || deliveryError) && phase !== "permission" && phase !== "idle" && <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={busy || phase === "loading"} onClick={() => void refreshTicketReminders()}>Повторить проверку</button>}
    </section>;
}
