/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect } from "@webpack/common";

import { comboLabel } from "../core/keys";
import { splitGreeting } from "../core/text";
import { addToCompose, insertTemplate } from "./flow";
import { store, ui } from "./uiState";

export function ContextMenu() {
    const { menu } = ui.use();
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
        <div className="vc-stx-menu" style={{ left: menu.x, top: menu.y }}>
            <button onClick={run(() => insertTemplate(t))}>Вставить</button>
            {splitGreeting(t.text).greeting && <button onClick={run(() => insertTemplate(t, { noGreeting: true }))}>Вставить без приветствия</button>}
            <button onClick={run(() => addToCompose(t))}>+ в ответ</button>
            <button onClick={run(() => store.toggleFavorite(t.id))}>{store.isFavorite(t.id) ? "Убрать из избранного" : "★ В избранное"}</button>
            <button onClick={run(() => ui.set({ dialog: { kind: "bind", templateId: t.id } }))}>{bind ? `Изменить клавишу (${comboLabel(bind)})` : "Назначить клавишу…"}</button>
            {bind && <button onClick={run(() => store.clearBind(t.id))}>Снять клавишу</button>}
        </div>
    );
}
