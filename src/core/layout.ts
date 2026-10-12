/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Top of a box of height `h` that wants to start at `want` but must stay inside [lo, hi]:
 * its bottom never passes `hi`; a box taller than the range aligns its top to `lo`.
 */
export function clampTop(want: number, lo: number, hi: number, h: number): number {
    return Math.max(lo, Math.min(want, hi - h));
}
