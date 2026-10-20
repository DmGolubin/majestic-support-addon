import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeFS, report, sourceModule, storageModule as api } from "./a22DiagnosticStorageHarness";

const roots: string[] = [];
function temporary() {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "stx-a28-path-")));
    roots.push(root); return root;
}
afterEach(() => {
    for (const root of roots.splice(0)) {
        if (dirname(resolve(root)) !== fs.realpathSync(tmpdir()) || !root.includes("stx-a28-path-")) throw Error("Unsafe cleanup");
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// Model the A26 MSIX alias: JS realpath keeps the logical name, native realpath
// exposes a backing name, and stat identifies both names as the same directory.
function aliasFS(root: string) {
    const physical = join(dirname(root), "Packages", "LocalCache", "Логи пользователя");
    const native = vi.fn((target: string) => target === root ? physical : fs.realpathSync.native(target));
    const writes = vi.fn(fs.writeFileSync);
    const host = { ...fs, writeFileSync: writes,
        realpathSync: Object.assign((target: string) => fs.realpathSync(target), { native }),
        statSync: (target: string, options?: { bigint: true; }) => options
            ? fs.statSync(target === physical ? root : target, options) : fs.statSync(target === physical ? root : target) };
    return { host, physical, native, writes };
}

describe("A28 diagnostic display path", () => {
    it.each(["vencord", "bd", "bd-bridge"] as const)("%s returns the resolved main.log name without changing storage paths", async kind => {
        const base = temporary(), profile = join(base, "profile"); fs.mkdirSync(profile);
        const data = join(base, "data");
        const root = kind === "vencord" ? api.diagnosticProfileRoot(data, profile, process.platform) : join(base, "diagnostics");
        const alias = aliasFS(root), host = kind === "bd-bridge" ? bridgeFS() : alias.host;
        let load: () => Promise<any>, save: (value: string) => Promise<any>;
        if (kind === "vencord") {
            const native = sourceModule("src/vencord/native.ts", {
                "node:crypto": { randomUUID }, "node:fs": host, "node:fs/promises": {},
                "@main/utils/constants": { DATA_DIR: data },
                electron: { app: { isReady: () => true, getPath: () => profile } },
                "./panelVaultLock": {}, "./panelVaultNative": {}, "./diagnosticFileNative": api,
            }, { process: { platform: process.platform, once() {} } });
            const frame = { url: "https://canary.discord.com/channels/@me", parent: null, detached: false };
            const event = { senderFrame: frame, sender: { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false } };
            load = () => native.diagnosticsLoad(event);
            save = value => native.diagnosticsSave(event, value);
        } else {
            const bd = sourceModule("betterdiscord/native/diagnosticStorage.ts", {
                fs: host, path: { join },
                "./paths": { installationPaths: () => ({ root: base, origin: "https://canary.discord.com" }) },
                "../../src/vencord/diagnosticFileNative": api,
            });
            load = () => bd.loadDiagnosticStorage();
            save = value => bd.saveDiagnosticStorage(value);
        }
        const logicalLog = join(root, api.DIAGNOSTIC_FILE_NAME);
        expect(await load()).toEqual({ path: logicalLog, state: null });
        expect(fs.existsSync(root)).toBe(false); // A first read stays passive.
        const display = join(kind === "bd-bridge" ? root : alias.physical, api.DIAGNOSTIC_FILE_NAME);
        expect(await save(report())).toEqual({ path: display });
        const loaded = await load();
        expect(loaded.path).toBe(display);
        expect(JSON.parse(loaded.state).events).toHaveLength(1);
        expect(await save(report())).toEqual({ path: display }); // control-only/deduplicated save
        expect(fs.readFileSync(logicalLog, "utf8")).toContain("request.start");
        if (kind !== "bd-bridge") {
            expect(alias.native).toHaveBeenCalledWith(root);
            expect(alias.writes.mock.calls.length).toBeGreaterThan(0);
            expect(alias.writes.mock.calls.every(([target]) => String(target).startsWith(root))).toBe(true);
            expect(fs.existsSync(alias.physical)).toBe(false); // No relocation or second log tree.
        }
    });

    it.each(["native-error", "different-directory"] as const)("display resolution %s cannot lose loaded state or fail a committed save", async failure => {
        const root = join(temporary(), "diagnostics"), alias = aliasFS(root);
        if (failure === "native-error") alias.native.mockImplementation(() => { throw Error("private host error"); });
        else alias.host.statSync = target => {
            const info = fs.statSync(target === alias.physical ? root : target);
            // NTFS inode values can exceed Number.MAX_SAFE_INTEGER, where ino + 1
            // may equal ino. Model distinct identities without filesystem arithmetic.
            if (target === root || target === alias.physical) return new Proxy(info, {
                get: (value, key) => key === "ino" ? target === root ? 41 : 42 : Reflect.get(value, key)
            });
            return info;
        };
        const store = api.createDiagnosticFileStorage({ root, fs: alias.host }), path = join(root, api.DIAGNOSTIC_FILE_NAME);
        expect(await store.save(report())).toEqual({ path });
        const loaded = await store.load();
        expect(loaded.path).toBe(path);
        expect(JSON.parse(loaded.state).events).toHaveLength(1);
        expect(JSON.parse(loaded.state).optedOut).not.toBe(true);
    });
});
