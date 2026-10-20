// SPDX-License-Identifier: GPL-3.0-or-later
import { PLUGIN_BUILD, PLUGIN_DISTRIBUTION, PLUGIN_VERSION } from "../buildInfo";
import { diagnosticJournal as journal, diagnosticData } from "../core/diagnosticJournal";
import { createDiagnosticPersistence, DiagnosticFileStatus } from "../core/diagnosticPersistence";
import { loadDiagnosticStorage, saveDiagnosticStorage } from "../diagnosticStorage";
import { debugFileSnapshot } from "./debug";
import { panel } from "./panel";
import { store, ui } from "./uiState";

const KEY = "SupportTemplates_diagnostics_v1";
let cleanup: (() => void) | null = null;
let watches: (() => void)[] = [];
let generation = 0;
let starting: Promise<void> | null = null;
let persistence: ReturnType<typeof createDiagnosticPersistence> | null = null;
export const DIAGNOSTIC_CAMPAIGN = "mvp-file-2026-10";
export const DIAGNOSTIC_CAMPAIGN_MS = 4 * 24 * 60 * 60 * 1000;
export function diagnosticStorageStatus(): DiagnosticFileStatus {
    return persistence?.status ?? { path: "", initializing: false, fileError: false, localError: false, lastSavedAt: 0 };
}
export function diagnosticSnapshot() {
    const p = panel.get(), u = ui.get(), d = store.data;
    return {
        connection: diagnosticData({ phase: p.phase, sync: p.sync, persistent: p.persistent, ready: p.phase === "ready" }),
        ui: diagnosticData({ windowOpen: u.windowOpen, management: u.management, composeCount: u.compose.length,
            dialog: u.dialog?.kind ?? "idle", items: u.inline?.items.length ?? 0 }),
        settings: diagnosticData({ previewOpen: d.previewOpen, favoriteCount: d.favorites.length, recentCount: d.recent.length,
            bindCount: Object.keys(d.binds).length, templates: store.templates.length, mode: d.techProject }),
        environment: diagnosticData({ online: navigator.onLine, visible: document.visibilityState === "visible", width: window.innerWidth, height: window.innerHeight }),
        debug: debugFileSnapshot(),
    };
}
function watch() {
    for (const off of watches.splice(0)) off();
    if (!journal.active) return;
    let previous = "";
    const changed = () => {
        if (!journal.active) return;
        const s = diagnosticSnapshot();
        // Only meaningful state changes, never every keypress/render or raw snapshot payload.
        const next = JSON.stringify([s.connection, s.ui, s.settings]);
        if (next === previous) return;
        previous = next;
        journal.record("panel.state", s.connection, s.connection.phase === "error");
        journal.record("ui.state", s.ui);
        journal.record("settings.state", s.settings);
    };
    watches = [panel.subscribe(changed), ui.subscribe(changed), store.subscribe(changed)];
    changed();
}
export function startDiagnostics(): Promise<void> {
    if (cleanup) return starting ?? Promise.resolve();
    const task = initializeDiagnostics();
    starting = task;
    void task.then(() => { if (starting === task) starting = null; }, () => { if (starting === task) starting = null; });
    return task;
}
async function initializeDiagnostics() {
    const gen = ++generation;
    const disk = createDiagnosticPersistence({
        localRead: () => window.localStorage.getItem(KEY),
        localWrite: value => window.localStorage.setItem(KEY, value),
        load: loadDiagnosticStorage, save: saveDiagnosticStorage,
        report: state => report(JSON.parse(state)),
    });
    persistence = disk;
    // Install cancellation before the native read. A stop/reload cannot resurrect
    // listeners or recording when an old IPC response eventually arrives.
    cleanup = () => { disk.finish(); };
    const saved = await disk.read();
    if (gen !== generation) return;
    journal.start({ read: () => saved, write: state => disk.write(state) },
        { campaign: DIAGNOSTIC_CAMPAIGN, durationMs: DIAGNOSTIC_CAMPAIGN_MS });
    const pagehide = () => { journal.record("environment.pagehide", {}, true); journal.flush(); disk.finish(); };
    const environment = () => journal.record("environment.state", { online: navigator.onLine, visible: document.visibilityState === "visible" }, true);
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("online", environment); window.addEventListener("offline", environment);
    document.addEventListener("visibilitychange", environment);
    cleanup = () => {
        window.removeEventListener("pagehide", pagehide);
        window.removeEventListener("online", environment); window.removeEventListener("offline", environment);
        document.removeEventListener("visibilitychange", environment);
        for (const off of watches.splice(0)) off();
        journal.stop();
        disk.finish();
    };
    watch();
}
export function stopDiagnostics() { generation++; starting = null; const off = cleanup; cleanup = null; off?.(); }
export function setRecording(on: boolean) { journal.enable(on); watch(); }
function report(state: ReturnType<typeof journal.snapshot>) {
    return JSON.stringify({ product: "SupportTemplates", distribution: PLUGIN_DISTRIBUTION, version: PLUGIN_VERSION, build: PLUGIN_BUILD,
        exportedAt: new Date().toISOString(), recording: journal.active, storageFailed: journal.storageFailed,
        coverage: "Plugin actions and panel requests only. No message/template text, inputs, credentials, request/response bodies or headers. Latest 2000 events within a four-day test window; abrupt crashes may lose the last 6 seconds. Missing runtime.stop before a new runtime.start can indicate an interrupted runtime, not proof of a crash.",
        snapshot: diagnosticSnapshot(), journal: state }, null, 2);
}
export function diagnosticFile() { journal.flush(); return report(journal.snapshot()); }
export function retryDiagnosticFile() { journal.flush(); persistence?.retry(); }
export function downloadDiagnostics() {
    const url = URL.createObjectURL(new Blob([diagnosticFile()], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = `SupportTemplates-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.append(a);
    try { a.click(); } finally { a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
