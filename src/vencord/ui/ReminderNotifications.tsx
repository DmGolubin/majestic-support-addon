/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import "./reminder-notifications.css";

import { useEffect, useRef } from "@webpack/common";

import { ProjectIcon } from "./ProjectIcon";
import { IconArrowUpRight, IconChevron, IconClose } from "./svg";
import { activateReminderNotification, dismissReminderNotificationGroup, reminderNotifications,
    setReminderNotificationInteraction, toggleReminderNotificationGroup } from "./reminderNoticeStore";

function countLabel(count: number) {
    const last = count % 10, teen = count % 100 >= 11 && count % 100 <= 14;
    return `${count} ${!teen && last === 1 ? "тикет ждёт" : !teen && last >= 2 && last <= 4 ? "тикета ждут" : "тикетов ждут"} ответа`;
}
const waitingLabel = (minutes: number) => minutes < 1 ? "Меньше минуты" : `${minutes} мин`;

export function ReminderNotifications() {
    const { items, expanded } = reminderNotifications.use();
    const root = useRef<HTMLElement>(null);
    // A keyed row can disappear without a blur event (expiry, dedup, successful
    // navigation). Never keep its group's expiration paused by stale focus.
    useEffect(() => {
        const active = root.current?.ownerDocument.activeElement;
        for (const project of ["majestic", "russia-online"] as const) {
            const group = root.current?.querySelector(`[data-reminder-project="${project}"]`);
            setReminderNotificationInteraction(project, "focus", !!active && !!group?.contains(active));
        }
    }, [items]);
    if (!items.length) return null;
    const projects = ["majestic", "russia-online"] as const;
    return <aside ref={root} className="vc-stx-reminder-notices" aria-label="Личные напоминания">
        {projects.map(project => {
            const rows = items.filter(item => item.project === project)
                .sort((a, b) => (a.waitingOrder ?? Infinity) - (b.waitingOrder ?? Infinity) || a.id - b.id);
            if (!rows.length) return null;
            const icon = project === "majestic" ? "mj" : "ro", name = icon === "mj" ? "Majestic" : "Россия Онлайн";
            const single = rows.length === 1 ? rows[0] : null, test = rows.every(row => row.test);
            const open = !single && expanded[project] === true;
            const listId = `vc-stx-reminder-list-${project}`;
            const timed = rows.every(row => row.waitingMinutes !== null);
            const title = single ? single.ticketLabel === "Тикет" ? "Игрок ждёт вашего ответа" : `${single.ticketLabel} ждёт ответа` : countLabel(rows.length);
            const subtitle = single?.busy ? "Проверяем тикет…" : test ? "Тестовое уведомление"
                : single ? single.waitingMinutes === null ? "Назначен вам" : `${waitingLabel(single.waitingMinutes)} · ваш тикет`
                    : timed ? `Дольше всего — ${waitingLabel(rows[0].waitingMinutes!)}` : "Назначены вам";
            const content = <>
                <span className="vc-stx-reminder-icon" aria-hidden="true"><ProjectIcon project={icon} size={32} /></span>
                <span className="vc-stx-reminder-copy" role="status">
                    <span className="vc-stx-reminder-server">{name}</span>
                    <strong className="vc-stx-reminder-title" title={title}>{title}</strong>
                    <span className={test ? "vc-stx-reminder-test" : "vc-stx-reminder-meta"}>{subtitle}</span>
                </span>
                {(!single || single.clickable) && <span className="vc-stx-reminder-arrow" aria-hidden="true">
                    {single ? <IconArrowUpRight size={16} /> : <IconChevron size={16} open />}
                </span>}
            </>;
            return <section key={project} data-reminder-project={project} className={`vc-stx-reminder-notice vc-stx-reminder-notice-${icon}`} aria-label={`${test ? "Тест · " : ""}${name}`}
                onPointerEnter={() => setReminderNotificationInteraction(project, "pointer", true)}
                onPointerLeave={() => setReminderNotificationInteraction(project, "pointer", false)}
                onFocusCapture={() => setReminderNotificationInteraction(project, "focus", true)}
                onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setReminderNotificationInteraction(project, "focus", false); }}
                onKeyDown={event => {
                    if (event.key !== "Escape" || !open) return;
                    event.preventDefault(); event.stopPropagation();
                    toggleReminderNotificationGroup(project);
                    event.currentTarget.querySelector<HTMLButtonElement>(".vc-stx-reminder-toggle")?.focus({ preventScroll: true });
                }}>
                <div className="vc-stx-reminder-header">
                    {!single ? <button type="button" className="vc-stx-reminder-toggle" aria-expanded={open} aria-controls={listId}
                        aria-label={`${open ? "Свернуть" : "Раскрыть"} список тикетов · ${name}`}
                        onClick={() => toggleReminderNotificationGroup(project)}>{content}</button>
                        : single.clickable ? <button type="button" className="vc-stx-reminder-open" disabled={single.busy} aria-busy={single.busy}
                            aria-label={`Открыть ${single.test ? "тестовый" : "назначенный"} тикет · ${name}`} data-reminder-id={single.id}
                            onClick={() => void activateReminderNotification(single.id)}>{content}</button>
                            : <div className="vc-stx-reminder-summary">{content}</div>}
                    <button type="button" className="vc-stx-reminder-dismiss" aria-label={`Закрыть уведомление · ${name}`}
                        onClick={() => dismissReminderNotificationGroup(project)}><IconClose size={14} /></button>
                </div>
                {single && !single.clickable && <small className="vc-stx-reminder-unavailable">{single.test ? "Тестовый тикет для этого проекта не задан" : "Переход к тикету недоступен"}</small>}
                {single?.error && <p role="alert" className="vc-stx-reminder-error">{single.error}</p>}
                {!single && <div id={listId} hidden={!open}>
                    {open && <ul className="vc-stx-reminder-list" aria-label={`Назначенные тикеты · ${name}`}>
                        {rows.map((item, index) => <li key={item.id}>
                            <button type="button" className="vc-stx-reminder-open" disabled={!item.clickable || item.busy} aria-busy={item.busy}
                                aria-label={`Открыть ${item.ticketLabel === "Тикет" ? `тикет ${index + 1}` : item.ticketLabel} · ${name}${item.test ? " · Тест" : ""}`}
                                data-reminder-id={item.id} onClick={() => void activateReminderNotification(item.id)}>
                                <span className="vc-stx-reminder-ticket-label" title={item.ticketLabel}>{item.ticketLabel === "Тикет" ? `Тикет ${index + 1}` : item.ticketLabel}</span>
                                <span className="vc-stx-reminder-wait">{item.busy ? "Проверяем…" : item.test ? "Тест" : item.waitingMinutes !== null ? waitingLabel(item.waitingMinutes) : "Ждёт ответа"}</span>
                                <span className="vc-stx-reminder-row-arrow" aria-hidden="true"><IconArrowUpRight size={16} /></span>
                            </button>
                            {!item.clickable && <small className="vc-stx-reminder-unavailable">{item.test ? "Тестовый тикет для этого проекта не задан" : "Переход к тикету недоступен"}</small>}
                            {item.error && <p role="alert" className="vc-stx-reminder-error">{item.error}</p>}
                        </li>)}
                    </ul>}
                </div>}
            </section>;
        })}
    </aside>;
}
