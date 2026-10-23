import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeFS, ERROR, sourceModule, storageModule as api } from "./a22DiagnosticStorageHarness";

const roots: string[] = [];
function temporary() {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "stx-a26-folder-"))); roots.push(root); return root;
}
afterEach(() => {
    for (const root of roots.splice(0)) {
        if (dirname(resolve(root)) !== fs.realpathSync(tmpdir()) || !root.includes("stx-a26-folder-")) throw Error("Unsafe cleanup");
        fs.rmSync(root, { recursive: true, force: true });
    }
});
describe("A26 shell directory identity", () => {
    it.each(["native", "bd-native"])("uses exact inode proof for MSIX aliases through %s", adapter => {
        const base = temporary(), logical = join(base, "logical"), physical = join(base, "physical");
        const ino = 2n ** 55n;
        let physicalIno = ino;
        const statSync = vi.fn((target: string, options?: { bigint: true }) => {
            const id = target === logical ? ino : physicalIno;
            return { mode: options?.bigint ? 0o40700n : 0o40700, isDirectory: () => true,
                dev: options?.bigint ? 1n : 1, ino: options?.bigint ? id : Number(id) };
        });
        const host = { statSync, realpathSync: Object.assign((target: string) => target, { native: () => physical }) };
        const { diagnosticFileSystem } = sourceModule("betterdiscord/native/diagnosticStorage.ts", {});
        const filesystem = adapter === "native" ? host : diagnosticFileSystem(host);
        expect(api.diagnosticShellDirectory(filesystem, logical)).toBe(physical);
        expect(statSync).toHaveBeenCalledWith(logical, { bigint: true });
        expect(statSync).toHaveBeenCalledWith(physical, { bigint: true });
        physicalIno = ino + 1n;
        expect(Number(physicalIno)).toBe(Number(ino)); // The old production comparison accepted this.
        expect(() => api.diagnosticShellDirectory(filesystem, logical)).toThrow(ERROR);
    });

    it.each(["ignored", "rejected", "missing"] as const)("requires canonical path equality when precise stat is %s", capability => {
        const base = temporary(), logical = join(base, "logical"), physical = join(base, "physical");
        let destination = logical;
        const host = {
            statSync: (_target: string, options?: { bigint: true }) => {
                if (options && capability === "rejected") throw Error("Unsupported option");
                return { isDirectory: () => true, ...(capability === "missing" ? {} : { dev: 1, ino: Number(2n ** 55n) }) };
            },
            realpathSync: Object.assign((target: string) => target, { native: () => destination })
        };
        expect(api.diagnosticShellDirectory(host, logical)).toBe(logical);
        destination = physical;
        expect(() => api.diagnosticShellDirectory(host, logical)).toThrow(ERROR);
        // A JS bridge that resolves both aliases identically needs no bigint support.
        host.realpathSync = Object.assign(() => physical, { native: () => physical });
        expect(api.diagnosticShellDirectory(host, logical)).toBe(physical);
    });

    it("uses the native backing path when JS realpath retains a virtual AppData alias", () => {
        const root = temporary(), logical = join(root, "logical"), backing = join(root, "package-cache");
        const stat = { isDirectory: () => true, dev: 1, ino: 42 };
        const realpath = Object.assign(vi.fn(() => logical), { native: vi.fn(() => backing) });
        const host = { statSync: vi.fn(() => stat), realpathSync: realpath };
        expect(api.diagnosticShellDirectory(host, logical)).toBe(backing);
        expect(realpath).not.toHaveBeenCalled();
        expect(realpath.native).toHaveBeenCalledExactlyOnceWith(logical);
        expect(host.statSync.mock.calls).toEqual([[logical], [backing]]);
    });
    it("preserves spaces and Unicode, and supports the real standard BD filesystem surface", async () => {
        const root = join(temporary(), "Логи пользователя", "a".repeat(64));
        const host = bridgeFS(), store = api.createDiagnosticFileStorage({ root, fs: host });
        const directory = await store.directory();
        expect(fs.readdirSync(directory)).toEqual([]);
        expect(api.diagnosticShellDirectory(host, directory)).toBe(fs.realpathSync(root));
        expect(api.diagnosticShellDirectory(fs, directory)).toBe(fs.realpathSync.native(root));
    });
    it.each(["file", "identity", "relative", "control", "native-error"])("rejects %s resolution instead of opening a different destination", failure => {
        const root = temporary();
        const before = { isDirectory: () => true, dev: 1, ino: 42 };
        const after = { ...before, isDirectory: () => failure !== "file", ino: failure === "identity" ? 43 : 42 };
        const host = { statSync: vi.fn().mockReturnValueOnce(before).mockReturnValue(after),
            realpathSync: Object.assign(() => root, { native: () => {
                if (failure === "native-error") throw Error(ERROR);
                return failure === "relative" ? "relative" : failure === "control" ? root + "\n" : root;
            } }) };
        expect(() => api.diagnosticShellDirectory(host, root)).toThrow(ERROR);
    });
});
describe("A26 fixed host folder endpoints", () => {
    it("Vencord opens the native-resolved owned directory and never accepts the renderer's destination", async () => {
        const base = temporary(), profile = join(base, "profile"); fs.mkdirSync(profile);
        const openPath = vi.fn(async (_path: string) => "");
        const resolved = vi.fn(api.diagnosticShellDirectory);
        const native = sourceModule("src/vencord/native.ts", {
            "node:crypto": { randomUUID }, "node:fs": fs, "node:fs/promises": {},
            "@main/utils/constants": { DATA_DIR: join(base, "data") },
            electron: { app: { isReady: () => true, getPath: () => profile }, shell: { openPath } },
            "./panelVaultLock": {}, "./panelVaultNative": {},
            "./diagnosticFileNative": { ...api, diagnosticShellDirectory: resolved },
        }, { process: { platform: process.platform, once() {} } });
        const frame = { url: "https://canary.discord.com/channels/@me", parent: null, detached: false };
        const event = { senderFrame: frame, sender: { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false } };
        const arbitrary = join(base, "untrusted");
        await native.diagnosticsOpenFolder(event, arbitrary);
        expect(resolved).toHaveBeenCalledOnce();
        const logical = resolved.mock.calls[0][1] as string;
        expect(openPath).toHaveBeenCalledExactlyOnceWith(fs.realpathSync.native(logical));
        expect(fs.readdirSync(logical)).toEqual([]);
        expect(fs.existsSync(arbitrary)).toBe(false);
        openPath.mockResolvedValue("private error");
        await expect(native.diagnosticsOpenFolder(event)).rejects.toThrow(ERROR);
        resolved.mockImplementation(() => { frame.url = "https://evil.test"; return logical; });
        await expect(native.diagnosticsOpenFolder(event)).rejects.toThrow(ERROR);
        expect(openPath).toHaveBeenCalledTimes(2);
    });
    it.each([false, true])("BD preserves the profile guard and resolves the shell path, native=%s", async nativeFS => {
        const root = temporary(), host = nativeFS ? fs : bridgeFS();
        const openPath = vi.fn(async (_path: string) => "");
        const resolved = vi.fn(api.diagnosticShellDirectory);
        let origin = "https://canary.discord.com";
        const bridge = sourceModule("betterdiscord/native/diagnosticStorage.ts", {
            fs: host, path: { join }, electron: { shell: { openPath } },
            "./paths": { installationPaths: () => ({ root, origin }) },
            "../../src/vencord/diagnosticFileNative": { ...api, diagnosticShellDirectory: resolved },
        });
        await bridge.openDiagnosticStorageFolder("ignored");
        const logical = join(root, "diagnostics");
        expect(openPath).toHaveBeenCalledExactlyOnceWith(nativeFS ? fs.realpathSync.native(logical) : fs.realpathSync(logical));
        expect(fs.readdirSync(logical)).toEqual([]);
        resolved.mockImplementation(() => { origin = "https://evil.test"; return logical; });
        await expect(bridge.openDiagnosticStorageFolder()).rejects.toThrow(ERROR);
        expect(openPath).toHaveBeenCalledOnce();
    });
});
