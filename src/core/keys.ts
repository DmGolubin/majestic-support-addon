/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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

export function comboLabel(combo: string): string {
    const parts = combo.split("+");
    const code = parts.pop()!;
    const label = /^Key([A-Z])$/.exec(code)?.[1] ?? /^Digit(\d)$/.exec(code)?.[1] ?? /^Numpad(\d)$/.exec(code)?.[1]?.replace(/^/, "Num") ?? code;
    return [...parts.map(m => (m === "Meta" ? "Win" : m)), label].join("+");
}
