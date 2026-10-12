/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { orderHits } from "../core/rank";
import { search } from "../core/search";
import { findTrigger } from "../core/trigger";
import { Template } from "../core/types";
import { activeEditor, insertText, toast } from "../platform";
import { prepareText, stillCurrent } from "./flow";
import { latchKey } from "./keylatch";
import { activeProject, InlineState, poolFor, store, ui } from "./uiState";

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

const sameItems = (a: Template[], b: Template[]) => a.length === b.length && a.every((t, i) => t === b[i]); // same objects ⇒ same ids; a re-import (new objects) still refreshes
const sameInline = (a: InlineState | null, b: InlineState | null) =>
    a === b || (!!a && !!b && a.query === b.query && a.length === b.length && a.sel === b.sel && a.note === b.note && sameItems(a.items, b.items));

/** Publishes the popup state only when it actually changed (typing must not re-render the UI for nothing). */
function publish(next: InlineState | null) {
    if (!sameInline(ui.get().inline, next)) ui.set({ inline: next });
}

function check() {
    const ed = activeEditor();
    if (!ed || !ed.contains(document.activeElement)) return close();
    const before = textBeforeCaret(ed);
    const trig = before !== null ? findTrigger(before.split("\n").pop() ?? "", store.data.prefix) : null;
    if (!trig) return close();
    const { project } = activeProject();
    if (!project) {
        publish({ query: trig.query, length: trig.length, items: [], sel: 0, note: "Проект канала не выбран — открой окно (Ctrl+Alt+T)" });
        return;
    }
    const hits = orderHits(search(poolFor(project), trig.query).hits, store.ctx()).slice(0, 6);
    const prev = ui.get().inline;
    if (!hits.length) return close();
    publish({ query: trig.query, length: trig.length, items: hits.map(h => h.t), sel: prev?.query === trig.query ? prev.sel : 0, note: "" });
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
        cancelAnimationFrame(raf);
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

let accepting = false;

/** Plugin stop: never leave a stale accept swallowing Enter/Tab after re-enable. */
export function resetInline() {
    accepting = false;
}

export async function acceptInline(i: number, noGreeting: boolean) {
    const st = ui.get().inline;
    const t = st?.items[i];
    if (!st || !t || accepting) return;
    accepting = true;
    try {
        await doAccept(st, t, noGreeting);
    } finally {
        accepting = false;
    }
}

async function doAccept(st: NonNullable<ReturnType<typeof ui.get>["inline"]>, t: NonNullable<typeof st.items[number]>, noGreeting: boolean) {
    ui.set({ inline: null });
    const ed = activeEditor();
    const prepared = await prepareText(t, { noGreeting }); // may open dialogs and steal focus
    if (!prepared || !stillCurrent(prepared.snap)) return;
    ed?.focus();
    await new Promise(r => setTimeout(r, 0));
    const trig = ed ? findTrigger((textBeforeCaret(ed) ?? "").split("\n").pop() ?? "", store.data.prefix) : null;
    const selected = !!trig && selectTrigger(trig.length);
    await new Promise(r => setTimeout(r, 30)); // let Slate pick up the DOM selection
    if (!stillCurrent(prepared.snap)) return;
    if (!insertText(prepared.text)) return;
    store.markUsed(prepared.t.id);
    if (!selected) toast(`Удалите «${store.data.prefix}${st.query}» вручную`, "message");
}

/** Keyboard while suggestions are shown. true = handled (event consumed). */
export function handleInlineKey(e: KeyboardEvent): boolean {
    const isEnter = e.key === "Enter", isTab = e.key === "Tab";
    if (accepting && (isEnter || isTab)) return true; // swallow repeats/double taps during accept
    const st = ui.get().inline;
    if (!st) return false;
    if (e.key === "Escape") { ui.set({ inline: null }); return true; }
    const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
    const n = st.items.length;
    if (!n) {
        // project-unknown note: never let the trigger text be sent
        if ((isEnter && plain && !e.isComposing) || (isTab && !e.ctrlKey && !e.altKey && !e.metaKey)) {
            if (!e.repeat) toast(st.note, "message");
            return true;
        }
        return false;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && plain) {
        ui.set({ inline: { ...st, sel: (st.sel + (e.key === "ArrowDown" ? 1 : -1) + n) % n } });
        return true;
    }
    if ((isEnter && plain && !e.isComposing) || (isTab && !e.ctrlKey && !e.altKey && !e.metaKey)) {
        if (!e.repeat) {
            latchKey(e.code);
            void acceptInline(st.sel, isTab && e.shiftKey);
        }
        return true;
    }
    return false;
}
