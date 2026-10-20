// SPDX-License-Identifier: GPL-3.0-or-later
import { DiagnosticControls } from "../src/vencord/ui/DiagnosticControls";
import { panel } from "../src/vencord/ui/panel";
import { ui } from "../src/vencord/ui/uiState";
import { React, useEffect, useRef, useState } from "./shims/common";
import "../src/vencord/ui/host-settings.css";

const phases = { idle: "Вход не выполнен", connecting: "Подключение", pending: "Ожидание подтверждения", loading: "Загрузка библиотеки", ready: "Подключено", offline: "Нет связи с панелью", error: "Ошибка подключения" };
export function ServiceSettings({ active }: { active: boolean; }) {
    const p = panel.useSelect(s => s.phase);
    const pending = useRef<HTMLElement | null>(null);
    const [queued, setQueued] = useState(false);
    // Do not fight Discord's native modal focus trap or close unrelated dialogs.
    // Opening after this panel unmounts works with native BD Done/Escape alike.
    useEffect(() => () => {
        const host = pending.current;
        pending.current = null;
        if (host && document.getElementById("vc-stx-host") === host) ui.set({ management: true, windowOpen: false, menu: null, inline: null });
    }, []);
    return <div className="stx-bd-service vc-stx-host-settings">
        <div className="vc-stx-host-action">
            <button type="button" className="vc-stx-btn" disabled={!active || queued} onClick={() => {
                const host = document.getElementById("vc-stx-host");
                if (!active || !host || pending.current) return;
                pending.current = host; setQueued(true);
            }}>Открыть SupportTemplates</button>
            {(!active || p !== "ready") && <span role="status">{active ? phases[p] : "Плагин выключен"}</span>}
        </div>
        {queued && <p className="vc-stx-host-handoff" role="status">Нажмите Done (Готово) внизу этого окна — откроется SupportTemplates.</p>}
        <DiagnosticControls available={active} />
    </div>;
}
