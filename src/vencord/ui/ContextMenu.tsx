/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect } from "@webpack/common";

import { comboLabel } from "../core/keys";
import { splitGreeting } from "../core/text";
import { dlog } from "./debug";
import { addToCompose, insertTemplate, supersede } from "./flow";
import { IconStar } from "./svg";
import { store, ui } from "./uiState";

/** Approximate menu size: keeps it on screen near the right/bottom edge. */
const MENU_W = 220, MENU_H = 200, EDGE = 8;

/** The menu just closed by a press on its own row's right button: the contextmenu that follows must not reopen it. */
let closedByPress: { id: string; at: number; } | null = null;

/** Right click on a row: opens the menu there; on the row whose menu was open it only closes it (toggle). */
export function openMenu(id: string, x: number, y: number) {
    const c = closedByPress;
    closedByPress = null;
    if (c && c.id === id && performance.now() - c.at < 1000) return;
    ui.set({ menu: { x, y, id } });
}

/** One click after an outside press that closed the menu: swallowed inside the window, so a left click
 *  that only means "close the menu" never inserts the template under it. Clicks elsewhere reach Discord. */
function swallowNextClickInWindow() {
    const eat = (e: MouseEvent) => {
        document.removeEventListener("click", eat, true);
        if ((e.target as HTMLElement).closest?.(".vc-stx-win")) { e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener("click", eat, true);
    setTimeout(() => document.removeEventListener("click", eat, true), 1000);
}

export function ContextMenu() {
    const menu = ui.useSelect(s => s.menu);
    useEffect(() => {
        if (!menu) return;
        const close = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest?.(".vc-stx-menu")) return;
            if (e.button === 2) {
                // Right press on the same row: close, and the following contextmenu must not reopen it.
                const row = target.closest?.(".vc-stx-it.ctx");
                closedByPress = row ? { id: menu.id, at: performance.now() } : null;
            } else if (e.button === 0) swallowNextClickInWindow();
            ui.set({ menu: null });
        };
        const esc = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            ui.set({ menu: null });
        };
        document.addEventListener("mousedown", close, true);
        document.addEventListener("keydown", esc, true);
        return () => { document.removeEventListener("mousedown", close, true); document.removeEventListener("keydown", esc, true); };
    }, [menu]);
    if (!menu) return null;
    const t = store.byId(menu.id);
    if (!t) return null;
    const bind = store.bindFor(t.id);
    const run = (fn: () => void) => () => { ui.set({ menu: null }); fn(); };
    return (
        // Menu buttons never take focus: it stays in the window's search input after the menu closes.
        <div className="vc-stx-menu" onMouseDown={e => e.preventDefault()} style={{
            left: Math.max(EDGE, Math.min(menu.x, window.innerWidth - MENU_W - EDGE)),
            top: Math.max(EDGE, Math.min(menu.y, window.innerHeight - MENU_H - EDGE)),
        }}>
            <button onClick={run(() => insertTemplate(t, { via: "menu" }))}>Вставить</button>
            {splitGreeting(t.text).greeting && <button onClick={run(() => insertTemplate(t, { noGreeting: true, via: "menu" }))}>Вставить без приветствия</button>}
            <button onClick={run(() => addToCompose(t))}>+ в ответ</button>
            <button onClick={run(() => store.toggleFavorite(t.id))}><IconStar size={14} filled={!store.isFavorite(t.id)} />{store.isFavorite(t.id) ? "Убрать из избранного" : "В избранное"}</button>
            <button onClick={run(() => { supersede(); dlog("dialog-open", { kind: "bind", id: t.id }); ui.set({ dialog: { kind: "bind", templateId: t.id } }); })}>{bind ? `Изменить клавишу (${comboLabel(bind)})` : "Назначить клавишу…"}</button>
            {bind && <button onClick={run(() => store.clearBind(t.id))}>Снять клавишу</button>}
        </div>
    );
}
