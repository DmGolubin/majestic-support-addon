/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The context of one insert, captured before focus leaves the chat editor (window search, dialogs):
// which editor the text goes to, the user's text selection at that moment ({{selection}}), and the
// plugin generation — stop() bumps it, so an insert still awaiting a dialog/timer after stop is dropped.
import { activeEditor } from "../platform";
import { ui } from "./uiState";

let generation = 0;
export const generationNow = () => generation;
/** Plugin start/stop: everything started under the old generation is cancelled at its next check. */
export const nextGeneration = () => ++generation;

export interface Target { editor: HTMLElement | null; selection: string; }

const selectionNow = () => String(window.getSelection() ?? "");

/** Captured when the template window opens (focus is still in the chat editor the user works in). */
let windowTarget: Target | null = null;
/** Captured when the first piece goes into the compose bar. */
let composeTarget: Target | null = null;
let offTargets: (() => void) | null = null;

// Observe only while a surface owns a target. Clearing these slots never mutates
// the Target/Snap already captured by an asynchronous insert or confirmation.
function stopWatchingIfEmpty() {
    if (windowTarget || composeTarget) return;
    offTargets?.();
    offTargets = null;
}
function watchTargets() {
    offTargets ??= ui.subscribe(() => {
        const state = ui.get();
        if (!state.windowOpen) windowTarget = null;
        if (!state.compose.length) composeTarget = null;
        stopWatchingIfEmpty();
    });
}

export function captureWindowTarget(editor: HTMLElement | null = null) {
    windowTarget = { editor: editor ?? activeEditor(), selection: selectionNow() };
    // Capture precedes the synchronous windowOpen update; do not discard it here.
    watchTargets();
}

/** The Slate editor of the chat box that contains `el` (a chat-bar button): focus-independent. */
export function editorNear(el: Element | null): HTMLElement | null {
    const editor = el?.closest?.('[class*="channelTextArea"]')?.querySelector<HTMLElement>('[data-slate-editor="true"]');
    return editor?.isConnected ? editor : null;
}
export function clearTargets() { windowTarget = composeTarget = null; stopWatchingIfEmpty(); }

/** Target of an insert starting now: the window's while it is open, else the editor in focus (bind, Alt+N). */
export function targetNow(): Target {
    if (ui.get().windowOpen && windowTarget) {
        // Discord can remount an editor without switching channels. Rebind only
        // a new operation; an already captured Target/Snap keeps its old editor
        // and is still cancelled by stillCurrent().
        if (windowTarget.editor && !windowTarget.editor.isConnected) {
            windowTarget = { editor: activeEditor(), selection: windowTarget.selection };
        }
        return windowTarget;
    }
    return { editor: activeEditor(), selection: selectionNow() };
}

/** The latest piece added sets where the answer goes (the editor the user is working in now). */
export function rememberComposeTarget() { composeTarget = targetNow(); watchTargets(); }
export function composeTargetNow(): Target { return composeTarget ?? { editor: activeEditor(), selection: "" }; }
/** After a cancel because the editor was replaced: the next «Вставить всё» uses the editor in focus then. */
export function resetComposeTarget() { composeTarget = null; stopWatchingIfEmpty(); }

/** Editors the floating surfaces are placed at. */
export const windowEditor = () => windowTarget?.editor ?? null;
export const composeEditor = () => composeTarget?.editor ?? null;
