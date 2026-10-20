// SPDX-License-Identifier: GPL-3.0-or-later
import { EDGE } from "./layout";

export interface WindowPosition { right: number; bottom: number; pinned: boolean; }
export interface FloatingBox { right: number; bottom: number; width: number; height: number; }
export type WindowEdge = "n" | "s" | "w" | "e" | "nw" | "ne" | "sw" | "se";
export const WINDOW_EDGES: WindowEdge[] = ["n", "s", "w", "e", "nw", "ne", "sw", "se"];
// Keep the Discord title bar available even when a window is dragged to the top.
export const WINDOW_TOP = 32;
export function readWindowPosition(value: unknown): WindowPosition | null {
    if (!value || typeof value !== "object") return null;
    const p = value as WindowPosition;
    if (![p.right, p.bottom].every(n => typeof n === "number" && Number.isFinite(n)) || typeof p.pinned !== "boolean") return null;
    return { right: Math.max(EDGE, Math.min(20000, p.right)), bottom: Math.max(EDGE, Math.min(20000, p.bottom)), pinned: p.pinned };
}
export function clampFloatingBox(box: FloatingBox, vw: number, vh: number): FloatingBox {
    const width = Math.max(0, Math.min(box.width, vw - EDGE * 2));
    const height = Math.max(0, Math.min(box.height, vh - WINDOW_TOP - EDGE));
    return { width, height,
        right: Math.max(EDGE, Math.min(box.right, vw - EDGE - width)),
        bottom: Math.max(EDGE, Math.min(box.bottom, vh - WINDOW_TOP - height)) };
}
export function moveFloatingBox(box: FloatingBox, dx: number, dy: number, vw: number, vh: number) {
    return clampFloatingBox({ ...box, right: box.right - dx, bottom: box.bottom - dy }, vw, vh);
}
/** Move the chosen edges, preserving the opposite edge until constrained by viewport/minimum size. */
export function resizeFloatingBox(box: FloatingBox, edge: WindowEdge, dx: number, dy: number,
    vw: number, vh: number, maxWidth: number, minWidth = 320): FloatingBox {
    const b = clampFloatingBox(box, vw, vh);
    const left = vw - b.right - b.width, top = vh - b.bottom - b.height;
    let l = left, r = vw - b.right, t = top, bottom = vh - b.bottom;
    const minW = Math.min(minWidth, vw - EDGE * 2), minH = Math.min(280, vh - WINDOW_TOP - EDGE);
    if (edge.includes("w")) l = Math.max(EDGE, Math.min(r - minW, Math.max(r - maxWidth, l + dx)));
    if (edge.includes("e")) r = Math.min(vw - EDGE, Math.max(l + minW, Math.min(l + maxWidth, r + dx)));
    if (edge.includes("n")) t = Math.max(WINDOW_TOP, Math.min(bottom - minH, Math.max(bottom - 1000, t + dy)));
    if (edge.includes("s")) bottom = Math.min(vh - EDGE, Math.max(t + minH, Math.min(t + 1000, bottom + dy)));
    return { right: vw - r, bottom: vh - bottom, width: r - l, height: bottom - t };
}
