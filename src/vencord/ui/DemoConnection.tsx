/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { connectDemo, demo, disableDemo, enableDemo, pauseDemo } from "./demo";

export function DemoConnection() {
    const d = demo.use();
    const labels: Record<string, string> = { loading: "Загружаем шаблоны…", "load-error": "Повторяем загрузку библиотеки", idle: "Не подключён", connecting: "Подключение…", pending: "Ожидаем подтверждение", ready: "Библиотека загружена", denied: "Вы отказали в доступе", expired: "Код истёк", revoked: "Устройство отозвано", offline: "Нет связи" };
    return <section className="vc-stx-setting-section"><h3>Аккаунт и синхронизация</h3>
        <p className="vc-stx-muted">Демо · изменения сохраняются до выхода или перезагрузки.</p>
        {!d.enabled ? <button className="vc-stx-btn" onClick={() => { enableDemo(); void connectDemo(true); }}>Войти через панель</button> : <>
            <div className={"vc-stx-connection-state " + (d.phase === "ready" ? "ready" : "")} role="status"><span />{labels[d.phase]}</div>
            {d.error && <p role="alert">{d.error}</p>}
            {d.phase === "pending" && <p>Код подключения: <b>{d.code}</b></p>}
            {d.phase === "ready" && <p role="status">Версия библиотеки: {d.revision}</p>}
            <div className="vc-stx-lib-actions">
                {["idle", "denied", "expired", "revoked"].includes(d.phase) && <button className="vc-stx-btn" onClick={() => void connectDemo(true)}>Начать вход</button>}
                {d.url && <a className="vc-stx-btn" href={d.url} target="_blank" rel="noreferrer">Открыть панель</a>}
                {d.paused && <button className="vc-stx-btn vc-stx-ghost" onClick={pauseDemo}>Восстановить связь</button>}
                <button className="vc-stx-btn vc-stx-ghost" onClick={disableDemo}>Выйти из деморежима</button>
            </div>
            <p className="vc-stx-muted">Личные шаблоны пока не синхронизируются с панелью.</p>
        </>}
    </section>;
}
