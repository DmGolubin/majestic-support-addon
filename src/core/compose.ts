/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { splitGreeting, stripMarker } from "./text";

/** Greeting stays only in the first piece; pieces are separated by a blank line. */
export function joinPieces(texts: string[]): string {
    return texts
        .map((t, i) => (i === 0 ? stripMarker(t) : splitGreeting(t).body))
        .map(s => s.trim())
        .filter(Boolean)
        .join("\n\n");
}
