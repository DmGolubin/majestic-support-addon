/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { authorizePanelReminders } from "./panel";
import { refreshTicketReminders, setDiscordReminders, ticketRemindersState } from "./ticketReminders";

export function ReminderSettings() {
    const { phase, settings, busy, error, deliveryError } = ticketRemindersState.use();
    const ready = phase === "ready" && !!settings;
    return <section className="vc-stx-setting-section vc-stx-ticket-section" aria-label="Игрок ждёт ответа">
        <header className="vc-stx-ticket-heading">
            <svg className="vc-stx-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            <h3>Игрок ждёт ответа</h3>
        </header>
        {phase === "idle" ? <p className="vc-stx-muted">Войдите в аккаунт панели, чтобы подключить личные напоминания.</p>
            : phase === "permission" ? <>
                <p className="vc-stx-muted">Разрешите панели передавать назначенные вам тикеты и настройки напоминаний.</p>
                <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => void authorizePanelReminders()}>Подключить напоминания</button>
            </> : <>
                <label className="vc-stx-check"><input type="checkbox" checked={settings?.discordEnabled ?? false} disabled={!ready || busy} onChange={e => void setDiscordReminders(e.currentTarget.checked)} />Напоминать в Discord</label>
                {phase === "loading" && <p className="vc-stx-muted" role="status">Загружаем настройки…</p>}
                {!!settings?.projects.length && <p className="vc-stx-muted">{settings.projects.map(p => `${p.project === "majestic" ? "Majestic" : "Россия Онлайн"} — ${p.personalReminderMinutes} мин`).join(" · ")}. Порог меняется в Telegram.</p>}
                <p className="vc-stx-muted">Звук и громкость — выбранные выше. Напоминания приходят только по назначенным вам тикетам.</p>
                {busy && <p className="vc-stx-muted" role="status">Сохраняем…</p>}
            </>}
        {(error || deliveryError) && <p className="vc-stx-ticket-error" role="alert">{error || deliveryError}</p>}
        {(error || deliveryError) && phase !== "permission" && phase !== "idle" && <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={busy || phase === "loading"} onClick={() => void refreshTicketReminders()}>Повторить проверку</button>}
    </section>;
}
