/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ALIASES } from "./aliases";
import { hard, soft, tokenize } from "./text";
import { Template } from "./types";

export interface Hit { t: Template; level: number; line: string | null; }
export interface SearchResult { hits: Hit[]; tokens: string[]; fuzzy: boolean; layout: string | null; }

const MIN_BODY = 3;  // shorter words are not searched in the body — they match everything
const MIN_FUZZY = 4;

const aliasCache = new WeakMap<Template, string>();
function aliasOf(t: Template) {
    let a = aliasCache.get(t);
    if (a === undefined) {
        const title = hard(t.title);
        a = ALIASES.filter(([k]) => title.includes(k)).map(([, v]) => v).join(" ");
        aliasCache.set(t, a);
    }
    return a;
}

/** Body line with the most token hits — shown instead of the template start. */
export function bestLine(text: string, toks: string[]): string | null {
    let best: string | null = null, bestHits = 0;
    for (const line of text.split("\n")) {
        const s = soft(line);
        const hits = toks.reduce((n, t) => n + (s.includes(t) ? 1 : 0), 0);
        if (hits > bestHits) { bestHits = hits; best = line.trim(); }
    }
    return best;
}

function strict(t: Template, toks: string[]): Hit | null {
    const all = (h: string) => toks.every(x => h.includes(x));
    if (t.command && toks.length === 1 && soft(t.command) === toks[0]) return { t, level: 5, line: null };
    const title = hard(t.title);
    if (all(title)) return { t, level: 4, line: null };
    const alias = aliasOf(t);
    if (alias && all(title + " " + alias)) return { t, level: 3, line: null };
    if (toks.every(x => x.length >= MIN_BODY) && all(hard(t.text))) return { t, level: 2, line: bestLine(t.text, toks) };
    return null;
}

/** Length of the stretch of hay holding needle as a subsequence; -1 if none. */
export function subseqSpan(needle: string, hay: string) {
    let i = 0, start = -1;
    for (let p = 0; p < hay.length; p++) {
        if (hay[p] === needle[i]) {
            if (i === 0) start = p;
            if (++i === needle.length) return p - start + 1;
        }
    }
    return -1;
}

function fuzzy(t: Template, toks: string[]): Hit | null {
    if (toks.length !== 1 || toks[0].length < MIN_FUZZY) return null;
    const span = subseqSpan(toks[0], hard(t.title));
    return span >= 0 && span <= toks[0].length * 3 ? { t, level: 1, line: null } : null;
}

const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,./`";
const RU = "йцукенгшщзхъфывапролджэячсмитьбю.ё";

/** "cjtl" → "соед" and back; null when the query mixes layouts or has no letters. */
export function swapLayout(q: string): string | null {
    const s = q.toLowerCase();
    const cyr = /[а-яё]/.test(s), lat = /[a-z]/.test(s);
    if (cyr === lat) return null;
    const [from, to] = lat ? [EN, RU] : [RU, EN];
    let out = "";
    for (const ch of s) {
        const i = from.indexOf(ch);
        out += i >= 0 ? to[i] : ch;
    }
    return out;
}

function run(pool: Template[], q: string) {
    const tokens = tokenize(q);
    if (!tokens.length) return { hits: pool.map(t => ({ t, level: 0, line: null })), tokens, fuzzy: false };
    let hits = pool.map(t => strict(t, tokens)).filter((h): h is Hit => !!h);
    let fz = false;
    if (!hits.length) {
        hits = pool.map(t => fuzzy(t, tokens)).filter((h): h is Hit => !!h);
        fz = hits.length > 0;
    }
    return { hits, tokens, fuzzy: fz };
}

export function search(pool: Template[], query: string): SearchResult {
    let r = run(pool, query);
    let layout: string | null = null;
    if (!r.hits.length && query.trim()) {
        const alt = swapLayout(query);
        if (alt) {
            const r2 = run(pool, alt);
            if (r2.hits.length) { r = r2; layout = alt.trim(); }
        }
    }
    return { ...r, layout };
}
