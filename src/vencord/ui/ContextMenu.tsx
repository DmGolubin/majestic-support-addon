/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect } from "@webpack/common";

import { comboLabel } from "../core/keys";
import { splitGreeting } from "../core/text";
import { addToCompose, insertTemplate, supersede } from "./flow";
import { store, ui } from "./uiState";

/** Approximate menu size: keeps it on screen near the right/bottom edge. */
const MENU_W = 220, MENU_H = 200, EDGE = 8;

export function ContextMenu() {
    const menu = ui.useSelect(s => s.menu);
    useEffect(() => {
        if (!menu) return;
        const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.(".vc-stx-menu")) ui.set({ menu: null }); };
        document.addEventListener("mousedown", close, true);
        return () => document.removeEventListener("mousedown", close, true);
    }, [menu]);
    if (!menu) return null;
    const t = store.byId(menu.id);
    if (!t) return null;
    const bind = store.bindFor(t.id);
    const run = (fn: () => void) => () => { ui.set({ menu: null }); fn(); };
    return (
        <div className="vc-stx-menu" style={{
            left: Math.max(EDGE, Math.min(menu.x, window.innerWidth - MENU_W - EDGE)),
            top: Math.max(EDGE, Math.min(menu.y, window.innerHeight - MENU_H - EDGE)),
        }}>
            <button onClick={run(() => insertTemplate(t))}>Вставить</button>
            {splitGreeting(t.text).greeting && <button onClick={run(() => insertTemplate(t, { noGreeting: true }))}>Вставить без приветствия</button>}
            <button onClick={run(() => addToCompose(t))}>+ в ответ</button>
            <button onClick={run(() => store.toggleFavorite(t.id))}>{store.isFavorite(t.id) ? "Убрать из избранного" : "★ В избранное"}</button>
            <button onClick={run(() => { supersede(); ui.set({ dialog: { kind: "bind", templateId: t.id } }); })}>{bind ? `Изменить клавишу (${comboLabel(bind)})` : "Назначить клавишу…"}</button>
            {bind && <button onClick={run(() => store.clearBind(t.id))}>Снять клавишу</button>}
        </div>
    );
}
