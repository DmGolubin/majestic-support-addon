/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Lower case, ё→е, nbsp→space. Keeps string length (needed for highlighting). */
export const soft = (s: string) => String(s ?? "").replace(/\u00A0/g, " ").toLowerCase().replace(/ё/g, "е");

/** For matching: placeholders {…} removed, whitespace squeezed. */
export const hard = (s: string) => soft(s).replace(/\{[^}]*\}/g, " ").replace(/\s+/g, " ").trim();

export const tokenize = (s: string) => hard(s).split(" ").filter(Boolean);

/** Title identity for mirror lookup: letters and digits only. */
export const titleKey = (s: string) => soft(s).replace(/[^\p{L}\p{N}]+/gu, "");

// Same marker and regex as the panel (greeting-*.js).
const MARKER = /[^\S\r\n]*\[\[greeting:end\]\][^\S\r\n]*\r?\n?/;
const GREETING_HINT = /привет|здравств|благодар/i;

export function splitGreeting(text: string): { greeting: string; body: string; } {
    const m = MARKER.exec(text);
    if (m) return { greeting: text.slice(0, m.index).trimEnd(), body: text.slice(m.index + m[0].length).trimStart() };
    // Local templates have no marker: the first paragraph is the greeting if it looks like one.
    const i = text.search(/\n[^\S\n]*\n/);
    if (i > 0) {
        const first = text.slice(0, i);
        if (first.length <= 300 && GREETING_HINT.test(first)) return { greeting: first.trimEnd(), body: text.slice(i).trimStart() };
    }
    return { greeting: "", body: text };
}

export const stripMarker = (text: string) => text.replace(MARKER, "");
