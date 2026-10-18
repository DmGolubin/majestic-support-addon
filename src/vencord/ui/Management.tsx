/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useRef, useState } from "@webpack/common";

import { Settings } from "./Settings";
import { discardPanelDraft } from "./PanelPersonalLibrary";
import { ui } from "./uiState";

export function Management() {
    const root = useRef<HTMLDivElement>(null);
    const dirty = useRef(false);
    const busyRef = useRef(false);
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const close = () => { if (!busyRef.current) { if (dirty.current) setConfirm(true); else ui.set({ management: false }); } };
    useEffect(() => {
        const previous = document.activeElement as HTMLElement;
        root.current?.focus();
        const key = (e: KeyboardEvent) => {
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === "Escape" && (e.target as HTMLElement)?.closest("[data-stx-select-open]")) return;
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
            <header><b>SupportTemplates</b><button className="vc-stx-btn vc-stx-ghost" disabled={busy} onClick={close}>Закрыть</button></header>
            {confirm && <div className="vc-stx-local-note vc-stx-close-confirm" role="alert"><span>Есть несохранённые изменения.</span><div className="vc-stx-close-actions"><button className="vc-stx-btn vc-stx-ghost" disabled={busy} onClick={() => { if (!busyRef.current) setConfirm(false); }}>Вернуться</button><button className="vc-stx-btn" disabled={busy} onClick={() => { if (!busyRef.current) { discardPanelDraft(); ui.set({ management: false }); } }}>Закрыть без сохранения</button></div></div>}
            <Settings onDirty={v => { dirty.current = v; if (!v) setConfirm(false); }} onBusy={v => { busyRef.current = v; setBusy(v); }} />
        </div>
    </div>;
}
