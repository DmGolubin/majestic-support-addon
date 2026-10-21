/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { TemplateBindMode } from "./types";

export interface KeyLike { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; }

const MODIFIER_CODES = ["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"];
const RESERVED = [
    "Ctrl+KeyC", "Ctrl+KeyV", "Ctrl+KeyX", "Ctrl+KeyA", "Ctrl+KeyZ", "Ctrl+KeyY",
    "Meta+KeyC", "Meta+KeyV", "Meta+KeyX", "Meta+KeyA", "Meta+KeyZ", "Meta+KeyY",
    "Ctrl+Alt+KeyT", "Ctrl+KeyD", "Ctrl+KeyN",
];

/** Physical key (e.code) based, so it does not depend on the keyboard layout. */
export function comboOf(e: KeyLike): string | null {
    if (!e.code || MODIFIER_CODES.includes(e.code)) return null;
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Meta");
    return [...mods, e.code].join("+");
}

/** "" when the combo can be assigned, otherwise the reason. */
export function bindProblem(combo: string): string {
    const parts = combo.split("+");
    const code = parts.pop()!;
    const isF = /^F([1-9]|1\d|2[0-4])$/.test(code);
    if (!code || MODIFIER_CODES.includes(code) || code === "Escape") return "Эту клавишу назначить нельзя";
    if (!isF && !parts.some(m => m !== "Shift")) return "Нужен Ctrl, Alt или Win вместе с клавишей";
    if (RESERVED.includes(combo)) return "Это сочетание занято";
    if (parts.join("+") === "Alt" && /^Digit[1-9]$/.test(code)) return "Alt+1…9 — избранное";
    return "";
}

/** Exactly what comboOf() produces: modifiers in Ctrl, Alt, Shift, Meta order, each at most once, then one key code. */
const CANONICAL = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(Meta\+)?([A-Z][A-Za-z0-9]*)$/;

/** A combo that may be stored as a bind: canonical and allowed (the same rules as assigning one by hand). */
export function isValidBind(combo: unknown): combo is string {
    return typeof combo === "string" && CANONICAL.test(combo) && !MODIFIER_CODES.includes(combo.split("+").pop()!) && !bindProblem(combo);
}

/** Binds from a file or a save: only valid combos of known templates, each combo once (first wins). */
export function cleanBinds(binds: unknown, ids: Set<string>): { binds: Record<string, string>; dropped: number; } {
    const out: Record<string, string> = {};
    const used = new Set<string>();
    let dropped = 0;
    if (!binds || typeof binds !== "object") return { binds: out, dropped };
    for (const [id, combo] of Object.entries(binds as Record<string, unknown>)) {
        if (!ids.has(id) || !isValidBind(combo) || used.has(combo)) { dropped++; continue; }
        out[id] = combo;
        used.add(combo);
    }
    return { binds: out, dropped };
}

/** Sparse mode overrides for accepted bindings only; missing/unknown modes mean ordinary insertion. */
export function cleanBindModes(modes: unknown, binds: Record<string, string>): Record<string, TemplateBindMode> {
    if (!modes || typeof modes !== "object" || Array.isArray(modes)) return {};
    return Object.fromEntries(Object.keys(binds)
        .filter(id => Object.getOwnPropertyDescriptor(modes, id)?.value === "noGreeting")
        .map(id => [id, "noGreeting"]));
}

export function comboLabel(combo: string): string {
    const parts = combo.split("+");
    const code = parts.pop()!;
    const label = /^Key([A-Z])$/.exec(code)?.[1] ?? /^Digit(\d)$/.exec(code)?.[1] ?? /^Numpad(\d)$/.exec(code)?.[1]?.replace(/^/, "Num") ?? code;
    return [...parts.map(m => (m === "Meta" ? "Win" : m)), label].join("+");
}

export interface PeekKey { key: string; repeat: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; }

/**
 * Shift peek starts on a fresh plain Shift press while the window has focus OR the pointer is over it
 * (focus may have fallen to <body> after a click on a non-focusable part of the window). Ctrl/Alt/Meta
 * held = a system combo (Win+Shift+S, Ctrl+Shift+…), never a peek. The peek is visual only: the key is
 * never prevented.
 */
export function startsPeek(e: PeekKey, focusIn: boolean, pointerIn: boolean): boolean {
    return e.key === "Shift" && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && (focusIn || pointerIn);
}
