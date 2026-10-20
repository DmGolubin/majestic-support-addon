// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from "@webpack/common";
import { BuildIdentity } from "./BuildIdentity";
import { DiagnosticControls } from "./DiagnosticControls";
import { panel } from "./panel";
import { ui } from "./uiState";
import "./host-settings.css";

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
    return <div className="vc-stx-native-settings vc-stx-host-settings">
        <BuildIdentity />
        <div className="vc-stx-host-action">
            <button type="button" className="vc-stx-btn" disabled={!active || queued} onClick={() => {
                const host = document.getElementById("vc-stx-host");
                if (!host || pendingHost.current) return;
                pendingHost.current = host;
                setQueued(true);
            }}>Открыть SupportTemplates</button>
            {(!active || phase !== "ready") && <span role="status">{active ? phases[phase] : "Плагин выключен"}</span>}
        </div>
        {queued && <p className="vc-stx-host-handoff" role="status">Закройте настройки Discord — откроется SupportTemplates.</p>}
        <DiagnosticControls available={active} />
    </div>;
}
