import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { DiagnosticJournal, diagnosticData } from "../src/core/diagnosticJournal";
import { createDiagnosticPersistence } from "../src/core/diagnosticPersistence";
import { evaluate, source } from "./betterdiscordHarness";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function fixture(load?: () => Promise<{ path: string; state: string | null }>) {
    const journal = new DiagnosticJournal(), local = new Map(), listeners = new Set(), subscribers = new Set();
    let disk: string | null = null;
    const save = vi.fn(async (report: string) => { disk = report; return { path: "fixture/SupportTemplates-diagnostics.txt" }; });
    const subscribe = (fn: unknown) => { subscribers.add(fn); return () => subscribers.delete(fn); };
    const events = { addEventListener: (_name: string, fn: unknown) => listeners.add(fn), removeEventListener: (_name: string, fn: unknown) => listeners.delete(fn) };
    const api = evaluate(ts.transpileModule(source("src/vencord/ui/diagnostics.ts"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, {
        "../buildInfo": { PLUGIN_VERSION: "1.0.1-canary.28", PLUGIN_BUILD: "test", PLUGIN_DISTRIBUTION: "standalone" },
        "../core/diagnosticJournal": { diagnosticJournal: journal, diagnosticData },
        "../core/diagnosticPersistence": { createDiagnosticPersistence },
        "../diagnosticStorage": { loadDiagnosticStorage: load ?? (async () => ({ path: "fixture/SupportTemplates-diagnostics.txt", state: disk ? JSON.stringify(JSON.parse(disk).journal) : null })), saveDiagnosticStorage: save },
        "./debug": { debugFileSnapshot: () => ({}) },
        "./panel": { panel: { get: () => ({ phase: "ready", sync: "live", persistent: true }), subscribe } },
        "./uiState": { ui: { get: () => ({ compose: [], windowOpen: false, management: false }), subscribe },
            store: { data: { favorites: [], recent: [], binds: {} }, templates: [], subscribe } }
    }, { Date, navigator: { onLine: true }, window: { ...events, innerWidth: 1000, innerHeight: 800,
        localStorage: { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => local.set(key, value) } },
    document: { ...events, visibilityState: "visible" } });
    return { api, journal, save, local, listeners, subscribers, disk: () => disk };
}
describe("file diagnostics plugin lifecycle", () => {
    it("records startup automatically, saves on stop, restores deadline and honors opt-out across restart", async () => {
        const h = fixture(); await h.api.startDiagnostics();
        expect(h.journal.active).toBe(true);
        const deadline = h.journal.campaignEndsAt;
        expect(deadline).toBe(Date.now() + 4 * 86400_000);
        h.journal.record("request.failure", { route: "/me", status: 401, code: "session_revoked", token: "SECRET" }, true);
        h.api.stopDiagnostics(); await vi.advanceTimersByTimeAsync(0);
        expect(h.listeners.size).toBe(0); expect(h.subscribers.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
        expect(h.disk()).not.toContain("SECRET");
        expect(JSON.parse(h.disk()!).journal.events.at(-1).event).toBe("runtime.stop");
        await vi.advanceTimersByTimeAsync(3600_000);
        await h.api.startDiagnostics();
        expect(h.journal.campaignEndsAt).toBe(deadline);
        h.api.setRecording(false); h.api.stopDiagnostics(); await vi.advanceTimersByTimeAsync(0);
        await h.api.startDiagnostics(); expect(h.journal.active).toBe(false);
        expect(h.journal.campaignEndsAt).toBe(deadline);
        h.api.stopDiagnostics(); await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
    });
    it("a stop during native initialization cannot add listeners or restart the journal", async () => {
        let resolve!: (value: { path: string; state: null }) => void;
        const h = fixture(() => new Promise(r => { resolve = r; }));
        const starting = h.api.startDiagnostics(); await Promise.resolve();
        h.api.stopDiagnostics(); resolve({ path: "late.txt", state: null }); await starting;
        expect(h.journal.active).toBe(false); expect(h.listeners.size).toBe(0); expect(h.subscribers.size).toBe(0);
        expect(h.save).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    });
    it("clearing from the disabled-plugin settings also clears the automatic file", async () => {
        const h = fixture(); await h.api.startDiagnostics();
        h.journal.record("auth.terminated", { code: "session_revoked" }, true);
        h.api.stopDiagnostics(); await vi.advanceTimersByTimeAsync(0);
        h.journal.clear(); await vi.advanceTimersByTimeAsync(0);
        expect(JSON.parse(h.disk()!).journal.events).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });
});
