/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useMemo } from "@webpack/common";

// A safe subset of Discord markdown for the preview, built as React elements (no innerHTML).
// Unknown or unbalanced markers stay literal. Links are styled text, never clickable.

type Tag = "strong" | "em" | "u" | "s";
const MARKS: [string, Tag][] = [["**", "strong"], ["__", "u"], ["~~", "s"], ["*", "em"], ["_", "em"]];
const ESCAPABLE = "*_~`\\<>|";
const URL_RE = /https?:\/\/[^\s<>]+/y;
const ANGLE_RE = /<(https?:\/\/[^\s<>]+)>/y;
const WORD = /[\p{L}\p{N}]/u;
const isWord = (c: string | undefined) => !!c && WORD.test(c);
const isSpace = (c: string | undefined) => !c || /\s/.test(c);

/** Index of the closing marker for the opener at i, or -1. */
function closer(s: string, i: number, m: string): number {
    const start = i + m.length;
    if (m.length === 2) {
        let j = s.indexOf(m, start);
        if (j > start && s[j + 2] === m[0]) j++; // "***x***": the outer pair takes the last two
        return j > start ? j : -1;
    }
    // single * / _: no space right inside, _ only on word boundaries (snake_case stays literal)
    if (isSpace(s[start]) || (m === "_" && isWord(s[i - 1]))) return -1;
    for (let j = start; j < s.length; j++) {
        if (s[j] === "\\") { j++; continue; }
        if (s.startsWith(m + m, j)) { j++; continue; } // a nested ** / __ pair is not our closer
        if (s[j] === m && j > start && !isSpace(s[j - 1]) && !(m === "_" && isWord(s[j + 1]))) return j;
    }
    return -1;
}

function sticky(re: RegExp, s: string, i: number) {
    re.lastIndex = i;
    return re.exec(s);
}

function parse(s: string, key: string): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    let buf = "";
    const push = (n: React.ReactNode) => { if (buf) out.push(buf); buf = ""; out.push(n); };
    for (let i = 0; i < s.length;) {
        const c = s[i], k = key + "." + i;
        if (c === "\\" && ESCAPABLE.includes(s[i + 1] ?? "\0")) { buf += s[i + 1]; i += 2; continue; }
        const link = c === "<" ? sticky(ANGLE_RE, s, i) : c === "h" && !isWord(s[i - 1]) ? sticky(URL_RE, s, i) : null;
        if (link) {
            let url = link[1] ?? link[0], len = link[0].length;
            if (!link[1]) { const trail = /[.,!?:;)"'»]+$/.exec(url); if (trail) { url = url.slice(0, -trail[0].length); len -= trail[0].length; } }
            push(<span key={k} className="vc-stx-md-link">{url}</span>);
            i += len;
            continue;
        }
        if (c === "`") {
            const fence = s.startsWith("```", i) ? "```" : "`";
            const j = s.indexOf(fence, i + fence.length);
            if (j > i + fence.length) {
                push(<code key={k} className="vc-stx-md-code">{s.slice(i + fence.length, j)}</code>);
                i = j + fence.length;
                continue;
            }
        }
        const mark = MARKS.find(([m]) => s.startsWith(m, i));
        if (mark) {
            const [m, T] = mark;
            const j = closer(s, i, m);
            if (j > 0) {
                push(<T key={k}>{parse(s.slice(i + m.length, j), k)}</T>);
                i = j + m.length;
            } else { buf += m; i += m.length; }
            continue;
        }
        buf += c;
        i++;
    }
    if (buf) out.push(buf);
    return out;
}

/** Discord-markdown text as React nodes; line breaks are kept (render inside white-space: pre-wrap). */
export function Markdown({ text }: { text: string; }) {
    const nodes = useMemo(() => parse(text, "md"), [text]);
    return <>{nodes}</>;
}
