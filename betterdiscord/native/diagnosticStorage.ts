// SPDX-License-Identifier: GPL-3.0-or-later
// No host modules are evaluated until a storage operation is actually requested.
let storage: Promise<ReturnType<typeof import("../../src/vencord/diagnosticFileNative").createDiagnosticFileStorage>> | undefined;
const failed = () => new Error("Diagnostic storage operation failed.");
/** BD returns stat data by value but its type predicates are bridged functions.
 * Evaluate those predicates from that same immutable mode snapshot locally.
 * Never cache filesystem results: every stat/lstat and canonical-path check
 * still runs at its original boundary, including checks after staging writes. */
export function diagnosticFileSystem(fs: import("../../src/vencord/diagnosticFileNative").DiagnosticFileSystem) {
    const localInfo = (info: ReturnType<typeof fs.statSync>) => {
        const mode = (info as { mode?: number | bigint; }).mode;
        // Older/alternative hosts may omit mode. Keep their original predicates.
        if (typeof mode === "bigint" ? mode < 0n || mode > 0xffffffffn
            : typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0xffffffff) return info;
        const kind = typeof mode === "bigint" ? Number(mode & 0xf000n) : mode & 0xf000;
        // Node's S_IFMT, S_IFREG, S_IFDIR and S_IFLNK.
        return { ...info, isFile: () => kind === 0x8000, isDirectory: () => kind === 0x4000,
            isSymbolicLink: () => kind === 0xa000 };
    };
    return { ...fs, statSync: (path: string, options?: { bigint: true; }) => localInfo(options
        ? Reflect.apply(fs.statSync, fs, [path, options]) : fs.statSync(path)),
        ...(fs.lstatSync ? { lstatSync: (path: string) => localInfo(fs.lstatSync!(path)) } : {}) };
}
async function current() {
    storage ??= (async () => {
        // BD provides require polyfills, not Node's external ESM import loader.
        const fs = require("fs") as typeof import("fs");
        const { join } = require("path") as typeof import("path");
        const { installationPaths } = await import("./paths");
        const { createDiagnosticFileStorage } = await import("../../src/vencord/diagnosticFileNative");
        return createDiagnosticFileStorage({ fs: diagnosticFileSystem(fs), root: join(installationPaths().root, "diagnostics"),
            // BD's crypto.randomBytes implementation itself reads deprecated
            // global Buffer. Web Crypto supplies the same 128-bit random nonce.
            randomId: () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),
                byte => byte.toString(16).padStart(2, "0")).join("") });
    })().catch(() => { storage = undefined; throw failed(); });
    return storage;
}
export async function loadDiagnosticStorage(): Promise<{ path: string; state: string | null; }> {
    try { return await (await current()).load(); } catch { throw failed(); }
}
export async function saveDiagnosticStorage(report: string): Promise<{ path: string; }> {
    try { return await (await current()).save(report); } catch { throw failed(); }
}
export async function openDiagnosticStorageFolder(): Promise<void> {
    try {
        const { installationPaths } = await import("./paths");
        const original = installationPaths();
        const directory = await (await current()).directory();
        const latest = installationPaths();
        const { join } = require("path") as typeof import("path");
        if (latest.root !== original.root || latest.origin !== original.origin
            || directory !== join(original.root, "diagnostics")) throw failed();
        const { diagnosticShellDirectory } = await import("../../src/vencord/diagnosticFileNative");
        const physical = diagnosticShellDirectory(diagnosticFileSystem(require("fs")), directory);
        const final = installationPaths();
        if (final.root !== original.root || final.origin !== original.origin) throw failed();
        const { shell } = require("electron") as typeof import("electron");
        if (typeof shell?.openPath !== "function" || await shell.openPath(physical)) throw failed();
    } catch { throw failed(); }
}
