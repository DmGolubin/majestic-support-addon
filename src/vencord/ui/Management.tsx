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
    const confirming = useRef(false);
    const confirmButton = useRef<HTMLButtonElement>(null);
    const draftFocus = useRef<HTMLElement | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState(false);
    confirming.current = confirm;
    const returnToDraft = () => {
        if (busyRef.current) return;
        setConfirm(false);
        const target = draftFocus.current;
        if (target?.isConnected && root.current?.contains(target)) target.focus({ preventScroll: true });
        else root.current?.focus({ preventScroll: true });
    };
    const close = () => {
        if (busyRef.current) return;
        if (dirty.current) {
            if (!confirming.current) draftFocus.current = document.activeElement as HTMLElement;
            setConfirm(true);
        } else ui.set({ management: false });
    };
    useEffect(() => { if (confirm) confirmButton.current?.focus(); }, [confirm]);
    useEffect(() => {
        const previous = document.activeElement as HTMLElement;
        const element = root.current;
        element?.focus();
        const key = (e: KeyboardEvent) => {
            // Nonmodal: Discord owns keys while the user is working in chat.
            if (!element?.contains(e.target as Node)) return;
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === "Escape" && (e.target as HTMLElement)?.closest("[data-stx-select-open]")) return;
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (confirming.current) returnToDraft(); else close(); }
        };
        document.addEventListener("keydown", key, true);
        return () => {
            document.removeEventListener("keydown", key, true);
            if (previous?.isConnected && (element?.contains(document.activeElement) || document.activeElement === document.body)) previous.focus();
        };
    }, []);
    return <div className="vc-stx-management-backdrop" onMouseDown={e => {
        if (e.button === 0 && e.target === e.currentTarget) close();
    }}>
        <div ref={root} tabIndex={-1} role="dialog" aria-label="Шаблоны и настройки" className="vc-stx-management">
            <header><b>SupportTemplates</b><button className="vc-stx-btn vc-stx-ghost" disabled={busy} onClick={close}>Закрыть</button></header>
            {confirm && <div className="vc-stx-local-note vc-stx-close-confirm" role="alert"><span>Есть несохранённые изменения.</span><div className="vc-stx-close-actions"><button ref={confirmButton} className="vc-stx-btn vc-stx-ghost" disabled={busy} onClick={returnToDraft}>Вернуться</button><button className="vc-stx-btn" disabled={busy} onClick={() => { if (!busyRef.current) { discardPanelDraft(); ui.set({ management: false }); } }}>Закрыть без сохранения</button></div></div>}
            <Settings onDirty={v => { dirty.current = v; if (!v) setConfirm(false); }} onBusy={v => { busyRef.current = v; setBusy(v); }} />
        </div>
    </div>;
}
