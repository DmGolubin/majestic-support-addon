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

const MIN_BODY = 3; // shorter words are not searched in the body — they match everything
const MIN_FUZZY = 4;
const MAX_FUZZY_WORD = 48;
const MAX_FUZZY_TOKENS = 8;
const MAX_QUERY_EDITS = 2;

interface Fields { title: string; text: string; alias: string; titleWords?: string[]; bodyWords?: string[]; aliasWords?: string[]; }

/** Normalized search fields, computed once per template (templates are immutable after import). */
const fieldCache = new WeakMap<Template, Fields>();
function fieldsOf(t: Template): Fields {
    let f = fieldCache.get(t);
    if (f === undefined) {
        const title = hard(t.title);
        const alias = ALIASES.filter(([k]) => title.includes(k)).map(([, v]) => v).join(" ");
        f = { title, text: hard(t.text), alias };
        fieldCache.set(t, f);
    }
    return f;
}

/** Body line with the most token hits — shown instead of the template start. */
export function bestLine(text: string, toks: string[]): string | null {
    let best: string | null = null, bestHits = 0;
    for (const line of text.split("\n")) {
        const s = soft(line);
        const hits = toks.reduce((n, t) => n + (s.includes(t) ? 1 : 0), 0);
        if (hits > bestHits) { bestHits = hits; best = line.trim(); }
        if (bestHits === toks.length) break; // Later lines cannot improve a complete match.
    }
    return best;
}

function strict(t: Template, toks: string[]): Hit | null {
    const all = (h: string) => toks.every(x => h.includes(x));
    if (t.command && toks.length === 1 && soft(t.command) === toks[0]) return { t, level: 5, line: null };
    const { title, text, alias } = fieldsOf(t);
    if (all(title)) {
        const phrase = toks.join(" ");
        return { t, level: title === phrase ? 4.75 : title.startsWith(phrase) ? 4.5 : 4, line: null };
    }
    if (alias && all(title + " " + alias)) return { t, level: 3, line: null };
    // Every token is required; short words must be anchored in title/aliases.
    // This also supports a title term plus a detail found only in the answer.
    const inHeading = (x: string) => title.includes(x) || alias.includes(x);
    if (toks.some(inHeading) && toks.every(x => inHeading(x) || x.length >= MIN_BODY && text.includes(x)))
        return { t, level: 2.5, line: bestLine(t.text, toks) };
    if (toks.every(x => x.length >= MIN_BODY) && all(text)) return { t, level: 2, line: bestLine(t.text, toks) };
    return null;
}

/** Shortest stretch of hay holding needle as a subsequence; -1 if none. */
export function subseqSpan(needle: string, hay: string) {
    if (!needle.length || needle.length > hay.length) return -1;
    // Latest start for each matched prefix. Walk backwards so one character
    // cannot satisfy multiple positions when the needle has repeated letters.
    const starts = new Array<number>(needle.length).fill(-1);
    let best = Infinity;
    for (let p = 0; p < hay.length; p++) {
        for (let i = needle.length - 1; i >= 0; i--) {
            if (hay[p] !== needle[i]) continue;
            const start = i === 0 ? p : starts[i - 1];
            if (start < 0) continue;
            starts[i] = start;
            if (i === needle.length - 1) {
                best = Math.min(best, p - start + 1);
                if (best === needle.length) return best;
            }
        }
    }
    return best === Infinity ? -1 : best;
}

/** At most two edits: four alternatives per mismatch, recursion depth <= 2.
 * Unlike a full edit-distance matrix, allocation and work stay bounded per word.
 * Adjacent transposition counts as one edit (e.g. "серевр" -> "сервер"). */
function withinEdits(a: string, b: string, budget: number, i = 0, j = 0): boolean {
    if (Math.abs(a.length - i - (b.length - j)) > budget) return false;
    while (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    if (i === a.length || j === b.length) return a.length - i + b.length - j <= budget;
    if (!budget) return false;
    return withinEdits(a, b, budget - 1, i + 1, j + 1)
        || withinEdits(a, b, budget - 1, i + 1, j)
        || withinEdits(a, b, budget - 1, i, j + 1)
        || (a[i] === b[j + 1] && a[i + 1] === b[j] && withinEdits(a, b, budget - 1, i + 2, j + 2));
}

function words(text: string, cache: MatchCache): string[] {
    const saved = cache.words.get(text);
    if (saved) return saved;
    // Fuzzy matching supports RU/EN words only; exact search remains Unicode.
    // Scan their alphabet directly rather than running Unicode classification
    // across every character of a large answer. Check adjacent Unicode letters
    // so e.g. "caf" inside "café" cannot become a separate fuzzy word.
    const found = new Set<string>(), pattern = /[a-zа-я0-9]+/g;
    for (let match: RegExpExecArray | null; (match = pattern.exec(text));) {
        const word = match[0];
        if (word.length < MIN_FUZZY - 1 || word.length > MAX_FUZZY_WORD || found.has(word) || !/^[a-zа-я]+$/.test(word)) continue;
        const before = text.slice(Math.max(0, match.index - 2), match.index), after = text.slice(pattern.lastIndex, pattern.lastIndex + 2);
        if (/[\p{L}\p{N}]$/u.test(before) || /^[\p{L}\p{N}]/u.test(after)) continue;
        found.add(word);
    }
    // Identical fields may share the immutable array during this search. The
    // temporary text map is discarded afterwards; retained caches are weak.
    const result = [...found];
    if (cache.words.size < 256) cache.words.set(text, result);
    return result;
}

interface WordMatch { edits: number; word: string; }
interface MatchCache { distances: Map<string, Map<string, number>>; words: Map<string, string[]>; }
function matchWord(token: string, word: string, prefix: boolean, memo: Map<string, number>): number {
    const saved = memo.get(word);
    if (saved !== undefined) return saved;
    const limit = token.length >= 8 ? 2 : 1;
    let distance = MAX_QUERY_EDITS + 1;
    // Fuzzy prefixes are useful while typing titles, but must not match arbitrary
    // body fragments. Whole-word body matching avoids broad, unrelated results.
    const candidates = prefix && token.length >= 5 && word.length > token.length + limit
        ? [word.slice(0, token.length), word.slice(0, token.length + 1), word.slice(0, token.length - 1)] : [word];
    for (let edits = 1; edits <= limit; edits++) {
        if (candidates.some(candidate => withinEdits(token, candidate, edits))) { distance = edits; break; }
    }
    // The memo lives for one search only and is capped for unusual vocabularies.
    if (memo.size < 20000) memo.set(word, distance);
    return distance;
}

function fieldMatch(token: string, field: string, getWords: () => string[], prefix: boolean, cache: MatchCache, body = false): WordMatch | null {
    if (body && token.length < MIN_BODY) return null;
    if (field.includes(token)) return { edits: 0, word: token };
    if (token.length < MIN_FUZZY || token.length > MAX_FUZZY_WORD || !/^[a-zа-я]+$/.test(token)) return null;
    const key = `${prefix ? "p" : "w"}:${token}`;
    let memo = cache.distances.get(key);
    if (!memo) cache.distances.set(key, memo = new Map());
    let best: WordMatch | null = null;
    for (const word of getWords()) {
        const edits = matchWord(token, word, prefix, memo);
        if (edits <= MAX_QUERY_EDITS && (!best || edits < best.edits)) best = { edits, word };
        if (best?.edits === 1) break;
    }
    return best;
}

function fuzzy(t: Template, toks: string[], cache: MatchCache): Hit | null {
    const f = fieldsOf(t);
    const title = toks.map(x => fieldMatch(x, f.title, () => f.titleWords ??= words(f.title, cache), true, cache));
    const fits = (matches: (WordMatch | null)[]) => matches.every(Boolean)
        && matches.reduce((sum, m) => sum + (m?.edits ?? MAX_QUERY_EDITS + 1), 0) <= MAX_QUERY_EDITS;
    if (fits(title)) return { t, level: 1, line: null };
    const heading = toks.map((x, i) => {
        const alias = fieldMatch(x, f.alias, () => f.aliasWords ??= words(f.alias, cache), true, cache);
        return !title[i] || alias && alias.edits < title[i]!.edits ? alias : title[i];
    });
    if (fits(heading)) return { t, level: 0.9, line: null };
    const body = toks.map(x => fieldMatch(x, f.text, () => f.bodyWords ??= words(f.text, cache), false, cache, true));
    const combined = body.map((m, i) => !heading[i] || m && m.edits < heading[i]!.edits ? m : heading[i]);
    if (!fits(combined)) return null;
    const bodyOnly = !heading.some(Boolean);
    return { t, level: bodyOnly ? 0.5 : 0.75, line: bestLine(t.text, combined.map(m => m!.word)) };
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

function run(pool: Template[], q: string, approximate = false) {
    const tokens = tokenize(q);
    if (!tokens.length) return { hits: pool.map(t => ({ t, level: 0, line: null })), tokens, fuzzy: false };
    const cache: MatchCache = { distances: new Map(), words: new Map() };
    const hits = approximate && (tokens.length > MAX_FUZZY_TOKENS || !tokens.some(t => t.length >= MIN_FUZZY && t.length <= MAX_FUZZY_WORD))
        ? [] : pool.map(t => approximate ? fuzzy(t, tokens, cache) : strict(t, tokens)).filter((h): h is Hit => !!h);
    // Stable ties keep catalog order; orderHits still applies favorites/usage
    // within these relevance tiers. No consumer API or new UI mode is required.
    hits.sort((a, b) => b.level - a.level);
    return { hits, tokens, fuzzy: approximate && hits.length > 0 };
}

export function search(pool: Template[], query: string): SearchResult {
    let r = run(pool, query);
    let layout: string | null = null;
    const alt = !r.hits.length && query.trim() ? swapLayout(query) : null;
    // Exact layout-corrected results must beat approximate accidental matches.
    if (alt) {
        const corrected = run(pool, alt);
        if (corrected.hits.length) { r = corrected; layout = alt.trim(); }
    }
    if (!r.hits.length && query.trim()) r = run(pool, query, true);
    if (!r.hits.length && alt) {
        const corrected = run(pool, alt, true);
        if (corrected.hits.length) { r = corrected; layout = alt.trim(); }
    }
    return { ...r, layout };
}
