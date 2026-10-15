/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useRef } from "@webpack/common";

import { connectDemo, demo, disableDemo, enableDemo, pauseDemo } from "./demo";
import { captureWindowTarget, windowEditor } from "./op";
import { ui, useChatRect } from "./uiState";

export function LoginWindow() {
    const d = demo.use();
    const ref = useRef<HTMLDivElement>(null);
    const rect = useChatRect(true, windowEditor);
    const width = Math.min(400, innerWidth - 16);
    const bottom = Math.max(8, Math.min(innerHeight - 160, rect ? innerHeight - rect.top + 8 : 80));
    const waiting = d.phase === "connecting" || d.phase === "pending";
    useEffect(() => {
        ref.current?.focus();
        const outside = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) ui.set({ windowOpen: false }); };
        document.addEventListener("mousedown", outside);
        return () => document.removeEventListener("mousedown", outside);
    }, []);
    const login = () => { if (!d.enabled) enableDemo(true); void connectDemo(true); };
    return <div ref={ref} tabIndex={-1} role="dialog" aria-label="Вход в SupportTemplates" className="vc-stx-login"
        style={{ width, right: Math.max(8, Math.min(innerWidth - width - 8, rect ? innerWidth - rect.right : 16)), bottom, maxHeight: innerHeight - bottom - 8 }}
        onKeyDown={e => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ui.set({ windowOpen: false }); }
            if (e.key === "Tab") {
                const nodes = [...ref.current!.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]")];
                const i = nodes.indexOf(document.activeElement as HTMLElement);
                if (i < 0 || (e.shiftKey ? i === 0 : i === nodes.length - 1)) { e.preventDefault(); nodes[e.shiftKey ? nodes.length - 1 : 0]?.focus(); }
            }
        }}>
        <div className="vc-stx-lib-title"><b>SupportTemplates</b><button className="vc-stx-btn vc-stx-ghost" onClick={() => ui.set({ windowOpen: false })}>Закрыть</button></div>
        <h2>Шаблоны вашего аккаунта</h2>
        <p>Подключите панель, чтобы получить актуальные FAQ и свою личную библиотеку.</p>
        <p className="vc-stx-local-note">Демонстрационный вход: откроется локальная страница подтверждения. Обычные данные сохранены.</p>
        {d.error && <p role="alert">{d.error}</p>}
        {d.phase === "denied" && <p role="status">Вы отказали в доступе. Можно попробовать снова.</p>}
        {d.phase === "revoked" && <p role="status">Устройство отозвано. Войдите снова.</p>}
        {d.phase === "expired" && <p role="status">Код истёк. Начните вход заново.</p>}
        {d.phase === "pending" && <p role="status">Код: <b>{d.code}</b>. Подтвердите доступ в браузере — шаблоны появятся здесь автоматически.</p>}
        <div className="vc-stx-login-actions">
            <button className="vc-stx-btn" disabled={waiting} onClick={login}>{waiting ? "Ожидаем подтверждение…" : "Войти через панель"}</button>
            {d.url && <a href={d.url} target="_blank" rel="noreferrer">Открыть страницу подтверждения ещё раз</a>}
            {d.paused && <button className="vc-stx-btn vc-stx-ghost" onClick={pauseDemo}>Восстановить связь</button>}
            <button className="vc-stx-btn vc-stx-ghost" onClick={() => { const editor = windowEditor(); disableDemo(); captureWindowTarget(editor); ui.set({ windowOpen: true }); }}>Вернуться к локальной библиотеке</button>
        </div>
    </div>;
}
