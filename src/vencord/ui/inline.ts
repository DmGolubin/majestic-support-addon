/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { orderHits } from "../core/rank";
import { search } from "../core/search";
import { findTrigger } from "../core/trigger";
import { activeEditor, insertText, toast } from "../platform";
import { prepareText } from "./flow";
import { activeProject, poolFor, store, ui } from "./uiState";

function textBeforeCaret(ed: HTMLElement): string | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!ed.contains(r.startContainer)) return null;
    const pre = document.createRange();
    pre.selectNodeContents(ed);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString();
}

function check() {
    const ed = activeEditor();
    if (!ed || !ed.contains(document.activeElement)) return close();
    const before = textBeforeCaret(ed);
    const trig = before !== null ? findTrigger(before.split("\n").pop() ?? "", store.data.prefix) : null;
    if (!trig) return close();
    const { project } = activeProject();
    if (!project) {
        ui.set({ inline: { query: trig.query, length: trig.length, items: [], sel: 0, note: "Проект канала не выбран — открой окно (Ctrl+Alt+T)" } });
        return;
    }
    const hits = orderHits(search(poolFor(project), trig.query).hits, store.ctx()).slice(0, 6);
    const prev = ui.get().inline;
    ui.set({ inline: { query: trig.query, length: trig.length, items: hits.map(h => h.t), sel: prev?.query === trig.query ? prev.sel : 0, note: hits.length ? "" : "Ничего не найдено" } });
}

function close() {
    if (ui.get().inline) ui.set({ inline: null });
}

let raf = 0;
const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(check); };

export function startInline() {
    document.addEventListener("input", schedule, true);
    document.addEventListener("selectionchange", schedule);
    return () => {
        document.removeEventListener("input", schedule, true);
        document.removeEventListener("selectionchange", schedule);
        close();
    };
}

/** Selects the trigger text right before the caret so INSERT_TEXT replaces it. */
function selectTrigger(length: number): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const node = sel.focusNode, off = sel.focusOffset;
    if (!node || node.nodeType !== Node.TEXT_NODE || off < length) return false;
    const r = document.createRange();
    r.setStart(node, off - length);
    r.setEnd(node, off);
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
}

export async function acceptInline(i: number, noGreeting: boolean) {
    const st = ui.get().inline;
    const t = st?.items[i];
    if (!st || !t) return;
    ui.set({ inline: null });
    const ed = activeEditor();
    const prepared = await prepareText(t, { noGreeting }); // may open dialogs and steal focus
    if (!prepared) return;
    ed?.focus();
    await new Promise(r => setTimeout(r, 0));
    const trig = ed ? findTrigger((textBeforeCaret(ed) ?? "").split("\n").pop() ?? "", store.data.prefix) : null;
    const selected = !!trig && selectTrigger(trig.length);
    await new Promise(r => setTimeout(r, 30)); // let Slate pick up the DOM selection
    insertText(prepared.text);
    store.markUsed(prepared.t.id);
    if (!selected) toast(`Удалите «${store.data.prefix}${st.query}» вручную`, "message");
}

/** Keyboard while suggestions are shown. true = handled (event consumed). */
export function handleInlineKey(e: KeyboardEvent): boolean {
    const st = ui.get().inline;
    if (!st) return false;
    const n = st.items.length;
    if (e.key === "Escape") { ui.set({ inline: null }); return true; }
    if (!n) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        ui.set({ inline: { ...st, sel: (st.sel + (e.key === "ArrowDown" ? 1 : -1) + n) % n } });
        return true;
    }
    if (e.key === "Tab" || e.key === "Enter") {
        if (!e.repeat) void acceptInline(st.sel, e.key === "Tab" && e.shiftKey);
        return true;
    }
    return false;
}
