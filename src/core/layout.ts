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

/** Gap to the viewport edges and between the window and its tooltip. */
export const EDGE = 8;
/** Closed window in side mode: the 358 px list column plus the 1 px borders. */
export const LIST_W = 360;
/** Narrowest readable preview column next to the list. */
export const PREVIEW_MIN = 360;
/** Below this much room the preview cannot be a side column: compact mode. */
export const SIDE_MIN = LIST_W + PREVIEW_MIN;
/** Widest window in side mode (list + preview). */
export const SIDE_MAX = 820;
/** Window width in compact mode (the preview covers the list). */
export const COMPACT_W = 400;
/** Hover tooltip: preferred and narrowest width; narrower than that = no tooltip. */
export const TIP_W = 380, TIP_MIN = 240;

/** Device-local picker preferences, independent of the pinned/temporary preview state. */
export interface WindowSize { width: number; height: number; previewWidth: number; }
export const DEFAULT_WINDOW_SIZE: WindowSize = { width: LIST_W, height: 500, previewWidth: SIDE_MAX - LIST_W };
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi));
export function readWindowSize(value: unknown): WindowSize | null {
    if (!value || typeof value !== "object") return null;
    const s = value as WindowSize;
    if (![s.width, s.height, s.previewWidth].every(n => typeof n === "number" && Number.isFinite(n))) return null;
    return { width: clamp(Math.round(s.width), 320, 720), height: clamp(Math.round(s.height), 280, 1000), previewWidth: clamp(Math.round(s.previewWidth), PREVIEW_MIN, 900) };
}

/** Keep a useful height above the composer; on short viewports slide down before clipping. */
export function windowVertical(viewportH: number, anchorBottom: number, wantedHeight = 500) {
    const available = Math.max(0, viewportH - 2 * EDGE);
    const bottom = clamp(anchorBottom, EDGE, Math.max(EDGE, viewportH - EDGE - Math.min(280, available)));
    return { bottom, height: Math.min(wantedHeight, Math.max(0, viewportH - bottom - EDGE)) };
}

export type LayoutMode = "side" | "compact";

export interface WinLayout {
    mode: LayoutMode;
    /** Window width (border-box). */
    width: number;
    /** Distance from the viewport's right edge. */
    right: number;
    /** Width the window may grow to on its left, viewport-bound. */
    avail: number;
    /** Preview width when shown, 0 when hidden. Side mode: the left column; compact: over the list. */
    previewW: number;
}

/**
 * The templates window: a right-anchored overlay clamped to the VIEWPORT (not to the chat input).
 * `anchorRight` — wanted distance from the viewport's right edge (the chat input's right edge);
 * `wide` — the preview is shown (pinned or Shift peek). The mode depends on the room only, never on
 * `wide`: opening the preview never moves the list.
 */
export function windowLayout(viewportW: number, anchorRight: number, wide: boolean, size?: WindowSize | null): WinLayout {
    const vw = Math.max(0, viewportW);
    const listW = size?.width ?? LIST_W, compactW = size?.width ?? COMPACT_W;
    // The closed window always fits: slide the anchor right (over the member list) when it would not.
    const right0 = Math.max(EDGE, Math.min(anchorRight, vw - EDGE - listW));
    const avail0 = Math.max(0, vw - right0 - EDGE);
    if (avail0 >= listW + PREVIEW_MIN) {
        const width = wide ? Math.min(listW + (size?.previewWidth ?? DEFAULT_WINDOW_SIZE.previewWidth), avail0) : listW;
        return { mode: "side", width, right: right0, avail: avail0, previewW: wide ? width - listW : 0 };
    }
    // Compact: a bit more room than the closed side window if the viewport has it — same width open or closed.
    const right = Math.max(EDGE, Math.min(right0, vw - EDGE - compactW));
    const avail = Math.max(0, vw - right - EDGE);
    const width = Math.min(compactW, avail);
    return { mode: "compact", width, right, avail, previewW: wide ? Math.max(0, width - 2) : 0 };
}

/**
 * Hover tooltip width left of the window (`winRight`/`winW` from `windowLayout`), never off-screen and
 * never over the window; 0 = no room, no tooltip.
 */
export function tipWidth(viewportW: number, winRight: number, winW: number): number {
    const room = viewportW - winRight - winW - 2 * EDGE;
    return room >= TIP_MIN ? Math.min(TIP_W, room) : 0;
}
