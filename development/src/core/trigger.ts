/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** One explicit punctuation character; no slash commands, mentions or whitespace. */
export const validPrefix = (value: unknown): value is string => typeof value === "string" && /^[!#$%&*+.,:;=?^~_-]$/.test(value);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "…text ;снр" before the caret → { query: "снр", length: 4 } (length includes the prefix). */
export function findTrigger(before: string, prefix: string): { query: string; length: number; } | null {
    const s = before.replace(/\uFEFF/g, "");
    const p = esc(prefix);
    const m = new RegExp(`(?:^|\\s)${p}([^\\s${p}]{1,40})$`, "u").exec(s);
    // The query ignores Slate's zero-width characters, but DOM selection consumes the original UTF-16 range.
    return m ? { query: m[1], length: before.length - before.lastIndexOf(prefix) } : null;
}
