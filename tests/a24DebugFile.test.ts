import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticJournal, diagnosticData } from "../src/core/diagnosticJournal";
import * as cost from "../src/core/cost";
import * as ring from "../src/core/ring";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function fixture() {
    const journal = new DiagnosticJournal();
    journal.start({ read: () => null, write: () => {} }, { continuous: true });
    let clock = 100, open = true;
    const output = { debug: vi.fn() };
    const mocks: Record<string, any> = {
        "@shared/vencordUserAgent": {}, "@webpack/common": {}, "../buildInfo": {},
        "../core/diagnosticJournal": { diagnosticJournal: journal, diagnosticData },
        "../core/cost": cost, "../core/ring": ring, "../core/keys": {},
        "../platform": {}, "./inline": {}, "./keylatch": {},
        "./observable": { createObservable(initial: any) { let state = initial; return { get: () => state, set: (patch: any) => { state = { ...state, ...patch }; } }; }, shallowEqual: Object.is },
        "./uiState": { ui: { get: () => ({ windowOpen: open }) }, store: {} },
    };
    const module = { exports: {} as any };
    runInNewContext(ts.transpileModule(readFileSync(new URL("../src/vencord/ui/debug.ts", import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, {
        module, exports: module.exports, require: (name: string) => {
            if (!(name in mocks)) throw Error(name); return mocks[name];
        }, performance: { now: () => clock }, console: output,
        window: { innerWidth: 1000, innerHeight: 800 }, setTimeout, clearTimeout, Date,
        queueMicrotask, requestAnimationFrame: vi.fn(),
    });
    return { api: module.exports, journal, output, time: (n: number) => { clock = n; }, close: () => { open = false; } };
}
const win = { peek: false, view: "all", cat: "SECRET", query: "SECRET", selId: "SECRET", hoveredId: "SECRET", selIdx: 1,
    layout: "side", winW: 700, previewW: 300, avail: 900, tipW: 200 };
describe("A24 file diagnostics without visual debug", () => {
    it("records sanitized geometry without retaining debug ring, queries or console output", () => {
        const h = fixture();
        h.api.setDebugWindow(win); h.api.logGeometry("SECRET");
        h.api.dlog("error", { code: "callback_failed", token: "SECRET" });
        const report = h.api.debugFileSnapshot();
        expect(report.window).toMatchObject({ winW: 700, previewW: 300, mode: "side" });
        expect(h.journal.snapshot().events.some(e => e.event === "ui.geometry")).toBe(true);
        expect(JSON.stringify([report, h.journal.snapshot()])).not.toContain("SECRET");
        expect(h.api.debugState.get().win).toBe(null);
        expect(h.api.debugCount()).toBe(0); expect(h.output.debug).not.toHaveBeenCalled();
    });
    it("throttles geometry changes and ignores query/selection-only changes", () => {
        const h = fixture(); h.api.setDebugWindow(win);
        for (let i = 0; i < 100; i++) h.api.setDebugWindow({ ...win, query: `SECRET${i}`, selIdx: i });
        h.time(1100); h.api.setDebugWindow({ ...win, winW: 800 });
        h.api.setDebugWindow({ ...win, winW: 900 });
        expect(h.journal.snapshot().events.filter(e => e.event === "ui.geometry")).toHaveLength(2);
        expect(h.api.debugFileSnapshot().window.winW).toBe(900);
        h.close(); expect(h.api.debugFileSnapshot().window).toBe(null);
    });
    it("measures search/render while visual debug is off and reports meaningful cost without an idle sampler", async () => {
        const h = fixture();
        h.api.noteSearch(100, 110, "SECRET", 42);
        h.time(140); h.api.costEnd("render", 100);
        let snap = h.api.debugFileSnapshot();
        expect(snap.performance.categories.search.ms).toBe(10);
        expect(snap.performance.categories.render.ms).toBe(40);
        expect(h.journal.snapshot().events.filter(e => e.event === "debug.performance")).toHaveLength(1);
        h.time(200); h.api.costEnd("render", 140);
        expect(h.journal.snapshot().events.filter(e => e.event === "debug.performance")).toHaveLength(1);
        h.close(); await vi.advanceTimersByTimeAsync(2000);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.journal.snapshot().events.filter(e => e.event === "debug.performance")).toHaveLength(1);
        h.time(6200); h.api.costEnd("inline", 6100);
        expect(h.journal.snapshot().events.filter(e => e.event === "debug.performance")).toHaveLength(2);
        expect(h.api.debugCount()).toBe(0); expect(h.output.debug).not.toHaveBeenCalled();
        h.journal.enable(false); h.api.costEnd("render", 6100); h.api.logGeometry("close");
        expect(vi.getTimerCount()).toBe(0);
    });
});
