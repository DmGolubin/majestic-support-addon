/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Lower case, ё→е, nbsp→space. Unicode casing can expand characters (e.g. İ). */
export const soft = (s: string) => String(s ?? "").replace(/\u00A0/g, " ").toLowerCase().replace(/ё/g, "е");

/** For matching: placeholders {…} removed, whitespace squeezed. */
export function hard(s: string): string {
    const text = soft(s), parts: string[] = [];
    let end = 0;
    for (let open = text.indexOf("{"); open >= 0; open = text.indexOf("{", end)) {
        const close = text.indexOf("}", open + 1);
        if (close < 0) break; // No later opener can have a closer either.
        parts.push(text.slice(end, open), " ");
        end = close + 1;
    }
    parts.push(text.slice(end));
    return parts.join("").replace(/\s+/g, " ").trim();
}

export const tokenize = (s: string) => hard(s).split(" ").filter(Boolean);

/** Title identity for mirror lookup: letters and digits only. */
export const titleKey = (s: string) => soft(s).replace(/[^\p{L}\p{N}]+/gu, "");

// Find the literal marker first: an unanchored leading whitespace repetition rescans long runs quadratically.
const MARKER = /\[\[greeting:end\]\][^\S\r\n]*\r?\n?/;
function greetingMarker(text: string): { index: number; end: number; } | null {
    const m = MARKER.exec(text);
    if (!m) return null;
    let index = m.index;
    while (index > 0 && /[^\S\r\n]/.test(text[index - 1])) index--;
    return { index, end: m.index + m[0].length };
}
// Only a salutation at the paragraph's start (optionally emphasized), never a mention inside instructions.
const GREETING_HINT = /^[^\S\r\n]*(?:\*{1,3}|_{1,3})?(?:здравствуйте|здравствуй|приветствую|приветствуем|привет|добрый (?:день|вечер)|доброе утро|благодар(?:им|ю)(?: вас)? за обращение)(?=$|[\s!.,:;?*_])/iu;
// Remove separator lines, preserving indentation on the first body line.
const trimBlankLines = (text: string) => text.replace(/^(?:[^\S\r\n]*\r?\n)+/, "");

export function splitGreeting(text: string): { greeting: string; body: string; } {
    const m = greetingMarker(text);
    if (m) return { greeting: text.slice(0, m.index).trimEnd(), body: trimBlankLines(text.slice(m.end)) };
    // Local templates have no marker: the first paragraph is the greeting if it looks like one.
    const i = text.search(/\n[^\S\n]*\n/);
    if (i > 0) {
        const first = text.slice(0, i);
        if (first.length <= 300 && GREETING_HINT.test(first)) return { greeting: first.trimEnd(), body: trimBlankLines(text.slice(i)) };
    }
    return { greeting: "", body: text };
}

export function stripMarker(text: string): string {
    const m = greetingMarker(text);
    if (!m) return text;
    const before = text.slice(0, m.index), after = text.slice(m.end);
    // A standalone boundary already has a preceding line break; remove its entire marker line.
    if (m.index === 0 || /[\r\n]/.test(text[m.index - 1])) return before + after;
    // Inline boundaries must not glue the greeting to the body. Keep the original newline if present.
    const newline = /(?:\r\n|\r|\n)$/.exec(text.slice(m.index, m.end))?.[0];
    return before + (newline ?? (after ? " " : "")) + after;
}
