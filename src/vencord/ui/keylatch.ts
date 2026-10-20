/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A key that triggered a plugin action stays "latched" until released: its auto-repeat
// keydowns are swallowed, so a held Enter/Tab never reaches Discord after an insert.

import { costEnd, costStart, dlog, noteKey } from "./debug";

let latched: string | null = null;

/** Remember the key (e.code) that triggered an action that may insert text. */
export function latchKey(code: string) {
    if (code) latched = code;
    dlog("latch", { code });
}

/** Native insertion buttons move focus to chat on click; hold their activation key until release. */
export function latchButtonKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" || e.key === " ") latchKey(e.nativeEvent.code);
}

/** The latched key code, for the debug panel. */
export const latchedCode = () => latched;

/** Document capture keydown: true = a repeat of the latched key, swallowed. */
export function swallowLatched(e: KeyboardEvent): boolean {
    if (!latched || e.code !== latched) return false;
    if (!e.repeat) { latched = null; return false; } // a fresh press: the old one was released
    e.preventDefault();
    e.stopPropagation();
    noteKey(e, "latch");
    dlog("key", { h: "latch-swallow", key: e.code }, "swallow:" + e.code);
    return true;
}

export function startLatch() {
    const up = (e: KeyboardEvent) => {
        const t0 = costStart();
        if (e.code === latched) latched = null;
        costEnd("keys", t0);
    };
    const blur = () => { latched = null; };
    document.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
        document.removeEventListener("keyup", up, true);
        window.removeEventListener("blur", blur);
        latched = null;
    };
}
