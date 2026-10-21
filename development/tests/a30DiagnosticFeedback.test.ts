import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticJournal, diagnosticData } from "../src/core/diagnosticJournal";
import * as cost from "../src/core/cost";
import * as ring from "../src/core/ring";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function fixture() {
    vi.useFakeTimers();
    const journal = new DiagnosticJournal();
    const writes: any[] = [];
    const mocks: Record<string, any> = {
        "@shared/vencordUserAgent": {}, "@webpack/common": {}, "../buildInfo": {},
        "../core/diagnosticJournal": { diagnosticJournal: journal, diagnosticData },
        "../core/cost": cost, "../core/ring": ring, "../core/keys": {},
        "../platform": {}, "./inline": {}, "./keylatch": {},
        "./observable": { createObservable(initial: any) {
            let state = initial;
            return { get: () => state, set: (patch: any) => { state = { ...state, ...patch }; } };
        }, shallowEqual: Object.is },
        "./uiState": { ui: { get: () => ({ windowOpen: false }) }, store: {} },
    };
    let clock = 100, observeSave = false;
    const exports: any = {};
    runInNewContext(ts.transpileModule(readFileSync(new URL("../src/vencord/ui/debug.ts", import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports, require: (id: string) => {
        if (!(id in mocks)) throw Error(id); return mocks[id];
    }, performance: { now: () => clock }, console: { debug() {} }, Date, setTimeout, clearTimeout,
    window: { innerWidth: 1000, innerHeight: 800 }, queueMicrotask });
    journal.start({ read: () => null, write: value => {
        writes.push(JSON.parse(value));
        // PerformanceObserver delivers the long task after the writing task.
        if (observeSave) setTimeout(() => {
            exports.dlog("longtask", { ms: 150 });
            const start = clock; clock += 6000;
            exports.costEnd("debug", start);
        }, 0);
    } }, { continuous: true });
    writes.length = 0;
    return { journal, api: exports, writes, feedback: () => { observeSave = true; } };
}

describe("A30 diagnostic persistence feedback", () => {
    it("does not turn a save's longtask/performance observation into another scheduled save", async () => {
        const h = fixture(); h.feedback();
        h.journal.record("ui.state", { windowOpen: true });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.writes).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(h.journal.snapshot().events.some(e => e.data.event === "longtask")).toBe(true);
        expect(h.journal.snapshot().events.some(e => e.event === "debug.performance")).toBe(true);
        h.journal.record("request.start", { method: "GET", route: "/me" });
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.writes).toHaveLength(2);
        expect(h.writes[1].events.some((e: any) => e.data.event === "longtask")).toBe(true);
        expect(h.writes[1].events.some((e: any) => e.event === "debug.performance")).toBe(true);
    });
    it("keeps passive telemetry bounded and flushes it on explicit export or shutdown", () => {
        const h = fixture();
        for (let i = 0; i < 2100; i++) h.api.dlog("longtask", { ms: 100 + i });
        expect(h.writes).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(h.journal.size).toBe(2000);
        expect(h.journal.snapshot().dropped).toBeGreaterThan(0);
        h.journal.flush();
        expect(h.writes[0].events.at(-1).data.event).toBe("longtask");
        h.api.dlog("longtask", { ms: 333 });
        h.journal.stop();
        expect(h.writes.at(-1).events.some((e: any) => e.data.ms === 333)).toBe(true);
        expect(h.writes.at(-1).events.at(-1).event).toBe("runtime.stop");
    });
    it("preserves urgent delivery and already scheduled ordinary flushes", async () => {
        const h = fixture();
        h.journal.record("ui.state");
        h.api.dlog("longtask", { ms: 123 });
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.writes).toHaveLength(1);
        expect(h.writes[0].events.at(-1).data.ms).toBe(123);
        h.journal.record("debug", { event: "error" }, true, true);
        expect(h.writes).toHaveLength(2);
    });
});
