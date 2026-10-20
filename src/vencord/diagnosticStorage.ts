// SPDX-License-Identifier: GPL-3.0-or-later
// Probe lazily: browser fixtures and unsupported hosts must be able to import UI.
interface Bridge {
    diagnosticsLoad(): Promise<{ path: string; state: string | null; }>;
    diagnosticsSave(report: string): Promise<{ path: string; }>;
    diagnosticsOpenFolder?(): Promise<void>;
}
const failed = () => new Error("Diagnostic storage operation failed.");
function bridge(): Bridge {
    const native = (globalThis as { VencordNative?: { pluginHelpers?: { SupportTemplates?: Partial<Bridge>; }; }; })
        .VencordNative?.pluginHelpers?.SupportTemplates;
    if (!native || typeof native.diagnosticsLoad !== "function" || typeof native.diagnosticsSave !== "function") throw failed();
    return native as Bridge;
}
export async function loadDiagnosticStorage(): Promise<{ path: string; state: string | null; }> {
    try { return await bridge().diagnosticsLoad(); } catch { throw failed(); }
}
export async function saveDiagnosticStorage(report: string): Promise<{ path: string; }> {
    try { return await bridge().diagnosticsSave(report); } catch { throw failed(); }
}
export async function openDiagnosticStorageFolder(): Promise<void> {
    try {
        const native = bridge();
        if (typeof native.diagnosticsOpenFolder !== "function") throw failed();
        await native.diagnosticsOpenFolder();
    } catch { throw failed(); }
}
