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
    for (const tok of tokens) {
        for (let i = f.indexOf(tok); i !== -1; i = f.indexOf(tok, i + tok.length)) marks.fill(1, i, i + tok.length);
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
