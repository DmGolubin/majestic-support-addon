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
import { costEnd, costStart, debugEnabled, dlog } from "./debug";
import { prepareText, stillCurrent } from "./flow";
import { generationNow } from "./op";
import { latchKey } from "./keylatch";
import { activeScope, InlineState, poolFor, store, ui } from "./uiState";

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
    if (sameInline(ui.get().inline, next)) return;
    // Coalesced: typing a query is one log entry, not one per key.
    if (debugEnabled()) dlog("inline", next ? { q: next.query, items: next.items.length, sel: next.sel, note: next.note || undefined } : { closed: true }, "inline");
    ui.set({ inline: next });
}

const SLATE = '[data-slate-editor="true"]';

/** The Slate editor holding focus, or null. Same result as activeEditor() + contains(activeElement), without the querySelector fallback. */
const focusedEditor = () => (document.activeElement?.closest?.(SLATE) as HTMLElement | null | undefined) ?? null;

/**
 * The last check that found no trigger: while the editor, its text, the caret and the prefix are the
 * same, the answer is the same (no trigger) — skip the Range work. A trigger result is never cached
 * (its items depend on the project and the store).
 */
let idle: { ed: HTMLElement; text: string; node: Node | null; off: number; anchor: Node | null; aoff: number; prefix: string; } | null = null;

/** selectionchange/input → at most one check per frame; an `inline` cost span while debug is on. */
function check() {
    const t0 = costStart();
    try { runCheck(); } finally { costEnd("inline", t0); }
}

function runCheck() {
    const ed = focusedEditor();
    if (!ed) { idle = null; return close(); }
    const { prefix } = store.data;
    const text = ed.textContent ?? "";
    // No prefix character anywhere in the editor: no trigger is possible — no Selection/Range work at all.
    if (!text.includes(prefix)) { idle = null; return close(); }
    // Other servers and DMs: no suggestions (Enter/Tab stay Discord's) and no Selection/Range work either.
    const scope = activeScope();
    if (!scope) { idle = null; return close(); }
    const sel = window.getSelection();
    // Anchor too: a range collapsing onto the same focus point can create a trigger.
    const node = sel?.focusNode ?? null, off = sel?.focusOffset ?? 0, anchor = sel?.anchorNode ?? null, aoff = sel?.anchorOffset ?? 0;
    if (idle && idle.ed === ed && idle.text === text && idle.node === node && idle.off === off && idle.anchor === anchor && idle.aoff === aoff && idle.prefix === prefix) return close();
    const before = textBeforeCaret(ed);
    const trig = before !== null ? findTrigger(before.split("\n").pop() ?? "", prefix) : null;
    idle = trig ? null : { ed, text, node, off, anchor, aoff, prefix };
    if (!trig) return close();
    const hits = orderHits(search(poolFor(scope), trig.query).hits, store.ctx()).slice(0, 6);
    const prev = ui.get().inline;
    if (!hits.length) return close();
    publish({ query: trig.query, length: trig.length, items: hits.map(h => h.t), sel: prev?.query === trig.query ? prev.sel : 0, note: "" });
}

function close() {
    if (ui.get().inline) publish(null);
}

let raf = 0;
const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(check); };
/** selectionchange fires for every selection anywhere in Discord: nothing to do unless an editor has focus or the popup must close. */
const onSelection = () => { if (ui.get().inline || focusedEditor()) schedule(); };

export function startInline() {
    document.addEventListener("input", schedule, true);
    document.addEventListener("selectionchange", onSelection);
    return () => {
        idle = null;
        cancelAnimationFrame(raf);
        document.removeEventListener("input", schedule, true);
        document.removeEventListener("selectionchange", onSelection);
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
/** Bumped by resetInline(): an accept started before it must neither insert nor clear a newer accept's flag. */
let acceptSeq = 0;

/** Plugin stop: never leave a stale accept swallowing Enter/Tab after re-enable, and drop the running one. */
export function resetInline() {
    acceptSeq++;
    accepting = false;
}

/** For the debug panel. */
export const isAccepting = () => accepting;

/** The synchronous part (up to the first await) is an `inline` cost span; the waits (dialogs, Slate) are not plugin work. */
export function acceptInline(i: number, noGreeting: boolean): Promise<void> {
    const t0 = costStart();
    try { return runAccept(i, noGreeting); } finally { costEnd("inline", t0); }
}

async function runAccept(i: number, noGreeting: boolean) {
    const st = ui.get().inline;
    const t = st?.items[i];
    if (!st || !t || accepting) { dlog("inline-accept", { i, skip: accepting ? "уже идёт вставка" : "нет пункта" }); return; }
    dlog("inline-accept", { i, id: t.id, title: t.title, noGreeting: noGreeting || undefined });
    accepting = true;
    const my = ++acceptSeq;
    try {
        await doAccept(st, t, noGreeting, () => my === acceptSeq);
    } finally {
        if (my === acceptSeq) accepting = false;
    }
}

async function doAccept(st: NonNullable<ReturnType<typeof ui.get>["inline"]>, t: NonNullable<typeof st.items[number]>, noGreeting: boolean, live: () => boolean) {
    ui.set({ inline: null });
    const ed = activeEditor();
    const gen = generationNow();
    const prepared = await prepareText(t, { editor: ed, selection: "" }, { noGreeting }); // may open dialogs and steal focus
    if (!prepared || !live() || gen !== generationNow() || !stillCurrent(prepared.snap)) return;
    ed?.focus();
    await new Promise(r => setTimeout(r, 0));
    if (!live() || !stillCurrent(prepared.snap)) return;
    const trig = ed ? findTrigger((textBeforeCaret(ed) ?? "").split("\n").pop() ?? "", store.data.prefix) : null;
    const selected = !!trig && selectTrigger(trig.length);
    await new Promise(r => setTimeout(r, 30)); // let Slate pick up the DOM selection
    if (!live() || !stillCurrent(prepared.snap)) return;
    const ok = insertText(prepared.text);
    dlog("insert", { id: prepared.t.id, title: prepared.t.title, via: "inline", ok, triggerSelected: selected, editor: !!ed });
    if (!ok) { dlog("error", { where: "insertText", id: prepared.t.id }); return; }
    store.markUsed(prepared.t.id);
    if (!selected) toast(`Удалите «${store.data.prefix}${st.query}» вручную`, "message");
}

/** Keyboard while suggestions are shown. true = handled (event consumed). */
export function handleInlineKey(e: KeyboardEvent): boolean {
    const isEnter = e.key === "Enter", isTab = e.key === "Tab";
    if (accepting && (isEnter || isTab)) { dlog("key", { h: "inline-accepting-swallow", key: e.code }, "acc-swallow:" + e.code); return true; } // swallow repeats/double taps during accept
    const st = ui.get().inline;
    if (!st) return false;
    if (e.key === "Escape") { publish(null); return true; }
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
