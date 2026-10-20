// SPDX-License-Identifier: GPL-3.0-or-later
import { PLUGIN_BUILD, PLUGIN_DISTRIBUTION, PLUGIN_VERSION } from "../buildInfo";
import { diagnosticJournal as journal, diagnosticData } from "../core/diagnosticJournal";
import { debugFileSnapshot } from "./debug";
import { panel } from "./panel";
import { store, ui } from "./uiState";

const KEY = "SupportTemplates_diagnostics_v1";
let cleanup: (() => void) | null = null;
let watches: (() => void)[] = [];
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
export function startDiagnostics() {
    if (cleanup) return;
    journal.start({ read: () => window.localStorage.getItem(KEY), write: value => window.localStorage.setItem(KEY, value) });
    const pagehide = () => { journal.record("environment.pagehide", {}, true); journal.flush(); };
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
    };
    watch();
}
export function stopDiagnostics() { const off = cleanup; cleanup = null; off?.(); }
export function setRecording(on: boolean) { journal.enable(on); watch(); }
export function diagnosticFile() {
    journal.flush();
    return JSON.stringify({ product: "SupportTemplates", distribution: PLUGIN_DISTRIBUTION, version: PLUGIN_VERSION, build: PLUGIN_BUILD,
        exportedAt: new Date().toISOString(), recording: journal.active, storageFailed: journal.storageFailed,
        coverage: "Plugin actions and panel requests only. No message/template text, inputs, credentials, request/response bodies or headers. Latest bounded 24-hour history; abrupt crashes may lose the last 5 seconds. Missing runtime.stop before a new runtime.start can indicate an interrupted runtime, not proof of a crash.",
        snapshot: diagnosticSnapshot(), journal: journal.snapshot() }, null, 2);
}
export function downloadDiagnostics() {
    const url = URL.createObjectURL(new Blob([diagnosticFile()], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = `SupportTemplates-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.append(a);
    try { a.click(); } finally { a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
