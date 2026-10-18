/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { soft } from "../core/text";

export function nqHighlight(text: string, tokens: string[]): React.ReactNode {
    if (!tokens.length) return text;
    const f = soft(text);
    const marks = new Uint8Array(text.length);
    // Match in normalized text, but mark whole source characters when casing expands them.
    const starts: number[] = [], ends: number[] = [];
    if (f.length !== text.length) {
        let source = 0;
        for (const ch of text) {
            for (let i = 0; i < soft(ch).length; i++) { starts.push(source); ends.push(source + ch.length); }
            source += ch.length;
        }
    }
    for (const tok of tokens) {
        if (!tok.length) continue;
        for (let i = f.indexOf(tok); i !== -1; i = f.indexOf(tok, i + tok.length))
            marks.fill(1, starts.length ? starts[i] : i, ends.length ? ends[i + tok.length - 1] : i + tok.length);
    }
    const out: React.ReactNode[] = [];
    for (let i = 0; i < text.length;) {
        let j = i;
        while (j < text.length && marks[j] === marks[i]) j++;
        const seg = text.slice(i, j);
        out.push(marks[i] ? <mark key={i}>{seg}</mark> : <span key={i}>{seg}</span>);
        i = j;
    }
    return out;
}
