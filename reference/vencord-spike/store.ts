/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { ChannelStore, GuildStore, SelectedChannelStore } from "@webpack/common";

export interface Template {
    title: string;
    group: string;
    text: string;
}

export interface Usage {
    n: number;
    last: number;
}

export interface PluginData {
    raw: string;
    usage: Record<string, Usage>;
    pinned: string[];
    /** channelId -> selected tab (group name, "" = all) */
    tabs: Record<string, string>;
}

const KEY = "SupportTemplates_data";

const EXAMPLE_RAW = `## Majestic RP

### Пример шаблона
**Приветствую!
Благодарим Вас за обращение в службу поддержки.**

## Россия Онлайн

### Пример шаблона
Импортируй свой SupportTemplates.config.json в настройках плагина.
`;

let data: PluginData = { raw: EXAMPLE_RAW, usage: {}, pinned: [], tabs: {} };
let templates: Template[] = parseTemplates(EXAMPLE_RAW);
const listeners = new Set<() => void>();

export function subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

function emit() {
    listeners.forEach(fn => fn());
}

export async function load() {
    const saved = await DataStore.get<PluginData>(KEY);
    if (saved && typeof saved.raw === "string") {
        data = { raw: saved.raw, usage: saved.usage ?? {}, pinned: saved.pinned ?? [], tabs: saved.tabs ?? {} };
        templates = parseTemplates(data.raw);
        emit();
    }
}

function save() {
    DataStore.set(KEY, data);
    emit();
}

export const getTemplates = () => templates;
export const getData = () => data;

export function tkey(t: Template) {
    return (t.group || "") + "||" + t.title;
}

export function groups() {
    const seen: string[] = [];
    for (const t of templates) if (t.group && !seen.includes(t.group)) seen.push(t.group);
    return seen;
}

// ---------------------------------------------------------------- import

/** Accepts the BetterDiscord SupportTemplates config / backup JSON, or plain "## / ###" text. */
export function importBackup(text: string): string {
    let obj: any = null;
    try { obj = JSON.parse(text); } catch { }
    const raw = obj && typeof obj === "object" && !Array.isArray(obj) ? obj.raw : text;
    if (typeof raw !== "string") throw new Error("В файле нет поля raw");
    const parsed = parseTemplates(raw);
    if (!parsed.length) throw new Error("Не нашёл ни одного шаблона");

    data.raw = raw;
    templates = parsed;
    if (obj?.usage && typeof obj.usage === "object") data.usage = obj.usage;
    if (Array.isArray(obj?.pinned)) data.pinned = obj.pinned.filter((k: unknown) => typeof k === "string");
    save();
    return `Шаблонов: ${parsed.length}, закреплённых: ${data.pinned.length}, наборы: ${groups().join(", ") || "нет"}`;
}

// ---------------------------------------------------------------- usage / pins / tabs

export function bumpUsage(t: Template) {
    const k = tkey(t);
    const u = data.usage[k] ?? { n: 0, last: 0 };
    data.usage[k] = { n: u.n + 1, last: Date.now() };
    save();
}

export function togglePin(t: Template) {
    const k = tkey(t);
    const i = data.pinned.indexOf(k);
    if (i >= 0) data.pinned.splice(i, 1);
    else data.pinned.push(k);
    save();
}

export const isPinned = (t: Template) => data.pinned.includes(tkey(t));

export function rememberTab(channelId: string | undefined, tab: string) {
    if (!channelId) return;
    data.tabs[channelId] = tab;
    save();
}

const norm = (s: string) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Tab for the current channel: remembered choice first, then a group whose name is
 * found in the channel / category / server name. null = could not decide.
 */
export function resolveTab(): { channelId?: string; tab: string | null; } {
    const channelId = SelectedChannelStore.getChannelId();
    if (!groups().length) return { channelId, tab: "" };
    if (channelId && data.tabs[channelId] !== undefined) return { channelId, tab: data.tabs[channelId] };

    const ch = channelId ? ChannelStore.getChannel(channelId) : null;
    const parent = ch?.parent_id ? ChannelStore.getChannel(ch.parent_id) : null;
    const guild = ch?.guild_id ? GuildStore.getGuild(ch.guild_id) : null;
    for (const name of [ch?.name, parent?.name, guild?.name]) {
        const n = norm(name ?? "");
        if (!n) continue;
        let best = "";
        for (const g of groups()) {
            const gn = norm(g);
            if (gn && (n.includes(gn) || gn.includes(n)) && g.length > best.length) best = g;
        }
        if (best) return { channelId, tab: best };
    }
    return { channelId, tab: null };
}

// ---------------------------------------------------------------- parsing (same format as the BD plugin)

export function parseTemplates(raw: string): Template[] {
    const src = String(raw || "").replace(/\r/g, "").trim();
    if (!src) return [];

    const items: { title: string; group: string; lines: string[]; }[] = [];
    let cur: typeof items[number] | null = null;
    let group = "";
    for (const rawLine of src.split("\n")) {
        const esc = /^\\#{1,6}\s/.test(rawLine);
        const line = esc ? rawLine.slice(1) : rawLine;
        const t = esc ? null : line.match(/^###\s+(.+?)\s*$/);
        const g = esc ? null : line.match(/^##\s+(.+?)\s*$/);
        if (t) {
            if (cur) items.push(cur);
            cur = { title: t[1], group, lines: [] };
        } else if (g) {
            if (cur) items.push(cur);
            cur = null;
            group = g[1];
        } else if (cur) {
            cur.lines.push(line);
        }
    }
    if (cur) items.push(cur);
    return items
        .map(i => ({ title: i.title, group: i.group, text: i.lines.join("\n").trim() }))
        .filter(i => i.text);
}

// ---------------------------------------------------------------- search

const LAYOUT_EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,./`";
const LAYOUT_RU = "йцукенгшщзхъфывапролджэячсмитьбю.ё";

/** lower case, ё = е; keeps string length (needed for highlighting) */
export function nq(s: string) {
    let out = "";
    for (const ch of String(s || "")) {
        const c = ch.toLowerCase();
        out += c === "ё" ? "е" : c.length === 1 ? c : ch;
    }
    return out;
}

function swapLayout(q: string): string | null {
    const s = q.toLowerCase();
    const cyr = /[а-яё]/.test(s), lat = /[a-z]/.test(s);
    if (cyr === lat) return null;
    const [from, to] = lat ? [LAYOUT_EN, LAYOUT_RU] : [LAYOUT_RU, LAYOUT_EN];
    let out = "";
    for (const ch of s) {
        const i = from.indexOf(ch);
        out += i >= 0 ? to[i] : ch;
    }
    return out;
}

function relevance(t: Template, tokens: string[]) {
    const title = nq(t.title), text = nq(t.text);
    const words = title.split(/[^\p{L}\p{N}]+/u);
    let total = 0;
    for (const tok of tokens) {
        if (words.some(w => w.startsWith(tok))) total += 100;
        else if (title.includes(tok)) total += 60;
        else if (text.includes(tok)) total += 20;
        else return -1;
    }
    return total;
}

export interface Ranked {
    items: Template[];
    tokens: string[];
    layoutNote: string;
}

/** Pinned first (in pin order) when there is no query; otherwise relevance + usage bonus. */
export function rank(query: string, tab: string): Ranked {
    const pool = templates.filter(t => !tab || !t.group || t.group === tab);
    const run = (q: string) => {
        const tokens = nq(q).split(/\s+/).filter(Boolean);
        const scored = pool
            .map((t, i) => ({
                t, i,
                u: data.usage[tkey(t)] ?? { n: 0, last: 0 },
                pin: data.pinned.indexOf(tkey(t)),
                rel: tokens.length ? relevance(t, tokens) : 0,
            }))
            .filter(x => !tokens.length || x.rel >= 0);
        return { tokens, scored };
    };

    let r = run(query);
    let layoutNote = "";
    if (!r.scored.length && query.trim()) {
        const alt = swapLayout(query);
        if (alt) {
            const r2 = run(alt);
            if (r2.scored.length) { r = r2; layoutNote = alt.trim(); }
        }
    }

    const pinScore = (p: number) => (p < 0 ? 0 : r.tokens.length ? 30 : 1e7 - p * 1000);
    const score = (x: typeof r.scored[number]) => x.rel + Math.log2(1 + Math.min(x.u.n, 100)) * 8 + pinScore(x.pin);
    r.scored.sort((a, b) => score(b) - score(a) || b.u.last - a.u.last || a.i - b.i);
    return { items: r.scored.map(x => x.t), tokens: r.tokens, layoutNote };
}
