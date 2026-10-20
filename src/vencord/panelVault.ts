/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface PanelVault {
    load(): Promise<unknown | null>;
    save(record: unknown): Promise<void>;
    clear(): Promise<void>;
}

interface Bridge {
    panelVaultAvailable(): Promise<boolean>;
    panelVaultLoad(accountId: string): Promise<unknown | null>;
    panelVaultSave(accountId: string, record: unknown): Promise<void>;
    panelVaultClear(accountId: string): Promise<void>;
}

// PanelClient keys its transaction/ownership queue by this object identity. Keep
// save + post-save cleanup in that same queue across successive client instances.
const vaults = new WeakMap<Bridge, Map<string, PanelVault>>();
const queues = new Map<string, Promise<unknown>>();
const failed = () => new Error("Protected panel storage operation failed.");

function bridge(): Bridge | undefined {
    const native = (globalThis as { VencordNative?: { pluginHelpers?: { SupportTemplates?: Partial<Bridge>; }; }; })
        .VencordNative?.pluginHelpers?.SupportTemplates;
    return native && [native.panelVaultAvailable, native.panelVaultLoad, native.panelVaultSave, native.panelVaultClear]
        .every(method => typeof method === "function") ? native as Bridge : undefined;
}

/** Probe every call, but reuse the same logical vault for an unchanged bridge/account.
 * Session ownership belongs to PanelClient, including cleanup after an aborted write.
 * Undefined explicitly means memory-only.
 */
export async function createPanelVault(accountId: string): Promise<PanelVault | undefined> {
    if (typeof accountId !== "string" || !/^[1-9]\d{16,19}$/.test(accountId)
        || BigInt(accountId) > 18446744073709551615n) return undefined;
    const native = bridge();
    if (!native) return undefined;
    try { if (await native.panelVaultAvailable() !== true) return undefined; }
    catch { return undefined; }
    if (bridge() !== native) return undefined;
    let accounts = vaults.get(native);
    if (!accounts) { accounts = new Map(); vaults.set(native, accounts); }
    const existing = accounts.get(accountId);
    if (existing) return existing;
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const next = (queues.get(accountId) ?? Promise.resolve()).then(operation).catch(() => { throw failed(); });
        const settled = next.catch(() => {});
        queues.set(accountId, settled);
        void settled.then(() => { if (queues.get(accountId) === settled) queues.delete(accountId); });
        return next;
    };
    const vault: PanelVault = {
        load: () => enqueue(() => native.panelVaultLoad(accountId)),
        save: record => {
            // IPC itself clones only when dispatched; snapshot now before an earlier operation awaits.
            let snapshot: unknown;
            try { snapshot = structuredClone(record); }
            catch { return Promise.reject(failed()); }
            return enqueue(() => native.panelVaultSave(accountId, snapshot));
        },
        clear: () => enqueue(() => native.panelVaultClear(accountId)),
    };
    accounts.set(accountId, vault);
    return vault;
}
