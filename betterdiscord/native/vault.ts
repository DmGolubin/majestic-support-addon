// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as promises from "node:fs/promises";
import { join } from "node:path";
import { createNativePanelVault, validVaultAccount } from "../../src/vencord/panelVaultNative";
import { createVaultProcessLock, verifiedDeadPID } from "../../src/vencord/panelVaultLock";
import { installationPaths } from "./paths";
import { createDpapiCrypto } from "./dpapi";

export function createVaultSession(deps: { root: string; crypto: any; platform?: string; pid?: number }) {
    const vault = createNativePanelVault({ root: deps.root, platform: deps.platform ?? process.platform, crypto: deps.crypto, fs: promises, randomId: randomUUID });
    const lock = createVaultProcessLock({ root: deps.root, pid: deps.pid ?? process.pid, nonce: randomUUID(), fs,
        isDead: pid => verifiedDeadPID(pid, (id, signal) => process.kill(id, signal)) });
    let closed = false;
    let tail: Promise<unknown> = Promise.resolve();
    const accounts = new Map<string, any>();
    const enqueue = <T>(operation: () => Promise<T>) => {
        if (closed) return Promise.reject(new Error("Protected panel storage unavailable."));
        const next = tail.then(operation);
        tail = next.catch(() => {});
        return next;
    };
    return {
        forAccount(accountId: string) {
            if (closed || !validVaultAccount(accountId) || !vault.available() || !lock.acquire()) return undefined;
            if (!accounts.has(accountId)) accounts.set(accountId, {
                load: () => enqueue(() => vault.load(accountId)),
                save: (record: unknown) => {
                    let snapshot: unknown;
                    try { snapshot = structuredClone(record); } catch { return Promise.reject(new Error("Protected panel storage unavailable.")); }
                    return enqueue(() => vault.save(accountId, snapshot));
                },
                clear: () => enqueue(() => vault.clear(accountId))
            });
            return accounts.get(accountId);
        },
        async close() { closed = true; await tail; lock.release(); accounts.clear(); }
    };
}

let session: ReturnType<typeof createVaultSession> | undefined;
let retiring: Promise<void> = Promise.resolve();
export async function createPanelVault(accountId: string) {
    await retiring;
    if (!validVaultAccount(accountId)) return undefined;
    try {
        if (!session) {
            // safeStorage is not universally exposed to BD's renderer. Never substitute
            // plaintext, a bundled key or Discord's account token when unavailable.
            let crypto: any;
            try { crypto = require("electron").safeStorage; } catch {}
            if (!crypto) { try { crypto = require("@electron/remote").safeStorage; } catch {} }
            if (!crypto && process.platform === "win32") crypto = createDpapiCrypto();
            if (!crypto?.isEncryptionAvailable?.()) return undefined;
            session = createVaultSession({ root: join(installationPaths().root, "panel-vault"), crypto });
        }
        return session.forAccount(accountId);
    } catch { return undefined; }
}
export function closePanelVault() {
    const previous = session; session = undefined;
    retiring = retiring.then(() => previous?.close()).catch(() => {});
    return retiring;
}
