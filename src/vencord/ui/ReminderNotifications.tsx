/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import "./reminder-notifications.css";

import { ProjectIcon } from "./ProjectIcon";
import { IconClose } from "./svg";
import { activateReminderNotification, dismissReminderNotification, reminderNotifications } from "./reminderNoticeStore";

export function ReminderNotifications() {
    const { items } = reminderNotifications.use();
    if (!items.length) return null;
    return <aside className="vc-stx-reminder-notices" aria-label="Личные напоминания">
        {items.map(item => {
            const project = item.project === "majestic" ? "mj" : "ro";
            const name = project === "mj" ? "Majestic" : "Россия Онлайн";
            return <section key={item.id} className={`vc-stx-reminder-notice vc-stx-reminder-notice-${project}`} aria-label={`${item.test ? "Тест · " : ""}${name}`}>
                <div className="vc-stx-reminder-notice-message" role="status">
                    <span aria-hidden="true"><ProjectIcon project={project} size={32} /></span>
                    <div><strong>{name}</strong>{item.test && <span className="vc-stx-reminder-test">Тестовое уведомление</span>}
                        <p>Игрок ждёт вашего ответа</p></div>
                </div>
                {item.clickable && <button type="button" className="vc-stx-reminder-open" disabled={item.busy} aria-busy={item.busy}
                    aria-label={`Открыть ${item.test ? "тестовый" : "назначенный"} тикет · ${name}`} onClick={() => void activateReminderNotification(item.id)}>{item.busy ? "Проверяем тикет…" : "Открыть тикет"}</button>}
                {!item.clickable && <small>{item.test ? "Тестовый тикет для этого проекта не задан" : "Переход к тикету недоступен"}</small>}
                {item.error && <p role="alert" className="vc-stx-reminder-error">{item.error}</p>}
                <button type="button" className="vc-stx-reminder-dismiss" aria-label={`Закрыть уведомление · ${name}`} onClick={() => dismissReminderNotification(item.id)}><IconClose size={14} /></button>
            </section>;
        })}
    </aside>;
}
