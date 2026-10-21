// SPDX-License-Identifier: GPL-3.0-or-later
import { PLUGIN_BUILD, PLUGIN_DISTRIBUTION, PLUGIN_VERSION } from "../buildInfo";
import { diagnosticJournal as journal, diagnosticData } from "../core/diagnosticJournal";
import { createDiagnosticPersistence, DiagnosticFileStatus } from "../core/diagnosticPersistence";
import { loadDiagnosticStorage, saveDiagnosticStorage, openDiagnosticStorageFolder } from "../diagnosticStorage";
import { debugFileSnapshot } from "./debug";
import { panel } from "./panel";
import { store, ui } from "./uiState";
import { diagnosticBackup } from "./diagnosticBackup";

let cleanup: (() => void) | null = null;
let watches: (() => void)[] = [];
let generation = 0;
let starting: Promise<void> | null = null;
let persistence: ReturnType<typeof createDiagnosticPersistence> | null = null;
export const DIAGNOSTIC_CAMPAIGN = "mvp-file-2026-10";
export function diagnosticStorageStatus(): DiagnosticFileStatus {
    return persistence?.status ?? { path: "", initializing: false, fileError: false, localError: false, lastSavedAt: 0, deliveryLost: 0 };
}
export function diagnosticSnapshot() {
    const p = panel.get(), u = ui.get(), d = store.data;
    return {
        connection: diagnosticData({ phase: p.phase, sync: p.sync, persistent: p.persistent, ready: p.phase === "ready",
            stale: p.stale === true, staleUntil: p.staleUntil ?? 0 }),
        ui: diagnosticData({ windowOpen: u.windowOpen, management: u.management,
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
    const previous: Record<string, string> = {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capture = () => {
        timer = undefined;
        if (!journal.active) return;
        const s = diagnosticSnapshot();
        for (const [key, data] of [["panel", s.connection], ["ui", s.ui], ["settings", s.settings]] as const) {
            const next = JSON.stringify(data);
            if (next === previous[key]) continue;
            previous[key] = next;
            journal.record(`${key}.state`, data);
        }
    };
    // Event-driven trailing coalescing, no polling clock while the window is closed.
    const changed = () => { if (journal.active) timer ??= setTimeout(capture, 250); };
    watches = [panel.subscribe(changed), ui.subscribe(changed), store.subscribe(changed), () => clearTimeout(timer)];
    capture();
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
        backup: diagnosticBackup,
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
        { campaign: DIAGNOSTIC_CAMPAIGN, continuous: true });
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
        coverage: "Ongoing local plugin log; no upload. No message/template text, keystrokes, credentials, request/response bodies or headers. JSON contains the latest 2000 events; the native timestamped TXT appends across restarts with bounded rotation. Abrupt shutdown can lose pending writes; deliveryLost reports queue overflow. Missing runtime.stop before a new runtime.start indicates an interrupted runtime, not proof of a crash.",
        snapshot: diagnosticSnapshot(), journal: state }, null, 2);
}
export function diagnosticFile() { journal.flush(); return report(journal.snapshot()); }
export function retryDiagnosticFile() { journal.flush(); persistence?.retry(); }
export async function openDiagnosticFolder(): Promise<void> {
    journal.flush();
    persistence?.retry();
    await openDiagnosticStorageFolder();
}
