// SPDX-License-Identifier: GPL-3.0-or-later
import { hasNativeStorage } from "./capabilities";
import { createBrowserVaultSession, validBrowserVaultAccount } from "./browserVault";

let native: typeof import("./vault") | undefined;
let browser: Awaited<ReturnType<typeof createBrowserVaultSession>> | undefined;
// Serialize initialization as well as retirement: a close during an async open must
// retire that session, and a subsequent open must wait for its lock to be released.
let lifecycle: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = lifecycle.then(operation);
    lifecycle = task.then(() => {}, () => {});
    return task;
}
export function createPanelVault(accountId: string) {
    return serialize(async () => {
        if (!validBrowserVaultAccount(accountId)) return undefined;
        if (hasNativeStorage()) {
            native ??= await import("./vault");
            return native.createPanelVault(accountId);
        }
        if (!globalThis.crypto?.subtle || !globalThis.indexedDB?.open || !globalThis.navigator?.locks?.request) return undefined;
        if (!browser) {
            // paths uses only BD's supported fs/path/hash bridge, never fs/promises,
            // ciphers, safeStorage or child_process. Only initialization can fall back:
            // undefined sets persistent:false and the shared UI labels session-only
            // login. A busy owner must never expose its saved refresh token here.
            try {
                const { installationPaths } = await import("./paths");
                browser = await createBrowserVaultSession({ root: installationPaths().root,
                    origin: globalThis.location.origin, platform: process.platform,
                    crypto: globalThis.crypto, indexedDB: globalThis.indexedDB, locks: globalThis.navigator.locks });
            } catch { return undefined; }
        }
        // Do not mask any load/save/clear failures after returning a persistent vault.
        return browser.forAccount(accountId);
    });
}
export function closePanelVault() {
    return serialize(async () => {
        const previous = browser;
        browser = undefined;
        await previous?.close();
        await native?.closePanelVault();
    });
}
