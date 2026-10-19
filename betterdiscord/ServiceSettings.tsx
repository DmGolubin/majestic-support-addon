// SPDX-License-Identifier: GPL-3.0-or-later
import { DiagnosticControls } from "../src/vencord/ui/DiagnosticControls";
import { panel } from "../src/vencord/ui/panel";
import { ui } from "../src/vencord/ui/uiState";
import { React, useEffect, useRef, useState } from "./shims/common";

const phases = { idle: "Вход не выполнен", connecting: "Подключение", pending: "Ожидание подтверждения", loading: "Загрузка библиотеки", ready: "Подключено", offline: "Нет связи с панелью", error: "Ошибка подключения" };
export function ServiceSettings({ active }: { active: boolean; }) {
    const p = panel.useSelect(s => s.phase);
    const pending = useRef(false);
    const [queued, setQueued] = useState(false);
    // Do not fight Discord's native modal focus trap or close unrelated dialogs.
    // Opening after this panel unmounts works with native BD Done/Escape alike.
    useEffect(() => () => {
        if (pending.current && document.getElementById("vc-stx-host")) ui.set({ management: true, windowOpen: false, menu: null, inline: null });
    }, []);
    return <div className="stx-bd-service">
        <section className="stx-bd-service-card">
            <div className="stx-bd-service-status"><strong>Подключение</strong><span role="status">{active ? phases[p] : "Плагин выключен"}</span></div>
            <p>Шаблоны, звук и параметры работы находятся в основном окне SupportTemplates.</p>
            <button type="button" className="vc-stx-btn" disabled={!active || queued} onClick={() => { pending.current = true; setQueued(true); }}>Перейти в SupportTemplates</button>
            {queued && <p role="status">Нажмите Done (Готово) внизу этого окна — откроется SupportTemplates.</p>}
        </section>
        <DiagnosticControls available={active} />
    </div>;
}
