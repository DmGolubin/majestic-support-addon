/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const PREFIXES = [";", ".", ",", "!"] as const;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "…text ;снр" before the caret → { query: "снр", length: 4 } (length includes the prefix). */
export function findTrigger(before: string, prefix: string): { query: string; length: number; } | null {
    const s = before.replace(/\uFEFF/g, "");
    const p = esc(prefix);
    const m = new RegExp(`(?:^|\\s)${p}([^\\s${p}]{1,40})$`, "u").exec(s);
    return m ? { query: m[1], length: m[1].length + prefix.length } : null;
}
