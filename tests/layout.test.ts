import { describe, expect, it } from "vitest";
import { clampTop, COMPACT_W, DEFAULT_WINDOW_SIZE, EDGE, LIST_W, readWindowSize, SIDE_MAX, tipWidth, TIP_W, windowLayout, windowVertical } from "../src/core/layout";

// Window spans y = 100…600 (500 px).
describe("clampTop", () => {
    it("keeps the row's top when the box fits", () => {
        expect(clampTop(200, 100, 600, 300)).toBe(200);
    });
    it("never lets the box go below the window's bottom edge", () => {
        expect(clampTop(520, 100, 600, 300)).toBe(300);
        expect(clampTop(520, 100, 600, 300) + 300).toBe(600);
    });
    it("never goes above the window's top", () => {
        expect(clampTop(40, 100, 600, 120)).toBe(100);
    });
    it("a box taller than the window aligns to the window's top", () => {
        expect(clampTop(450, 100, 300, 320)).toBe(100);
    });
});

describe("windowLayout", () => {
    it("wide screen: side mode, full 820 px with the preview, 360 closed", () => {
        const open = windowLayout(1920, 260, true);
        expect(open).toMatchObject({ mode: "side", width: SIDE_MAX, right: 260, previewW: SIDE_MAX - LIST_W });
        expect(windowLayout(1920, 260, false)).toMatchObject({ mode: "side", width: LIST_W, right: 260, previewW: 0 });
    });

    it("user report: ~1100 px viewport with the member list — clamps to the viewport, not the chat input", () => {
        // Chat input right edge at 860 → anchor 240; room to the left = 1100 - 240 - 8 = 852.
        const l = windowLayout(1100, 240, true);
        expect(l.mode).toBe("side");
        expect(l.avail).toBe(852);
        expect(l.width).toBe(SIDE_MAX);
        expect(l.previewW).toBeGreaterThanOrEqual(320);
    });

    it("side mode never gives the preview less than 320 px", () => {
        for (let vw = 300; vw <= 2000; vw += 7) {
            for (const anchor of [0, 8, 120, 240, 400]) {
                const l = windowLayout(vw, anchor, true);
                if (l.mode === "side") expect(l.previewW).toBeGreaterThanOrEqual(320);
            }
        }
    });

    it("mode switches at 720 px of room", () => {
        expect(windowLayout(8 + 720 + 8, 8, true).mode).toBe("side");
        expect(windowLayout(8 + 719 + 8, 8, true).mode).toBe("compact");
    });

    it("compact: 400 px, same width open or closed (the list never jumps)", () => {
        const open = windowLayout(800, 240, true), closed = windowLayout(800, 240, false);
        expect(open.mode).toBe("compact");
        expect(open.width).toBe(COMPACT_W);
        expect(closed.width).toBe(open.width);
        expect(closed.right).toBe(open.right);
        expect(open.previewW).toBe(COMPACT_W - 2);
        expect(closed.previewW).toBe(0);
    });

    it("the mode and the list position do not depend on whether the preview is shown", () => {
        for (const vw of [500, 760, 800, 1100, 1400]) {
            const a = windowLayout(vw, 240, true), b = windowLayout(vw, 240, false);
            expect(a.mode).toBe(b.mode);
            expect(a.right).toBe(b.right);
        }
    });

    it("never off-screen on the left, never past the right edge", () => {
        for (let vw = 200; vw <= 1600; vw += 13) {
            for (const anchor of [-50, 0, 8, 240, 900]) {
                for (const wide of [true, false]) {
                    const l = windowLayout(vw, anchor, wide);
                    expect(l.right).toBeGreaterThanOrEqual(EDGE);
                    expect(vw - l.right - l.width).toBeGreaterThanOrEqual(EDGE);
                }
            }
        }
    });

    it("slides right over the member list when the anchor leaves too little room", () => {
        // 760 px viewport, anchor 400: 760 - 400 - 8 = 352 < 360 → slides to fit 400 px compact.
        const l = windowLayout(760, 400, false);
        expect(l.mode).toBe("compact");
        expect(l.width).toBe(COMPACT_W);
        expect(l.right).toBe(760 - EDGE - COMPACT_W);
    });

    it("tiny viewport: the window shrinks to the viewport minus the gaps", () => {
        const l = windowLayout(300, 240, true);
        expect(l.mode).toBe("compact");
        expect(l.right).toBe(EDGE);
        expect(l.width).toBe(300 - 2 * EDGE);
    });
});

describe("tipWidth", () => {
    it("full width when there is room on the left", () => {
        expect(tipWidth(1920, 260, 360)).toBe(TIP_W);
    });
    it("shrinks to the room between the viewport edge and the window", () => {
        // 1000 - 240 - 360 - 16 = 384 → full; 900 → 284.
        expect(tipWidth(1000, 240, 360)).toBe(TIP_W);
        expect(tipWidth(900, 240, 360)).toBe(284);
    });
    it("no room → no tooltip", () => {
        expect(tipWidth(800, 240, 400)).toBe(0);
        expect(tipWidth(760, 352, 400)).toBe(0);
    });
});

describe("resized picker geometry", () => {
    it("rejects corrupt saved dimensions and clamps finite preferences to reasonable bounds", () => {
        for (const value of [null, [], "500", {}, { width: "400", height: 500, previewWidth: 460 }, { width: Infinity, height: 500, previewWidth: 460 }]) {
            expect(readWindowSize(value)).toBeNull();
        }
        expect(readWindowSize({ width: -10, height: 1e10, previewWidth: 1 })).toEqual({ width: 320, height: 1000, previewWidth: 360 });
        expect(readWindowSize({ width: 500.4, height: 640.6, previewWidth: 1e10 })).toEqual({ width: 500, height: 641, previewWidth: 900 });
    });
    it("keeps the right-anchored list stable for pinned/temporary previews after a resize", () => {
        const size = { width: 500, height: 700, previewWidth: 600 };
        const closed = windowLayout(1600, 240, false, size), open = windowLayout(1600, 240, true, size);
        expect(closed.width).toBe(500); expect(open.width).toBe(1100);
        expect(open.width - open.previewW).toBe(closed.width);
        expect(open.right).toBe(closed.right);
        const compact = windowLayout(800, 240, true, size);
        expect(compact.mode).toBe("compact");
        expect(compact.width).toBe(windowLayout(800, 240, false, size).width);
    });
    it("bounds both axes even with tall composers, zoomed viewports and extreme saved sizes", () => {
        for (const vw of [120, 280, 480, 800, 1400, 2400]) for (const vh of [100, 300, 500, 1080]) {
            for (const anchor of [-100, 80, 240, 1800]) for (const wide of [false, true]) {
                const size = readWindowSize({ width: 1e5, height: 1e5, previewWidth: 1e5 })!;
                const horizontal = windowLayout(vw, anchor, wide, size), vertical = windowVertical(vh, anchor, size.height);
                expect(horizontal.right).toBeGreaterThanOrEqual(EDGE);
                expect(horizontal.right + horizontal.width).toBeLessThanOrEqual(vw - EDGE);
                expect(vertical.bottom).toBeGreaterThanOrEqual(EDGE);
                expect(vertical.height).toBeGreaterThanOrEqual(0);
                expect(vertical.bottom + vertical.height).toBeLessThanOrEqual(vh - EDGE);
            }
        }
        expect(DEFAULT_WINDOW_SIZE.height).toBe(500);
    });
});
