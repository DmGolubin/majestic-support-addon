/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { connectDemo, demo, disableDemo, enableDemo, pauseDemo } from "./demo";

export function DemoConnection() {
    const d = demo.use();
    const labels: Record<string, string> = { loading: "Загружаем шаблоны…", "load-error": "Повторяем загрузку библиотеки", idle: "Не подключён", connecting: "Подключение…", pending: "Ожидаем подтверждение", ready: "Библиотека загружена", denied: "Вы отказали в доступе", expired: "Код истёк", revoked: "Устройство отозвано", offline: "Нет связи" };
    return <section><h3>Подключение к панели</h3>
        <p className="vc-stx-local-note">API настоящей панели ещё не подключён. Деморежим использует отдельную тестовую библиотеку в памяти. Обычные шаблоны и настройки сохраняются; тестовые правки исчезнут после выхода или перезагрузки Discord.</p>
        {!d.enabled ? <button className="vc-stx-btn" onClick={() => enableDemo()}>Включить деморежим</button> : <>
            <h4>ДЕМО · {labels[d.phase]}</h4>
            {d.error && <p role="alert">{d.error}</p>}
            {d.phase === "pending" && <p>Код устройства: <b>{d.code}</b>. Откройте локальную страницу и нажмите «Разрешить» или «Отказать». Срок — 10 минут.</p>}
            {d.phase === "ready" && <p role="status">Тестовый саппорт · FAQ версии {d.revision}. Закройте настройки и откройте обычное окно шаблонов. На странице демосервера можно изменить FAQ от имени старшего.</p>}
            <div className="vc-stx-lib-actions">
                {["idle", "denied", "expired", "revoked"].includes(d.phase) && <button className="vc-stx-btn" onClick={() => void connectDemo()}>Начать вход</button>}
                {d.url && <a className="vc-stx-btn" href={d.url} target="_blank" rel="noreferrer">Открыть локальную панель</a>}
                {["ready", "offline"].includes(d.phase) && d.url && <button className="vc-stx-btn vc-stx-ghost" onClick={pauseDemo}>{d.paused ? "Восстановить связь" : "Приостановить связь"}</button>}
                <button className="vc-stx-btn vc-stx-ghost" onClick={disableDemo}>Выйти из деморежима</button>
            </div>
            <p className="vc-stx-muted">Изменения FAQ проверяются раз в 2 секунды. Это демонстрационный опрос, не готовая SSE-интеграция. Личные шаблоны и папки можно тестировать в соседней вкладке; они пока не передаются даже на демосервер.</p>
        </>}
    </section>;
}
