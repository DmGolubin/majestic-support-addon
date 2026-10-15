/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useRef, useState } from "@webpack/common";

import { Settings } from "./Settings";
import { ui } from "./uiState";

export function Management() {
    const root = useRef<HTMLDivElement>(null);
    const dirty = useRef(false);
    const [confirm, setConfirm] = useState(false);
    const close = () => dirty.current ? setConfirm(true) : ui.set({ management: false });
    useEffect(() => {
        const previous = document.activeElement as HTMLElement;
        root.current?.focus();
        const key = (e: KeyboardEvent) => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
            if (e.key === "Tab") {
                const nodes = [...root.current!.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex='0']")].filter(el => el.getClientRects().length);
                const i = nodes.indexOf(document.activeElement as HTMLElement);
                if (i === -1 || (e.shiftKey ? i === 0 : i === nodes.length - 1)) { e.preventDefault(); nodes[e.shiftKey ? nodes.length - 1 : 0]?.focus(); }
            }
            if (!root.current?.contains(e.target as Node)) { e.preventDefault(); root.current?.focus(); }
        };
        document.addEventListener("keydown", key, true);
        return () => { document.removeEventListener("keydown", key, true); if (previous?.isConnected) previous.focus(); };
    }, []);
    return <div className="vc-stx-management-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
        <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Шаблоны и настройки" className="vc-stx-management">
            <header><b>SupportTemplates</b><button className="vc-stx-btn vc-stx-ghost" onClick={close}>Закрыть</button></header>
            {confirm && <div className="vc-stx-local-note" role="alert">Есть несохранённые изменения. <button className="vc-stx-btn vc-stx-ghost" onClick={() => setConfirm(false)}>Вернуться</button><button className="vc-stx-btn" onClick={() => ui.set({ management: false })}>Закрыть без сохранения</button></div>}
            <Settings onDirty={v => { dirty.current = v; }} />
        </div>
    </div>;
}
