/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { soft } from "./text";
import { ProjectId, Template, Usage } from "./types";

export function projectOfGroup(group: string): ProjectId | null {
    const g = soft(group);
    if (/majestic|маджестик/.test(g)) return "mj";
    if (/росси|russia/.test(g)) return "ro";
    return null;
}

/** Same key as 0.5.1 ("group||title") so its usage/pins/binds carry over. */
export const localId = (group: string, title: string) => `local:${group}||${title}`;

function mk(group: string, title: string, text: string): Template {
    return {
        id: localId(group, title), project: projectOfGroup(group), title, text,
        category: null, status: "actual", statusNote: null, teamUses: 0,
        command: null, color: null, updatedAt: null, source: "local",
    };
}

export function parseRaw(raw: string): Template[] {
    const src = String(raw ?? "").replace(/\r/g, "").trim();
    if (!src) return [];

    if (src.startsWith("[")) {
        try {
            const arr = JSON.parse(src) as any[];
            return arr
                .map(x => mk(String(x.group ?? "").trim(), String(x.title ?? x.name ?? "").trim(), String(x.text ?? x.content ?? "").trim()))
                .filter(t => t.title && t.text);
        } catch { /* not JSON — parse as text */ }
    }

    const out: Template[] = [];
    let cur: { title: string; group: string; lines: string[]; } | null = null;
    let group = "";
    const flush = () => {
        if (!cur) return;
        const text = cur.lines.join("\n").trim();
        if (text) out.push(mk(cur.group, cur.title, text));
    };
    for (const rawLine of src.split("\n")) {
        const esc = /^\\#{1,6}\s/.test(rawLine);
        const line = esc ? rawLine.slice(1) : rawLine;
        const t = esc ? null : line.match(/^###\s+(.+?)\s*$/);
        const g = esc ? null : line.match(/^##\s+(.+?)\s*$/);
        if (t) { flush(); cur = { title: t[1], group, lines: [] }; }
        else if (g) { flush(); cur = null; group = g[1]; }
        else if (cur) cur.lines.push(line);
    }
    flush();
    return out;
}

export interface ImportResult {
    raw: string;
    templates: Template[];
    favorites: string[];
    usage: Record<string, Usage>;
    binds: Record<string, string>;
}

/** Accepts the 0.5.1 config/backup JSON ({raw, usage, pinned, binds}), a JSON array or plain text. */
export function importBackup(text: string): ImportResult {
    let obj: any = null;
    try { obj = JSON.parse(text); } catch { /* plain text */ }
    const isObj = obj && typeof obj === "object" && !Array.isArray(obj);
    const raw: string = isObj ? (typeof obj.raw === "string" ? obj.raw : "") : String(text);
    const templates = parseRaw(raw);
    if (!templates.length) throw new Error("Не нашёл ни одного шаблона");

    const ids = new Set(templates.map(t => t.id));
    const toId = (k: string) => "local:" + k;

    const favorites: string[] = [];
    const pinned = isObj ? obj.pinned : null;
    const pinKeys: string[] = Array.isArray(pinned) ? pinned : pinned && typeof pinned === "object" ? Object.keys(pinned).filter(k => pinned[k]) : [];
    for (const k of pinKeys) if (typeof k === "string" && ids.has(toId(k)) && !favorites.includes(toId(k))) favorites.push(toId(k));

    const usage: Record<string, Usage> = {};
    if (isObj && obj.usage && typeof obj.usage === "object") {
        for (const [k, v] of Object.entries<any>(obj.usage)) {
            const n = Math.floor(Number(v?.n));
            if (ids.has(toId(k)) && n > 0) usage[toId(k)] = { n, last: Number(v?.last) || 0 };
        }
    }

    const binds: Record<string, string> = {};
    if (isObj && obj.binds && typeof obj.binds === "object") {
        for (const [k, v] of Object.entries<any>(obj.binds)) if (ids.has(toId(k)) && typeof v === "string") binds[toId(k)] = v;
    }

    return { raw, templates, favorites, usage, binds };
}
