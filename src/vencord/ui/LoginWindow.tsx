/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useRef } from "@webpack/common";

import { cancelDemoLogin, connectDemo, demo, disableDemo, enableDemo, pauseDemo } from "./demo";
import { captureWindowTarget, windowEditor } from "./op";
import { ui, useChatRect } from "./uiState";

export function LoginWindow() {
    const d = demo.use();
    const ref = useRef<HTMLDivElement>(null);
    const rect = useChatRect(true, windowEditor);
    const width = Math.min(400, innerWidth - 16);
    const bottom = Math.max(8, Math.min(innerHeight - 160, rect ? innerHeight - rect.top + 8 : 80));
    const loading = d.phase === "loading" || d.phase === "load-error";
    const waiting = d.phase === "connecting" || d.phase === "pending" || (d.phase === "offline" && !!d.url);
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
        {loading ? <section key="loading" className="vc-stx-login-scene vc-stx-load-scene" aria-labelledby="vc-stx-load-heading" aria-busy={d.phase === "loading"}>
            <div className="vc-stx-login-progress" role="status"><span className="vc-stx-login-spinner" aria-hidden="true" />Вход подтверждён</div>
            <h2 id="vc-stx-load-heading">{d.phase === "load-error" ? "Не удалось загрузить шаблоны" : "Загружаем шаблоны"}</h2>
            <p className="vc-stx-login-copy">Получаем библиотеку аккаунта. Меню откроется автоматически, когда всё будет готово.</p>
            {d.phase === "load-error" ? <p role="alert">Проверяем связь и повторяем загрузку. Можно отменить и войти позже.</p> : <div className="vc-stx-load-placeholder" aria-hidden="true"><span /><span /><span /></div>}
            <div className="vc-stx-login-actions"><button className="vc-stx-btn vc-stx-ghost" onClick={cancelDemoLogin}>Отмена</button></div>
        </section> : waiting ? <section key="waiting" className="vc-stx-login-scene" aria-labelledby="vc-stx-login-heading">
            <div className="vc-stx-login-progress" role="status"><span className="vc-stx-login-spinner" aria-hidden="true" />{d.phase === "offline" ? "Восстанавливаем связь" : d.code ? "Ожидаем подтверждение" : "Открываем панель"}</div>
            <h2 id="vc-stx-login-heading">Подтвердите вход</h2>
            <p className="vc-stx-login-copy">Нажмите «Разрешить» на панели. После этого здесь появятся ваши шаблоны.</p>
            {d.code && <div className="vc-stx-login-code"><span>Код подключения</span><strong>{d.code}</strong><small>Сверьте его с кодом на странице панели.</small></div>}
            {d.error && <p role="alert">{d.error}</p>}
            <div className="vc-stx-login-actions">
                {d.url && <><a className="vc-stx-btn" href={d.url} target="_blank" rel="noreferrer">Открыть панель повторно</a><small className="vc-stx-login-help">Если вкладка не открылась или вы случайно её закрыли.</small></>}
                {d.paused && <button className="vc-stx-btn vc-stx-ghost" onClick={pauseDemo}>Восстановить связь</button>}
                <button className="vc-stx-btn vc-stx-ghost" onClick={cancelDemoLogin}>Отмена</button>
            </div>
        </section> : <section key="entry" className="vc-stx-login-scene">
            <h2>Ваши шаблоны — под рукой</h2>
            <p className="vc-stx-login-copy">Подключите аккаунт панели.</p>
            {d.error && <p role="alert">{d.error}</p>}
            {d.phase === "denied" && <p role="status">Вы отказали в доступе. Можно попробовать снова.</p>}
            {d.phase === "revoked" && <p role="status">Устройство отозвано. Войдите снова.</p>}
            {d.phase === "expired" && <p role="status">Код истёк. Начните вход заново.</p>}
            <div className="vc-stx-login-actions"><button className="vc-stx-btn" onClick={login}>Войти через панель</button></div>
        </section>}
        <footer className="vc-stx-login-demo"><span>Демо · локальная панель</span>{!waiting && !loading && <button onClick={() => { const editor = windowEditor(); disableDemo(); captureWindowTarget(editor); ui.set({ windowOpen: true }); }}>К локальной библиотеке</button>}</footer>
    </div>;
}
