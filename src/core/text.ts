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

// The panel's explicit greeting boundary, including surrounding horizontal space and one newline.
const MARKER = /[^\S\r\n]*\[\[greeting:end\]\][^\S\r\n]*\r?\n?/;
// Only a salutation at the paragraph's start (optionally emphasized), never a mention inside instructions.
const GREETING_HINT = /^[^\S\r\n]*(?:\*{1,3}|_{1,3})?(?:здравствуйте|здравствуй|приветствую|приветствуем|привет|добрый (?:день|вечер)|доброе утро|благодар(?:им|ю)(?: вас)? за обращение)(?=$|[\s!.,:;?*_])/iu;
// Remove separator lines, preserving indentation on the first body line.
const trimBlankLines = (text: string) => text.replace(/^(?:[^\S\r\n]*\r?\n)+/, "");

export function splitGreeting(text: string): { greeting: string; body: string; } {
    const m = MARKER.exec(text);
    if (m) return { greeting: text.slice(0, m.index).trimEnd(), body: trimBlankLines(text.slice(m.index + m[0].length)) };
    // Local templates have no marker: the first paragraph is the greeting if it looks like one.
    const i = text.search(/\n[^\S\n]*\n/);
    if (i > 0) {
        const first = text.slice(0, i);
        if (first.length <= 300 && GREETING_HINT.test(first)) return { greeting: first.trimEnd(), body: trimBlankLines(text.slice(i)) };
    }
    return { greeting: "", body: text };
}

export const stripMarker = (text: string) => text.replace(MARKER, (marker: string, offset: number) => {
    // A standalone boundary already has a preceding line break; remove its entire marker line.
    if (offset === 0 || /[\r\n]/.test(text[offset - 1])) return "";
    // Inline boundaries must not glue the greeting to the body. Keep the original newline if present.
    const newline = /(?:\r\n|\r|\n)$/.exec(marker)?.[0];
    return newline ?? (offset + marker.length < text.length ? " " : "");
});
