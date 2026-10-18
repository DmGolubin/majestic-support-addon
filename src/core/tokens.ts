/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Same token grammar as the panel's Templates page: {{name}}, {{name=default}}, {{name|a|b}}, {|}.
// Whitespace is trimmed after matching, without overlapping quantified groups.
const TOKEN = /\{\{([^}|=]+)(?:=([^}|]*))?(\|[^}]*)?\}\}/y;
const DATE_TIME = /^(date|time)(?:([+-])(\d+)([mhdw]))?$/i;
const BUILTIN = new Set(["clipboard", "selection", "url", "title"]);
const UNIT_MS: Record<string, number> = { m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };

export interface FieldSpec { name: string; def: string; options: string[]; }
export interface Env { now: Date; clipboard: string; selection: string; url: string; title: string; }

/** Scan source syntax once; cache the nearest } even for malformed/nested openers. */
export function* templateTokens(text: string): Generator<{ raw: string; index: number; name?: string; def?: string; opts?: string; }> {
    const openings = /\{\{|\{\|\}|\[\[greeting:end\]\]/g;
    const token = new RegExp(TOKEN.source, "y");
    let close = -1, exhausted = false;
    for (let m; (m = openings.exec(text));) {
        if (m[0] !== "{{") { yield { raw: m[0], index: m.index }; continue; }
        openings.lastIndex = m.index + 1; // A failed opener can overlap another token/caret.
        if (exhausted) continue;
        if (close < m.index + 2) {
            close = text.indexOf("}", m.index + 2);
            if (close < 0) { exhausted = true; continue; }
        }
        if (text[close + 1] !== "}") continue;
        token.lastIndex = m.index;
        const match = token.exec(text);
        if (!match) continue;
        openings.lastIndex = token.lastIndex;
        yield { raw: match[0], index: m.index, name: match[1], def: match[2], opts: match[3] };
    }
}

const isBuiltin = (name: string) => DATE_TIME.test(name) || BUILTIN.has(name.toLowerCase());
const pad = (n: number) => String(n).padStart(2, "0");
export const fmtDate = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
export const fmtTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function fieldsOf(text: string): FieldSpec[] {
    const out: FieldSpec[] = [];
    const seen = new Set<string>();
    for (const m of templateTokens(text)) {
        if (m.name === undefined) continue;
        const name = m.name.trim();
        if (isBuiltin(name) || seen.has(name)) continue;
        seen.add(name);
        out.push({
            name,
            def: (m.def ?? "").trim(),
            options: m.opts ? m.opts.slice(1).split("|").map(s => s.trim()).filter(Boolean) : [],
        });
    }
    return out;
}

export function fill(text: string, values: Record<string, string>, env: Env): { text: string; caret: number | null; } {
    const resolve = (rawName: string, def: string | undefined, opts: string | undefined, raw: string): string => {
        const name = rawName.trim();
        const dt = DATE_TIME.exec(name);
        if (dt) {
            const shift = dt[2] ? (dt[2] === "-" ? -1 : 1) * Number(dt[3]) * UNIT_MS[dt[4].toLowerCase()] : 0;
            const d = new Date(env.now.getTime() + shift);
            if (!Number.isFinite(d.getTime())) return raw;
            return dt[1].toLowerCase() === "date" ? fmtDate(d) : fmtTime(d);
        }
        const key = name.toLowerCase();
        if (BUILTIN.has(key)) return env[key as "clipboard" | "selection" | "url" | "title"];
        if (Object.prototype.hasOwnProperty.call(values, name)) return values[name]; // never inherited (__proto__, toString…)
        if (def?.trim()) return def.trim();
        if (opts) return opts.slice(1).split("|").map(s => s.trim()).filter(Boolean)[0] ?? "";
        return "";
    };
    let caret: number | null = null;
    let end = 0, length = 0;
    const parts: string[] = [];
    // Match only source syntax: replacement values (including clipboard) stay literal.
    for (const m of templateTokens(text)) {
        const before = text.slice(end, m.index);
        parts.push(before); length += before.length;
        if (m.raw === "{|}") caret ??= length;
        else {
            const value = m.name === undefined ? m.raw : resolve(m.name, m.def, m.opts, m.raw);
            parts.push(value); length += value.length;
        }
        end = m.index + m.raw.length;
    }
    parts.push(text.slice(end));
    return { text: parts.join(""), caret };
}
