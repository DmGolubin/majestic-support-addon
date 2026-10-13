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

export function captureWindowTarget() { windowTarget = { editor: activeEditor(), selection: selectionNow() }; }
export function clearTargets() { windowTarget = composeTarget = null; }

/** Target of an insert starting now: the window's while it is open, else the editor in focus (bind, Alt+N). */
export function targetNow(): Target {
    if (ui.get().windowOpen && windowTarget) return windowTarget;
    return { editor: activeEditor(), selection: selectionNow() };
}

export function rememberComposeTarget() { if (!ui.get().compose.length || !composeTarget) composeTarget = targetNow(); }
export function composeTargetNow(): Target { return composeTarget ?? { editor: activeEditor(), selection: "" }; }
