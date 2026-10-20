/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import * as lockFS from "node:fs";
import * as fs from "node:fs/promises";

import { DATA_DIR } from "@main/utils/constants";
import { app, IpcMainInvokeEvent, safeStorage } from "electron";

import { createVaultProcessLock, panelVaultRoot, verifiedDeadPID } from "./panelVaultLock";
import { createNativePanelVault } from "./panelVaultNative";

interface Entry {
    vault: ReturnType<typeof createNativePanelVault>;
    lock: ReturnType<typeof createVaultProcessLock>;
    active: number;
    owner?: IpcMainInvokeEvent["sender"];
}
const entries = new Map<string, Entry>();
process.once("exit", () => {
    for (const entry of entries.values()) {
        // Pending OS file operations must finish/process-exit before a successor acquires.
        if (!entry.active) entry.lock.release();
    }
});

// Custom Vesktop origins are memory-only until explicitly reviewed. This does not
// isolate other plugins executing inside the same trusted Discord renderer.
function trusted(event: IpcMainInvokeEvent): boolean {
    try {
        if (event.sender.isDestroyed()) return false;
        const frame = event.senderFrame;
        if (!frame || frame.detached === true || frame !== event.sender.mainFrame || frame.parent !== null) return false;
        const url = new URL(frame.url);
        return !url.username && !url.password
            && ["https://discord.com", "https://ptb.discord.com", "https://canary.discord.com"].includes(url.origin)
            && new URL(event.sender.getURL()).origin === url.origin;
    } catch { return false; }
}

const denied = () => new Error("Protected panel storage operation failed.");

function entryFor(event: IpcMainInvokeEvent, requireCrypto: boolean): Entry | undefined {
    try {
        if (!trusted(event) || !app.isReady()) return undefined;
        const userData = lockFS.realpathSync(app.getPath("userData"));
        const root = panelVaultRoot(DATA_DIR, userData, new URL(event.senderFrame!.url).origin, process.platform);
        let entry = entries.get(root);
        if (!entry) {
            entry = {
                vault: createNativePanelVault({ root, platform: process.platform, randomId: randomUUID, fs, crypto: safeStorage }),
                lock: createVaultProcessLock({ root, pid: process.pid, nonce: randomUUID(), fs: lockFS,
                    isDead: pid => verifiedDeadPID(pid, (pid, signal) => process.kill(pid, signal)) }),
                active: 0,
            };
            entries.set(root, entry);
        }
        // Separate renderers have independent auth queues. Only one live WebContents
        // may use this persisted pair; a reload keeps the same WebContents object.
        if (entry.owner && entry.owner !== event.sender
            && (entry.active > 0 || !entry.owner.isDestroyed())) return undefined;
        if ((requireCrypto && !entry.vault.available()) || !entry.lock.acquire()) return undefined;
        entry.owner = event.sender;
        return entry;
    } catch { return undefined; }
}

export function panelVaultAvailable(event: IpcMainInvokeEvent): boolean {
    return !!entryFor(event, true);
}

export async function panelVaultLoad(event: IpcMainInvokeEvent, accountId: unknown): Promise<unknown | null> {
    const entry = entryFor(event, true);
    if (!entry) throw denied();
    const frame = event.senderFrame;
    const { url } = (frame!);
    entry.active++;
    try {
        const record = await entry.vault.load(accountId);
        // A navigation/destruction during disk I/O must never receive the decrypted record.
        if (!trusted(event) || event.senderFrame !== frame || frame!.url !== url) throw denied();
        return record;
    } finally { entry.active--; }
}

export async function panelVaultSave(event: IpcMainInvokeEvent, accountId: unknown, record: unknown): Promise<void> {
    const entry = entryFor(event, true);
    if (!entry) throw denied();
    entry.active++;
    try { await entry.vault.save(accountId, record); }
    finally { entry.active--; }
}

export async function panelVaultClear(event: IpcMainInvokeEvent, accountId: unknown): Promise<void> {
    const entry = entryFor(event, false);
    if (!entry) throw denied();
    entry.active++;
    try { await entry.vault.clear(accountId); }
    finally { entry.active--; }
}

// Independent from auth/vault ownership. Diagnostics contain only allowlisted
// metadata, and remain writable for an explicit final opt-out/clear snapshot.
const diagnosticStores = new Map<string, ReturnType<typeof import("./diagnosticFileNative").createDiagnosticFileStorage>>();
const diagnosticDenied = () => new Error("Diagnostic storage operation failed.");
async function diagnosticStore(event: IpcMainInvokeEvent) {
    if (!trusted(event) || !app.isReady()) throw diagnosticDenied();
    const frame = event.senderFrame!, url = frame.url;
    const { createDiagnosticFileStorage, diagnosticProfileRoot } = await import("./diagnosticFileNative");
    if (!trusted(event) || event.senderFrame !== frame || frame.url !== url) throw diagnosticDenied();
    const userData = lockFS.realpathSync(app.getPath("userData"));
    const root = diagnosticProfileRoot(DATA_DIR, userData, process.platform);
    let store = diagnosticStores.get(root);
    if (!store) {
        store = createDiagnosticFileStorage({ root, fs: lockFS });
        diagnosticStores.set(root, store);
    }
    return { store, frame, url };
}
export async function diagnosticsLoad(event: IpcMainInvokeEvent): Promise<{ path: string; state: string | null; }> {
    try {
        const { store, frame, url } = await diagnosticStore(event);
        const result = await store.load(() => {
            if (!trusted(event) || event.senderFrame !== frame || frame.url !== url) throw diagnosticDenied();
        });
        if (!trusted(event) || event.senderFrame !== frame || frame.url !== url) throw diagnosticDenied();
        return result;
    } catch { throw diagnosticDenied(); }
}
export async function diagnosticsSave(event: IpcMainInvokeEvent, report: string): Promise<{ path: string; }> {
    try {
        const { store, frame, url } = await diagnosticStore(event);
        const result = await store.save(report, () => {
            if (!trusted(event) || event.senderFrame !== frame || frame.url !== url) throw diagnosticDenied();
        });
        if (!trusted(event) || event.senderFrame !== frame || frame.url !== url) throw diagnosticDenied();
        return result;
    } catch { throw diagnosticDenied(); }
}
