// SPDX-License-Identifier: GPL-3.0-or-later
import { React, useEffect, useRef, useState } from "@webpack/common";
import { DEFAULT_WINDOW_SIZE, WindowSize } from "../core/layout";
import { beginInteraction } from "../core/interactionIdle";
import { FloatingBox, moveFloatingBox, readWindowPosition, resizeFloatingBox, WINDOW_EDGES, WindowEdge, WindowPosition } from "../core/windowPlacement";
import { storage } from "../platform";

const KEY = "SupportTemplates_windowPlacement_v1";
let write = Promise.resolve();
export function useWindowPlacement() {
    const [position, update] = useState<WindowPosition | null>(null);
    const touched = useRef(false);
    useEffect(() => {
        let live = true;
        void write.then(() => storage.get(KEY)).then(value => { if (live && !touched.current) update(readWindowPosition(value)); }).catch(() => {});
        return () => { live = false; };
    }, []);
    const set = (value: WindowPosition | null, persist = true) => {
        touched.current = true; update(value);
        if (persist) write = write.then(() => storage.set(KEY, value)).catch(() => {});
    };
    return { position, set };
}
type Placement = ReturnType<typeof useWindowPlacement>;
const EDGE_NAMES: Record<WindowEdge, string> = { n: "сверху", s: "снизу", w: "слева", e: "справа", nw: "слева сверху", ne: "справа сверху", sw: "слева снизу", se: "справа снизу" };

export function WindowPlacementControls({ placement, box, size, side, setSize, saveSize, onPointerFinish }: {
    placement: Placement; box: FloatingBox; size: WindowSize | null; side: boolean;
    setSize(size: WindowSize | null): void; saveSize(size: WindowSize): void;
    onPointerFinish?(): void;
}) {
    const drag = useRef<{
        pointerId: number; el: HTMLButtonElement; x: number; y: number; edge: WindowEdge | null;
        box: FloatingBox; before: WindowPosition | null; size: WindowSize | null; next: FloatingBox; side: boolean;
        endInteraction(): void;
    } | null>(null);
    const frame = useRef<number | null>(null);
    const cancelFrame = () => {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
    };
    const sizeFor = (b: FloatingBox, original: WindowSize | null, useSide = side) => {
        const base = original ?? DEFAULT_WINDOW_SIZE;
        return { ...base, height: b.height, ...(useSide ? { previewWidth: Math.max(360, b.width - base.width) } : { width: b.width }) };
    };
    const finish = (commit: boolean) => {
        const d = drag.current; if (!d) return;
        drag.current = null;
        cancelFrame();
        d.endInteraction();
        if (d.el.hasPointerCapture?.(d.pointerId)) d.el.releasePointerCapture(d.pointerId);
        // Pointer focus is only needed for Escape during the gesture. Return it
        // to search so the menu-control guard no longer suppresses Shift preview.
        // Keyboard-only placement keeps focus; a newer focus elsewhere wins.
        if (onPointerFinish && d.el.ownerDocument.activeElement === d.el) onPointerFinish();
        const moved = d.next.right !== d.box.right || d.next.bottom !== d.box.bottom || d.next.width !== d.box.width || d.next.height !== d.box.height;
        if (commit && !moved) { placement.set(d.before, false); if (d.edge) setSize(d.size); return; }
        if (commit) {
            placement.set({ right: d.next.right, bottom: d.next.bottom, pinned: false });
            if (d.edge) {
                const nextSize = sizeFor(d.next, d.size, d.side);
                setSize(nextSize); saveSize(nextSize);
            }
        } else { placement.set(d.before, false); if (d.edge) setSize(d.size); }
    };
    const latestFinish = useRef(finish); latestFinish.current = finish;
    useEffect(() => {
        const cancel = () => latestFinish.current(false);
        window.addEventListener("blur", cancel);
        return () => { window.removeEventListener("blur", cancel); const d = drag.current; drag.current = null; cancelFrame();
            d?.endInteraction();
            if (d?.el.hasPointerCapture?.(d.pointerId)) d.el.releasePointerCapture(d.pointerId); };
    }, []);
    const start = (e: React.PointerEvent<HTMLButtonElement>, edge: WindowEdge | null) => {
        if (e.button !== 0 || drag.current) return;
        e.preventDefault(); e.stopPropagation(); e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { pointerId: e.pointerId, el: e.currentTarget, x: e.clientX, y: e.clientY, edge,
            box, before: placement.position, size, next: box, side, endInteraction: beginInteraction() };
    };
    const apply = (b: FloatingBox, edge: WindowEdge | null, original: WindowSize | null, persist: boolean, useSide = side) => {
        placement.set({ right: b.right, bottom: b.bottom, pinned: false }, persist);
        if (edge) { const s = sizeFor(b, original, useSide); setSize(s); if (persist) saveSize(s); }
    };
    const move = (e: React.PointerEvent) => {
        const d = drag.current; if (!d || d.pointerId !== e.pointerId) return;
        const minWidth = d.side ? (d.size?.width ?? DEFAULT_WINDOW_SIZE.width) + 360 : 320;
        d.next = d.edge ? resizeFloatingBox(d.box, d.edge, e.clientX - d.x, e.clientY - d.y, window.innerWidth, window.innerHeight, d.side ? (d.size?.width ?? DEFAULT_WINDOW_SIZE.width) + 900 : 720, minWidth)
            : moveFloatingBox(d.box, e.clientX - d.x, e.clientY - d.y, window.innerWidth, window.innerHeight);
        // High-frequency pointers can deliver several samples per paint. Keep the
        // final geometry synchronously, but render the catalog at most once/frame.
        if (frame.current === null) frame.current = requestAnimationFrame(() => {
            frame.current = null;
            if (drag.current === d) apply(d.next, d.edge, d.size, false, d.side);
        });
    };
    const key = (e: React.KeyboardEvent, edge: WindowEdge | null) => {
        if (e.key === "Escape" && drag.current) { e.preventDefault(); e.stopPropagation(); finish(false); return; }
        if (drag.current) { if (e.key.startsWith("Arrow")) { e.preventDefault(); e.stopPropagation(); } return; }
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        const step = e.shiftKey ? 40 : 20, dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const b = edge ? resizeFloatingBox(box, edge, dx, dy, window.innerWidth, window.innerHeight, side ? (size?.width ?? DEFAULT_WINDOW_SIZE.width) + 900 : 720,
            side ? (size?.width ?? DEFAULT_WINDOW_SIZE.width) + 360 : 320)
            : moveFloatingBox(box, dx, dy, window.innerWidth, window.innerHeight);
        apply(b, edge, size, true);
    };
    const pointer = {
        onPointerMove: move,
        onPointerUp: (e: React.PointerEvent) => { if (drag.current?.pointerId === e.pointerId) finish(true); },
        onPointerCancel: (e: React.PointerEvent) => { if (drag.current?.pointerId === e.pointerId) finish(false); },
        onLostPointerCapture: (e: React.PointerEvent) => { if (drag.current?.pointerId === e.pointerId) finish(false); },
    };
    return <>
        <div className="vc-stx-placement">
            <button type="button" data-stx-menu-control className="vc-stx-drag-window"
                aria-label="Переместить окно" title="Перетащите окно или используйте стрелки" onPointerDown={e => start(e, null)} onKeyDown={e => key(e, null)} {...pointer}>
                <svg width="18" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
                    <circle cx="7" cy="8" r="1.5" /><circle cx="12" cy="8" r="1.5" /><circle cx="17" cy="8" r="1.5" />
                    <circle cx="7" cy="16" r="1.5" /><circle cx="12" cy="16" r="1.5" /><circle cx="17" cy="16" r="1.5" />
                </svg>
            </button>
            <button type="button" data-stx-menu-control aria-label="Сбросить положение и размер окна" title="Вернуть окно к полю ввода и сбросить размер"
                onClick={() => { placement.set(null); setSize(null); saveSize(DEFAULT_WINDOW_SIZE); }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                    <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />
                </svg>
            </button>
        </div>
        {WINDOW_EDGES.map(edge => <button type="button" key={edge} data-stx-menu-control className={`vc-stx-frame-resize edge-${edge}`}
            aria-label={`Изменить размер ${EDGE_NAMES[edge]}`} title={`Размер ${EDGE_NAMES[edge]}: потяните край или используйте стрелки`}
            onPointerDown={e => start(e, edge)} onKeyDown={e => key(e, edge)} {...pointer} />)}
    </>;
}
