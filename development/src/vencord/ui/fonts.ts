/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The panel's fonts (Golos Text, JetBrains Mono) under plugin-only family names ("STX Golos", "STX Mono"),
// so Discord's own text never changes. Loaded from memory: no network, no CSP font-src involved.
import { GOLOS_CYR, GOLOS_LAT, MONO_CYR, MONO_LAT } from "./fontData";

const CYR = "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116";
const LAT = "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";

const bytes = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;

let faces: FontFace[] = [];

export function loadFonts() {
    if (faces.length) return;
    try {
        faces = [
            new FontFace("STX Golos", bytes(GOLOS_CYR), { weight: "400 700", unicodeRange: CYR }),
            new FontFace("STX Golos", bytes(GOLOS_LAT), { weight: "400 700", unicodeRange: LAT }),
            new FontFace("STX Mono", bytes(MONO_CYR), { weight: "400 600", unicodeRange: CYR }),
            new FontFace("STX Mono", bytes(MONO_LAT), { weight: "400 600", unicodeRange: LAT }),
        ];
        for (const f of faces) document.fonts.add(f);
    } catch (e) {
        faces = [];
        console.debug("[SupportTemplates] fonts unavailable, falling back to system fonts", e);
    }
}

export function unloadFonts() {
    for (const f of faces) document.fonts.delete(f);
    faces = [];
}
