/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Same token grammar as the panel's Templates page: {{name}}, {{name=default}}, {{name|a|b}}, {|}.
const TOKEN = /\{\{\s*([^}|=]+?)\s*(?:=\s*([^}|]*?)\s*)?(\|[^}]*)?\s*\}\}/g;
const DATE_TIME = /^(date|time)(?:([+-])(\d+)([mhdw]))?$/i;
const BUILTIN = new Set(["clipboard", "selection", "url", "title"]);
const UNIT_MS: Record<string, number> = { m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };

export interface FieldSpec { name: string; def: string; options: string[]; }
export interface Env { now: Date; clipboard: string; selection: string; url: string; title: string; }

const isBuiltin = (name: string) => DATE_TIME.test(name) || BUILTIN.has(name.toLowerCase());
const pad = (n: number) => String(n).padStart(2, "0");
export const fmtDate = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
export const fmtTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function fieldsOf(text: string): FieldSpec[] {
    const out: FieldSpec[] = [];
    for (const m of text.matchAll(TOKEN)) {
        const name = m[1].trim();
        if (isBuiltin(name) || out.some(f => f.name === name)) continue;
        out.push({
            name,
            def: (m[2] ?? "").trim(),
            options: m[3] ? m[3].slice(1).split("|").map(s => s.trim()).filter(Boolean) : [],
        });
    }
    return out;
}

export function fill(text: string, values: Record<string, string>, env: Env): { text: string; caret: number | null; } {
    let out = text.replace(TOKEN, (_all, rawName: string, def: string | undefined, opts: string | undefined) => {
        const name = rawName.trim();
        const dt = DATE_TIME.exec(name);
        if (dt) {
            const shift = dt[2] ? (dt[2] === "-" ? -1 : 1) * Number(dt[3]) * UNIT_MS[dt[4].toLowerCase()] : 0;
            const d = new Date(env.now.getTime() + shift);
            return dt[1].toLowerCase() === "date" ? fmtDate(d) : fmtTime(d);
        }
        const key = name.toLowerCase();
        if (BUILTIN.has(key)) return env[key as "clipboard" | "selection" | "url" | "title"];
        if (Object.prototype.hasOwnProperty.call(values, name)) return values[name]; // never inherited (__proto__, toString…)
        if (def) return def.trim();
        if (opts) return opts.slice(1).split("|").map(s => s.trim()).filter(Boolean)[0] ?? "";
        return "";
    });
    const i = out.indexOf("{|}");
    out = out.replace(/\{\|\}/g, "");
    return { text: out, caret: i >= 0 ? i : null };
}
