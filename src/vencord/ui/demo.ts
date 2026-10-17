/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Store } from "../core/state";
import { toast } from "../platform";
import { confirmedForeign, supersede } from "./flow";
import { createObservable } from "./observable";
import { clearTargets, nextGeneration } from "./op";
import { demoAccess, realStore, selectStore, ui } from "./uiState";

const BASE = "http://127.0.0.1:47833";
export const demo = createObservable({ enabled: false, localMode: false, phase: "idle", url: "", code: "", revision: 0, error: "", paused: false });
let library: Store | null = null;
let credentials: { id: string; device: string; } | null = null;
let epoch = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let request: AbortController | null = null;

function invalidate(keepWindow = false) {
    nextGeneration(); supersede(); if (!keepWindow) clearTargets(); confirmedForeign.clear();
    ui.set({ windowOpen: keepWindow && ui.get().windowOpen, inline: null, menu: null, dialog: null, compose: [] });
}
function stopRequest() { epoch++; clearTimeout(timer); request?.abort(); request = null; }

/** Drop session-owned records, retaining only account-independent UI preferences. */
function clearLibrary() {
    if (!library) return;
    const { prefix, previewOpen, techProject } = library.data;
    const empty = new Store({ get: async () => undefined, set: async () => {} });
    library.data = { ...empty.data, prefix, previewOpen, techProject };
    library.replaceDemoCatalog("");
}

function resetSession(keepWindow = false) {
    stopRequest(); invalidate(keepWindow); credentials = null;
    demoAccess.set({ ready: false });
    // revision=0 also unmounts personal editors in Vencord's separate settings surface.
    demo.set({ revision: 0, url: "", code: "", error: "", paused: false });
    ui.set({ management: false });
    clearLibrary();
}
async function api(path: string, body?: object) {
    const controller = new AbortController(); request = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        const r = await fetch(BASE + path, { method: body ? "POST" : "GET", credentials: "omit", signal: controller.signal,
            headers: { "Content-Type": "application/json", ...(credentials ? { Authorization: "Bearer " + credentials.device } : {}) },
            body: body ? JSON.stringify(body) : undefined });
        if (!r.ok) throw new Error("Локальный сервер вернул " + r.status);
        return await r.json();
    } finally { clearTimeout(timeout); if (request === controller) request = null; }
}

export function enableDemo(keepWindow = false) {
    resetSession(keepWindow);
    library = new Store({ get: async () => undefined, set: async () => {} });
    library.setPreviewOpen(false);
    demoAccess.set({ enabled: true, ready: false }); selectStore(library);
    demo.set({ enabled: true, localMode: false, phase: "idle", url: "", code: "", revision: 0, error: "", paused: false });
}
/** Plugin teardown releases a session without opting the user into local mode. */
export function disposeDemo() {
    resetSession();
    demo.set({ phase: "idle" });
}
export function disableDemo() {
    disposeDemo(); library = null;
    demoAccess.set({ enabled: false, ready: false }); selectStore(realStore);
    demo.set({ enabled: false, localMode: true, phase: "idle", url: "", code: "", revision: 0, error: "", paused: false });
}
export async function connectDemo(fromMenu = false) {
    if (!demo.get().enabled) return;
    resetSession(fromMenu);
    const ownEpoch = epoch;
    demo.set({ phase: "connecting", error: "", url: "", code: "", revision: 0, paused: false });
    try {
        const result = await api("/requests", {});
        if (epoch !== ownEpoch) return;
        if (typeof result.id !== "string" || typeof result.device !== "string" || typeof result.code !== "string" || typeof result.url !== "string" || !result.url.startsWith(BASE + "/#")) throw new Error("Неверный ответ демосервера");
        credentials = { id: result.id, device: result.device };
        demo.set({ phase: "pending", url: result.url, code: result.code });
        if (fromMenu) window.open(result.url, "_blank", "noopener,noreferrer");
        void poll(ownEpoch);
    } catch {
        if (epoch === ownEpoch) demo.set({ phase: "idle", error: "Нет связи с панелью. Попробуйте снова." });
    }
}
async function poll(ownEpoch: number) {
    if (epoch !== ownEpoch || !credentials || demo.get().paused) return;
    try {
        let result = await api(`/sessions/${encodeURIComponent(credentials.id)}/state`);
        if (epoch !== ownEpoch) return;
        if (!["pending", "ready", "denied", "expired", "revoked"].includes(result.phase) || !Number.isSafeInteger(result.revision) || typeof result.raw !== "string" || result.raw.length > 50000) throw new Error("Неверный снимок");
        if (result.phase === "ready" && demo.get().revision === 0) {
            demo.set({ phase: "loading", error: "" });
            // A separate catalog read after consent; the demo holds this scene briefly so it is legible.
            const [snapshot] = await Promise.all([
                api(`/sessions/${encodeURIComponent(credentials!.id)}/state`),
                new Promise<void>(resolve => setTimeout(resolve, 700)),
            ]);
            if (epoch !== ownEpoch) return;
            if (!["ready", "revoked", "expired"].includes(snapshot.phase) || !Number.isSafeInteger(snapshot.revision) || typeof snapshot.raw !== "string" || snapshot.raw.length > 50000) throw new Error("Неверный снимок");
            result = snapshot;
        }
        if (result.phase === "ready") {
            if (result.revision !== demo.get().revision) {
                const changed = demo.get().revision > 0;
                invalidate(!changed && ui.get().windowOpen); library!.replaceDemoCatalog(result.raw);
                if (changed) toast("Шаблоны обновлены. Выберите шаблон снова.", "success");
            }
            demoAccess.set({ ready: true });
            demo.set({ phase: "ready", revision: result.revision, error: "" });
        } else {
            if (result.phase !== "pending") {
                resetSession();
                demo.set({ phase: result.phase });
                return;
            }
            if (demoAccess.get().ready) invalidate();
            demoAccess.set({ ready: false }); demo.set({ phase: result.phase, error: "" });
        }
    } catch {
        if (epoch !== ownEpoch) return;
        if (demoAccess.get().ready) invalidate();
        demoAccess.set({ ready: false }); demo.set({ phase: demo.get().phase === "loading" || demo.get().phase === "load-error" ? "load-error" : "offline", error: "Нет связи с панелью. Переподключаемся…" });
    }
    if (epoch === ownEpoch) timer = setTimeout(() => void poll(ownEpoch), 2000);
}
export function pauseDemo() {
    stopRequest(); invalidate();
    const paused = !demo.get().paused;
    demoAccess.set({ ready: false }); demo.set({ paused, phase: paused ? "offline" : "connecting", error: "" });
    if (!paused && credentials) void poll(epoch);
}

/** Cancel this attempt, not merely hide its window. Late replies cannot complete the next login. */
export function cancelDemoLogin() {
    const previous = credentials;
    resetSession(true);
    demo.set({ phase: "idle", url: "", code: "", error: "", paused: false });
    if (previous) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        void fetch(`${BASE}/sessions/${encodeURIComponent(previous.id)}/revoke`, {
            method: "POST", credentials: "omit", signal: controller.signal,
            headers: { Authorization: "Bearer " + previous.device, "Content-Type": "application/json" }, body: "{}",
        }).catch(() => {}).finally(() => clearTimeout(timeout));
    }
}
