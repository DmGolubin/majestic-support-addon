// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from "@webpack/common";
import { BuildIdentity } from "./BuildIdentity";
import { DiagnosticControls } from "./DiagnosticControls";
import { panel } from "./panel";
import { ui } from "./uiState";
import "./settings-layout.css";

const phases = {
    idle: "Вход не выполнен", connecting: "Подключение", pending: "Ожидание подтверждения",
    loading: "Загрузка библиотеки", ready: "Подключено", offline: "Нет связи с панелью", error: "Ошибка подключения",
};

export function NativeServiceSettings() {
    const phase = panel.useSelect(state => state.phase);
    const active = !!document.getElementById("vc-stx-host");
    const pendingHost = useRef<HTMLElement | null>(null);
    const [queued, setQueued] = useState(false);
    // Wait for native settings to release focus. A plugin restart cancels the old intent.
    useEffect(() => () => {
        const host = pendingHost.current;
        pendingHost.current = null;
        if (host && document.getElementById("vc-stx-host") === host)
            ui.set({ management: true, windowOpen: false, menu: null, inline: null });
    }, []);
    return <div className="vc-stx-native-settings vc-stx-settings vc-stx-settings-account">
        <BuildIdentity />
        <div className="vc-stx-settings-sections">
            <section className="vc-stx-setting-section vc-stx-setting-card" aria-label="Подключение">
                <div className="vc-stx-account-summary"><div>
                    <strong>Подключение</strong>
                    <p className="vc-stx-connection-state" role="status">{active ? phases[phase] : "Плагин выключен"}</p>
                </div></div>
                <p>Шаблоны, звук и параметры работы находятся в основном окне SupportTemplates.</p>
                <button type="button" className="vc-stx-btn" disabled={!active || queued} onClick={() => {
                    const host = document.getElementById("vc-stx-host");
                    if (!host || pendingHost.current) return;
                    pendingHost.current = host;
                    setQueued(true);
                }}>Перейти в SupportTemplates</button>
                {queued && <p role="status">Закройте настройки Discord — откроется SupportTemplates.</p>}
            </section>
            <DiagnosticControls available={active} />
        </div>
    </div>;
}
