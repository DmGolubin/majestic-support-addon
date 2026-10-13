/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";

import { comboLabel } from "../core/keys";
import { splitGreeting } from "../core/text";
import { Template } from "../core/types";
import { dlog } from "./debug";
import { addToCompose, insertTemplate, supersede } from "./flow";
import { latchKey } from "./keylatch";
import { IconStar } from "./svg";
import { store, ui } from "./uiState";

const EDGE = 8;

// ---- Pointer gestures that close the menu must not also act ----
// A press outside the menu closes it; the click / contextmenu that ends the same gesture is swallowed
// (one-shot, removed when it fires or at the next press — never by a timer, so a slow release is safe).

const pendingGuards = new Set<() => void>();

function swallowEndOfGesture(type: "click" | "contextmenu", onlyInWindow: boolean) {
    const eat = (e: MouseEvent) => {
        done();
        if (onlyInWindow && !(e.target as HTMLElement).closest?.(".vc-stx-win")) return;
        e.preventDefault();
        e.stopPropagation();
    };
    const done = () => {
        document.removeEventListener(type, eat, true);
        document.removeEventListener("mousedown", done, true);
        pendingGuards.delete(done);
    };
    document.addEventListener(type, eat, true);
    // The next press (not this one, still dispatching) ends the guard if the gesture never produced the event.
    setTimeout(() => { if (pendingGuards.has(done)) document.addEventListener("mousedown", done, true); }, 0);
    pendingGuards.add(done);
}

/** Plugin stop: no guard may outlive it. */
export function resetMenuGuards() {
    for (const done of [...pendingGuards]) done();
}

/** Right click on a row: opens the menu there. */
export function openMenu(id: string, x: number, y: number) {
    ui.set({ menu: { x, y, id } });
}

interface Item { key: string; label: React.ReactNode; run: () => void; }

function itemsFor(t: Template): Item[] {
    const bind = store.bindFor(t.id);
    const fav = store.isFavorite(t.id);
    const items: Item[] = [{ key: "insert", label: "Вставить", run: () => void insertTemplate(t, { via: "menu" }) }];
    if (splitGreeting(t.text).greeting) items.push({ key: "nogreet", label: "Вставить без приветствия", run: () => void insertTemplate(t, { noGreeting: true, via: "menu" }) });
    items.push({ key: "compose", label: "+ в ответ", run: () => void addToCompose(t) });
    items.push({ key: "fav", label: <><IconStar size={14} filled={!fav} />{fav ? "Убрать из избранного" : "В избранное"}</>, run: () => store.toggleFavorite(t.id) });
    items.push({
        key: "bind", label: bind ? `Изменить клавишу (${comboLabel(bind)})` : "Назначить клавишу…",
        run: () => { supersede(); dlog("dialog-open", { kind: "bind", id: t.id }); ui.set({ dialog: { kind: "bind", templateId: t.id } }); },
    });
    if (bind) items.push({ key: "unbind", label: "Снять клавишу", run: () => store.clearBind(t.id) });
    return items;
}

export function ContextMenu() {
    const menu = ui.useSelect(s => s.menu);
    const [active, setActive] = useState(0);
    const [pos, setPos] = useState<{ left: number; top: number; } | null>(null);
    const ref = useRef<HTMLDivElement>(null);
    const t = menu ? store.byId(menu.id) : undefined;
    const items = t ? itemsFor(t) : [];
    const itemsRef = useRef(items);
    itemsRef.current = items;
    const activeRef = useRef(active);
    activeRef.current = active;

    // A new menu (other row or position): first item active, position measured again.
    useEffect(() => { setActive(0); setPos(null); }, [menu]);

    // Real size, not a guess: keep every edge on screen; the list scrolls inside when the viewport is too low.
    useLayoutEffect(() => {
        if (!menu || !ref.current) return;
        const r = ref.current.getBoundingClientRect();
        setPos({
            left: Math.max(EDGE, Math.min(menu.x, window.innerWidth - r.width - EDGE)),
            top: Math.max(EDGE, Math.min(menu.y, window.innerHeight - r.height - EDGE)),
        });
    }, [menu, items.length]);

    useEffect(() => {
        if (!menu) return;
        const run = (i: number) => {
            const it = itemsRef.current[i];
            ui.set({ menu: null });
            if (it) it.run();
        };
        const down = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest?.(".vc-stx-menu")) return;
            if (e.button === 2 && target.closest?.(".vc-stx-it.ctx")) swallowEndOfGesture("contextmenu", false); // right click on its row: close only
            else if (e.button === 0) swallowEndOfGesture("click", true); // a left click that closes the menu never inserts
            ui.set({ menu: null });
        };
        // While the menu is open it owns the keyboard: the window's Enter / Ctrl+D / Shift+Enter (which act on the
        // keyboard selection, not on this row) and typing into the search never run behind it.
        const key = (e: KeyboardEvent) => {
            if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
            e.preventDefault();
            e.stopPropagation();
            if (e.isComposing) return;
            const n = itemsRef.current.length;
            if (e.key === "Escape" || e.key === "Tab") ui.set({ menu: null });
            else if (e.key === "ArrowDown") setActive(i => (i + 1) % n);
            else if (e.key === "ArrowUp") setActive(i => (i - 1 + n) % n);
            else if (e.key === "Home") setActive(0);
            else if (e.key === "End") setActive(n - 1);
            else if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
                latchKey(e.code); // a held Enter must not reach Discord's editor after the insert
                run(activeRef.current);
            }
        };
        const blur = () => ui.set({ menu: null });
        document.addEventListener("mousedown", down, true);
        document.addEventListener("keydown", key, true);
        window.addEventListener("blur", blur);
        return () => {
            document.removeEventListener("mousedown", down, true);
            document.removeEventListener("keydown", key, true);
            window.removeEventListener("blur", blur);
        };
    }, [menu]);

    if (!menu || !t) return null;
    return (
        // Menu buttons never take focus: it stays in the window's search input after the menu closes.
        <div
            ref={ref} className="vc-stx-menu" role="menu" onMouseDown={e => e.preventDefault()}
            style={{ left: pos?.left ?? menu.x, top: pos?.top ?? menu.y, visibility: pos ? "visible" : "hidden" }}
        >
            {items.map((it, i) => (
                <button
                    key={it.key} role="menuitem" tabIndex={-1}
                    className={i === active ? "on" : undefined}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => { ui.set({ menu: null }); it.run(); }}
                >{it.label}</button>
            ))}
        </div>
    );
}
