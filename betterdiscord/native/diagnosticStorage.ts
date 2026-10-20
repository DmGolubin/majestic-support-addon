// SPDX-License-Identifier: GPL-3.0-or-later
// No host modules are evaluated until a storage operation is actually requested.
let storage: Promise<ReturnType<typeof import("../../src/vencord/diagnosticFileNative").createDiagnosticFileStorage>> | undefined;
const failed = () => new Error("Diagnostic storage operation failed.");
async function current() {
    storage ??= (async () => {
        // BD provides require polyfills, not Node's external ESM import loader.
        const fs = require("fs") as typeof import("fs");
        const { join } = require("path") as typeof import("path");
        const { installationPaths } = await import("./paths");
        const { createDiagnosticFileStorage } = await import("../../src/vencord/diagnosticFileNative");
        return createDiagnosticFileStorage({ fs, root: join(installationPaths().root, "diagnostics") });
    })().catch(() => { storage = undefined; throw failed(); });
    return storage;
}
export async function loadDiagnosticStorage(): Promise<{ path: string; state: string | null; }> {
    try { return await (await current()).load(); } catch { throw failed(); }
}
export async function saveDiagnosticStorage(report: string): Promise<{ path: string; }> {
    try { return await (await current()).save(report); } catch { throw failed(); }
}
