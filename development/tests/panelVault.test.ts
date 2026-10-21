import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createNativePanelVault, validVaultAccount, VaultDependencies } from "../src/vencord/panelVaultNative";
import type { PanelVault } from "../src/vencord/panelVault";

const A = "123456789012345678";
const B = "223456789012345678";
const message = "Protected panel storage operation failed.";
const defer = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
};
const enoent = () => Object.assign(new Error("fake missing path"), { code: "ENOENT" });

function harness() {
    const root = join("fake-data", "support-templates-vault");
    const files = new Map<string, Buffer>();
    const links = new Set<string>();
    const encrypted = new Map<string, string>();
    const events: string[] = [];
    let directory = false;
    let counter = 0;
    const stat = (file: string) => ({
        size: files.get(file)?.length ?? 0,
        isFile: () => file !== root,
        isDirectory: () => file === root,
        isSymbolicLink: () => links.has(file),
    });
    const fs: VaultDependencies["fs"] = {
        mkdir: vi.fn(async () => { directory = true; }),
        lstat: vi.fn(async file => {
            if (file === root ? !directory : !files.has(file)) throw enoent();
            return stat(file);
        }),
        open: vi.fn(async (file, flags) => {
            if (flags === "wx") {
                if (files.has(file)) throw new Error("fake exclusive failure");
                files.set(file, Buffer.alloc(0));
            } else if (!files.has(file)) throw enoent();
            return {
                stat: async () => stat(file),
                read: async (buffer: Buffer, offset: number, length: number, position: number) => {
                    const source = files.get(file)!;
                    const count = Math.min(length, source.length - position);
                    if (count > 0) source.copy(buffer, offset, position, position + count);
                    return { bytesRead: Math.max(count, 0) };
                },
                writeFile: async (data: Buffer) => { events.push("write"); files.set(file, Buffer.from(data)); },
                sync: async () => { events.push("sync"); },
                close: async () => { events.push("close"); },
            };
        }),
        rename: vi.fn(async (from, to) => {
            events.push("rename"); files.set(to, files.get(from)!); files.delete(from);
        }),
        unlink: vi.fn(async file => {
            events.push("unlink"); if (!files.delete(file)) throw enoent();
        }),
    };
    const crypto: VaultDependencies["crypto"] = {
        isEncryptionAvailable: vi.fn(() => true),
        getSelectedStorageBackend: vi.fn(() => "gnome_libsecret"),
        encryptString: vi.fn(plain => {
            const cipher = `opaque-cipher-${++counter}`;
            encrypted.set(cipher, plain);
            return Buffer.from(cipher);
        }),
        decryptString: vi.fn(cipher => {
            const plain = encrypted.get(cipher.toString());
            if (plain === undefined) throw new Error("fake secret in crypto exception");
            return plain;
        }),
    };
    const deps: VaultDependencies = { root, platform: "win32", fs, crypto, randomId: () => `temp-${++counter}` };
    const vault = createNativePanelVault(deps);
    const path = (account = A) => join(root, `${account}.bin`);
    return { vault, deps, fs, crypto, files, links, encrypted, events, root, path };
}

describe("native encrypted panel vault (fake FS and crypto only)", () => {
    it("round trips only encrypted bytes, atomically flushes and replaces, then clears", async () => {
        const h = harness();
        expect(await h.vault.load(A)).toBeNull();
        const record = { accessToken: "test-access", refreshToken: "test-refresh", nested: [true, null, 1] };
        await h.vault.save(A, record);
        expect(h.files.size).toBe(1);
        expect(h.files.get(h.path())!.toString()).toMatch(/^opaque-cipher-/);
        expect(h.events).toEqual(["write", "sync", "close", "rename"]);
        expect(h.fs.mkdir).toHaveBeenCalledWith(h.root, { recursive: true, mode: 0o700 });
        expect(h.fs.open).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), "wx", 0o600);
        expect(await h.vault.load(A)).toEqual(record);
        await h.vault.save(A, { accessToken: "rotated-test" });
        expect(h.files.size).toBe(1);
        expect(await h.vault.load(A)).toEqual({ accessToken: "rotated-test" });
        await h.vault.clear(A); await h.vault.clear(A);
        expect(await h.vault.load(A)).toBeNull();
    });
    it.each(["../123456789012345678", A + "/x", "0", "012345678901234567", "1", "18446744073709551616", 123, null, A + "\n"])("rejects invalid account %s before file I/O", async account => {
        const h = harness();
        expect(validVaultAccount(account)).toBe(false);
        await expect(h.vault.load(account)).rejects.toThrow(message);
        await expect(h.vault.save(account, {})).rejects.toThrow(message);
        await expect(h.vault.clear(account)).rejects.toThrow(message);
        expect(h.fs.lstat).not.toHaveBeenCalled();
        expect(h.fs.open).not.toHaveBeenCalled();
    });
    it.each(["basic_text", "unknown", "", "unexpected"])("rejects Linux backend %s even when encryption reports available", async backend => {
        const h = harness(); h.deps.platform = "linux";
        vi.mocked(h.crypto.getSelectedStorageBackend!).mockReturnValue(backend);
        expect(h.vault.available()).toBe(false);
        await expect(h.vault.save(A, {})).rejects.toThrow(message);
        await expect(h.vault.load(A)).rejects.toThrow(message);
        expect(h.crypto.encryptString).not.toHaveBeenCalled();
        expect(h.fs.open).not.toHaveBeenCalled();
    });
    it.each(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"])("accepts Linux secure backend %s", backend => {
        const h = harness(); h.deps.platform = "linux";
        vi.mocked(h.crypto.getSelectedStorageBackend!).mockReturnValue(backend);
        expect(h.vault.available()).toBe(true);
    });
    it("rejects unavailable/missing/throwing providers; clear still works without crypto", async () => {
        const h = harness(); await h.vault.save(A, {});
        vi.mocked(h.crypto.isEncryptionAvailable).mockReturnValue(false);
        expect(h.vault.available()).toBe(false);
        await expect(h.vault.save(A, {})).rejects.toThrow(message);
        await h.vault.clear(A); expect(h.files.size).toBe(0);
        vi.mocked(h.crypto.isEncryptionAvailable).mockImplementation(() => { throw Error("private"); });
        expect(h.vault.available()).toBe(false);
        vi.mocked(h.crypto.isEncryptionAvailable).mockReturnValue(true);
        h.deps.platform = "linux"; delete h.crypto.getSelectedStorageBackend;
        expect(h.vault.available()).toBe(false);
    });
    it("isolates accounts and rejects ciphertext copied from another account", async () => {
        const h = harness();
        await h.vault.save(A, { token: "a" }); await h.vault.save(B, { token: "b" });
        expect(await h.vault.load(A)).toEqual({ token: "a" });
        expect(await h.vault.load(B)).toEqual({ token: "b" });
        h.files.set(h.path(B), h.files.get(h.path())!);
        await expect(h.vault.load(B)).rejects.toThrow(message);
        await h.vault.clear(B); expect(await h.vault.load(A)).toEqual({ token: "a" });
    });
    it.each([null, "value", [], { a: undefined }, { a: NaN }, { a: 1n }, { a: new Date() }, { a: "x".repeat(32769) }, { a: "😀".repeat(9000) }, JSON.parse('{"__proto__":{}}')])("rejects invalid or oversized record %#", async record => {
        const h = harness(); await expect(h.vault.save(A, record)).rejects.toThrow(message);
        expect(h.crypto.encryptString).not.toHaveBeenCalled(); expect(h.fs.open).not.toHaveBeenCalled();
    });
    it("rejects cycles, depth, sparse arrays, excessive nodes, accessors and toJSON without invoking them", async () => {
        const h = harness(); const cycle: any = {}; cycle.self = cycle;
        let deep: any = {}; for (let i = 0; i < 20; i++) deep = { deep };
        const getter = vi.fn(() => "secret"); const accessor = Object.defineProperty({}, "token", { enumerable: true, get: getter });
        const toJSON = vi.fn(() => ({}));
        for (const record of [cycle, deep, { a: Array(2) }, { a: Array(2049).fill(0) }, accessor, { toJSON }]) {
            await expect(h.vault.save(A, record)).rejects.toThrow(message);
        }
        expect(getter).not.toHaveBeenCalled(); expect(toJSON).not.toHaveBeenCalled();
    });
    it("rejects corrupt, oversized and mismatched envelope data with sanitized errors", async () => {
        const h = harness(); await h.vault.save(A, {});
        for (const plain of ["bad-json-secret", JSON.stringify({ version: 2, accountId: A, record: {} }), JSON.stringify({ version: 1, accountId: A, record: {}, extra: true }), "x".repeat(33000)]) {
            h.encrypted.set("fake", plain); h.files.set(h.path(), Buffer.from("fake"));
            await expect(h.vault.load(A)).rejects.toThrow(message);
        }
        h.files.set(h.path(), Buffer.alloc(65537));
        vi.mocked(h.crypto.decryptString).mockClear();
        await expect(h.vault.load(A)).rejects.toThrow(message);
        expect(h.crypto.decryptString).not.toHaveBeenCalled();
        h.files.set(h.path(), Buffer.from("corrupt"));
        await expect(h.vault.load(A)).rejects.toThrow(message);
    });
    it("rejects root/file symlinks before decrypting or modifying their targets", async () => {
        const h = harness(); await h.vault.save(A, {});
        for (const path of [h.root, h.path()]) {
            h.links.add(path);
            await expect(h.vault.load(A)).rejects.toThrow(message);
            await expect(h.vault.save(A, {})).rejects.toThrow(message);
            await expect(h.vault.clear(A)).rejects.toThrow(message);
            h.links.clear();
        }
        expect(h.crypto.decryptString).not.toHaveBeenCalled();
    });
    it("keeps previous ciphertext on rename failure, cleans temp and recovers queue", async () => {
        const h = harness(); await h.vault.save(A, { token: "old" });
        vi.mocked(h.fs.rename).mockRejectedValueOnce(new Error("secret-path-and-token"));
        await expect(h.vault.save(A, { token: "new" })).rejects.toThrow(message);
        expect(h.files.size).toBe(1); expect(await h.vault.load(A)).toEqual({ token: "old" });
        await h.vault.save(A, { token: "next" }); expect(await h.vault.load(A)).toEqual({ token: "next" });
    });
    it.each(["writeFile", "sync"] as const)("preserves previous ciphertext and removes temp after %s failure", async method => {
        const h = harness(); await h.vault.save(A, { token: "old" });
        const open = h.fs.open;
        h.fs.open = vi.fn(async (path, flags, mode) => {
            const handle = await open(path, flags, mode);
            if (flags === "wx") handle[method] = async () => { throw Error("private failure"); };
            return handle;
        });
        await expect(h.vault.save(A, { token: "next" })).rejects.toThrow(message);
        expect(h.files.size).toBe(1); expect(await h.vault.load(A)).toEqual({ token: "old" });
    });
    it("does not unlink a temporary file it could not exclusively create", async () => {
        const h = harness(); await h.vault.save(A, {});
        h.deps.randomId = () => "collision";
        const temporary = h.path() + ".collision.tmp"; h.files.set(temporary, Buffer.from("existing-encrypted"));
        await expect(h.vault.save(A, {})).rejects.toThrow(message);
        expect(h.files.get(temporary)!.toString()).toBe("existing-encrypted");
        expect(h.fs.unlink).not.toHaveBeenCalled();
    });
    it("serializes write, clear, then replacement and snapshots input before awaiting", async () => {
        const h = harness(); const gate = defer<void>();
        const rename = h.fs.rename;
        h.fs.rename = vi.fn(async (from, to) => { await gate.promise; await rename(from, to); });
        const record = { token: "original" };
        const saving = h.vault.save(A, record); record.token = "mutated";
        const clearing = h.vault.clear(A); const replacing = h.vault.save(A, { token: "replacement" });
        gate.resolve(); await Promise.all([saving, clearing, replacing]);
        expect([...h.encrypted.values()][0]).toContain("original");
        expect([...h.encrypted.values()][0]).not.toContain("mutated");
        expect(h.events.filter(x => x === "rename" || x === "unlink")).toEqual(["rename", "unlink", "rename"]);
        expect(await h.vault.load(A)).toEqual({ token: "replacement" });
    });
});

const nativeCode = ts.transpileModule(readFileSync(new URL("../src/vencord/native.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function nativeHarness() {
    const h = harness(); const exports: Record<string, (...args: any[]) => any> = {};
    const app = { isReady: vi.fn(() => true), getPath: vi.fn(() => "C:\\fake-profile") };
    const lock = { acquire: vi.fn(() => true), release: vi.fn() };
    const rootFor = vi.fn(() => h.root);
    const realpathSync = vi.fn((path: string) => path);
    const exitCallbacks: Array<() => void> = [];
    const modules: Record<string, unknown> = {
        "@main/utils/constants": { DATA_DIR: "fake-data" },
        electron: { app, safeStorage: h.crypto },
        "node:crypto": { randomUUID: h.deps.randomId },
        "node:fs": { realpathSync },
        "node:fs/promises": h.fs,
        "node:path": { join },
        "./panelVaultNative": { createNativePanelVault },
        "./panelVaultLock": { panelVaultRoot: rootFor, createVaultProcessLock: () => lock, verifiedDeadPID: () => false },
    };
    runInNewContext(nativeCode, { exports, process: { platform: "win32", pid: 1234, once: (_event: string, cb: () => void) => exitCallbacks.push(cb) }, URL, require: (id: string) => {
        if (!(id in modules)) throw Error("Unexpected native dependency"); return modules[id];
    } });
    return { ...h, api: exports, app, lock, rootFor, realpathSync, exit: () => exitCallbacks.forEach(cb => cb()) };
}
function sender(url = "https://discord.com/channels/@me") {
    const frame = { url, parent: null as unknown, detached: false };
    return {
        senderFrame: frame as typeof frame | null,
        sender: { isDestroyed: () => false, mainFrame: frame, getURL: () => url },
    };
}
describe("actual native IPC entry points with mocked Electron sender", () => {
    it("derives the namespace lazily from the ready app profile and validated origin", () => {
        const h = nativeHarness();
        expect(h.app.getPath).not.toHaveBeenCalled(); expect(h.realpathSync).not.toHaveBeenCalled();
        h.app.isReady.mockReturnValue(false);
        expect(h.api.panelVaultAvailable(sender())).toBe(false); expect(h.app.getPath).not.toHaveBeenCalled();
        h.app.isReady.mockReturnValue(true);
        expect(h.api.panelVaultAvailable(sender("https://ptb.discord.com/channels/@me"))).toBe(true);
        expect(h.app.getPath).toHaveBeenCalledWith("userData");
        expect(h.rootFor).toHaveBeenCalledWith("fake-data", "C:\\fake-profile", "https://ptb.discord.com", "win32");
    });
    it("returns memory-only capability and denies all file operations when another process owns the lock", async () => {
        const h = nativeHarness(); h.lock.acquire.mockReturnValue(false);
        expect(h.api.panelVaultAvailable(sender())).toBe(false);
        await expect(h.api.panelVaultLoad(sender(), A)).rejects.toThrow(message);
        await expect(h.api.panelVaultSave(sender(), A, {})).rejects.toThrow(message);
        await expect(h.api.panelVaultClear(sender(), A)).rejects.toThrow(message);
        expect(h.fs.open).not.toHaveBeenCalled(); expect(h.crypto.encryptString).not.toHaveBeenCalled();
    });
    it("releases idle ownership on exit but retains the lock while file operations are pending", async () => {
        const h = nativeHarness(); const event = sender(); expect(h.api.panelVaultAvailable(event)).toBe(true);
        const saving = h.api.panelVaultSave(event, A, {});
        h.exit(); expect(h.lock.release).not.toHaveBeenCalled();
        await saving; h.exit(); expect(h.lock.release).toHaveBeenCalledOnce();
    });
    it("binds persistence to one live WebContents and keeps ownership across same-window reload", async () => {
        const h = nativeHarness(); const owner = sender(), other = sender();
        expect(h.api.panelVaultAvailable(owner)).toBe(true);
        await h.api.panelVaultSave(owner, A, { token: "first-window" });
        expect(h.api.panelVaultAvailable(other)).toBe(false);
        await expect(h.api.panelVaultLoad(other, A)).rejects.toThrow(message);
        await expect(h.api.panelVaultSave(other, A, {})).rejects.toThrow(message);
        await expect(h.api.panelVaultClear(other, A)).rejects.toThrow(message);
        const newFrame = { ...owner.sender.mainFrame };
        owner.sender.mainFrame = newFrame; owner.senderFrame = newFrame;
        expect(h.api.panelVaultAvailable(owner)).toBe(true);
        expect(await h.api.panelVaultLoad(owner, A)).toEqual({ token: "first-window" });
    });
    it("allows ownership transfer only after destruction and pending native operations finish", async () => {
        const h = nativeHarness(); const owner = sender(), other = sender();
        expect(h.api.panelVaultAvailable(owner)).toBe(true);
        const saving = h.api.panelVaultSave(owner, A, { token: "pending" });
        owner.sender.isDestroyed = () => true;
        expect(h.api.panelVaultAvailable(other)).toBe(false);
        await expect(h.api.panelVaultLoad(other, A)).rejects.toThrow(message);
        await saving;
        expect(h.api.panelVaultAvailable(other)).toBe(true);
        expect(await h.api.panelVaultLoad(other, A)).toEqual({ token: "pending" });
        await expect(h.api.panelVaultLoad(owner, A)).rejects.toThrow(message);
    });
    it("fails closed if the previous WebContents destruction state cannot be checked", () => {
        const h = nativeHarness(); const owner = sender();
        expect(h.api.panelVaultAvailable(owner)).toBe(true);
        owner.sender.isDestroyed = () => { throw Error("unavailable"); };
        expect(h.api.panelVaultAvailable(sender())).toBe(false);
    });
    it.each(["discord.com", "ptb.discord.com", "canary.discord.com"])("allows supported top-level HTTPS origin %s", async host => {
        const h = nativeHarness(); const event = sender(`https://${host}/channels/@me`);
        expect(h.api.panelVaultAvailable(event)).toBe(true);
        await h.api.panelVaultSave(event, A, { token: "test-token" });
        expect(await h.api.panelVaultLoad(event, A)).toEqual({ token: "test-token" });
        await h.api.panelVaultClear(event, A); expect(h.files.size).toBe(0);
    });
    it.each(["data:text/html,editor", "https://example.com", "https://discord.com.evil.test", "http://discord.com", "https://discord.com:8443", "vesktop://app", "https://user:pass@discord.com", "invalid-url"])("rejects foreign/custom origin %s without crypto or disk access", async url => {
        const h = nativeHarness(); const event = sender(url);
        expect(h.api.panelVaultAvailable(event)).toBe(false);
        await expect(h.api.panelVaultLoad(event, A)).rejects.toThrow(message);
        await expect(h.api.panelVaultSave(event, A, {})).rejects.toThrow(message);
        await expect(h.api.panelVaultClear(event, A)).rejects.toThrow(message);
        expect(h.crypto.isEncryptionAvailable).not.toHaveBeenCalled(); expect(h.fs.lstat).not.toHaveBeenCalled();
        expect(h.fs.open).not.toHaveBeenCalled();
    });
    it.each(["subframe", "parent", "null-frame", "destroyed", "detached", "throwing", "different-url"])("rejects %s sender", async kind => {
        const h = nativeHarness(); const event = sender();
        if (kind === "subframe") event.senderFrame = { ...event.sender.mainFrame };
        if (kind === "parent") event.sender.mainFrame.parent = {};
        if (kind === "null-frame") event.senderFrame = null;
        if (kind === "destroyed") event.sender.isDestroyed = () => true;
        if (kind === "detached") event.sender.mainFrame.detached = true;
        if (kind === "throwing") event.sender.isDestroyed = () => { throw Error("private"); };
        if (kind === "different-url") event.sender.getURL = () => "data:text/html,editor";
        expect(h.api.panelVaultAvailable(event)).toBe(false);
        await expect(h.api.panelVaultLoad(event, A)).rejects.toThrow(message);
        await expect(h.api.panelVaultSave(event, A, {})).rejects.toThrow(message);
        await expect(h.api.panelVaultClear(event, A)).rejects.toThrow(message);
        expect(h.fs.open).not.toHaveBeenCalled();
    });
    it("never returns a record if its sender navigates while loading", async () => {
        const h = nativeHarness(); const event = sender();
        await h.api.panelVaultSave(event, A, { token: "test-private" });
        const read = h.api.panelVaultLoad(event, A);
        event.sender.mainFrame.url = "data:text/html,new-document";
        await expect(read).rejects.toThrow(message);
    });
});

const rendererCode = ts.transpileModule(readFileSync(new URL("../src/vencord/panelVault.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function renderer(native?: unknown) {
    const exports: { createPanelVault?: (account: string) => Promise<PanelVault | undefined>; } = {};
    const context: { exports: typeof exports; structuredClone: typeof structuredClone; VencordNative?: { pluginHelpers: { SupportTemplates: unknown; }; }; } = {
        exports, structuredClone, VencordNative: native === undefined ? undefined : { pluginHelpers: { SupportTemplates: native } },
    };
    runInNewContext(rendererCode, context);
    return Object.assign(exports.createPanelVault!, {
        setBridge(next: unknown) { context.VencordNative = { pluginHelpers: { SupportTemplates: next } }; },
    });
}
function bridge() {
    const records = new Map<string, unknown>();
    return {
        panelVaultAvailable: vi.fn(async () => true),
        panelVaultLoad: vi.fn(async (account: string): Promise<unknown | null> => records.get(account) ?? null),
        panelVaultSave: vi.fn(async (account: string, value: unknown) => { records.set(account, value); }),
        panelVaultClear: vi.fn(async (account: string) => { records.delete(account); }),
    };
}

describe("actual renderer vault wrapper with mocked native bridge", () => {
    it("returns undefined for absent/incomplete bridge, invalid IDs and failed capability probes", async () => {
        expect(await renderer()(A)).toBeUndefined(); expect(await renderer({})(A)).toBeUndefined();
        const b = bridge(); const create = renderer(b);
        expect(await create("../account")).toBeUndefined(); expect(b.panelVaultAvailable).not.toHaveBeenCalled();
        b.panelVaultAvailable.mockResolvedValue(false); expect(await create(A)).toBeUndefined();
        b.panelVaultAvailable.mockRejectedValue(Error("private")); expect(await create(A)).toBeUndefined();
    });
    it("probes every factory call and returns the same logical vault for an unchanged account/bridge", async () => {
        const b = bridge(); const create = renderer(b); const old = (await create(A))!; const fresh = (await create(A))!;
        expect(fresh).toBe(old);
        await old.save({ token: "old" }); await old.clear(); expect(await fresh.load()).toBeNull();
        await fresh.save({ token: "fresh" }); expect(await fresh.load()).toEqual({ token: "fresh" });
        expect(b.panelVaultAvailable).toHaveBeenCalledTimes(2);
    });
    it("concurrent availability probes resolve to the same logical vault regardless of completion order", async () => {
        const b = bridge(); const gate = defer<boolean>(); b.panelVaultAvailable.mockReturnValueOnce(gate.promise);
        const create = renderer(b); const oldFactory = create(A); const fresh = (await create(A))!;
        gate.resolve(true); expect(await oldFactory).toBe(fresh);
        await fresh.save({ token: "fresh" }); expect(await fresh.load()).toEqual({ token: "fresh" });
    });
    it("leaves session-result ownership to auth and keeps in-flight operations usable across factory calls", async () => {
        const b = bridge(); const gate = defer<unknown>(); b.panelVaultLoad.mockReturnValueOnce(gate.promise);
        const create = renderer(b); const old = (await create(A))!;
        const loading = old.load(); await Promise.resolve();
        const fresh = (await create(A))!; gate.resolve({ token: "old" });
        expect(fresh).toBe(old);
        expect(await loading).toEqual({ token: "old" }); await old.clear(); expect(await fresh.load()).toBeNull();
    });
    it("preserves the call order of queued saves and cleanup across factory calls", async () => {
        const b = bridge(); const gate = defer<unknown>(); b.panelVaultLoad.mockReturnValueOnce(gate.promise);
        const create = renderer(b); const old = (await create(A))!;
        const loading = old.load(); await Promise.resolve();
        const saving = old.save({ token: "stale" }); const clearing = old.clear();
        const fresh = (await create(A))!; const replacement = fresh.save({ token: "fresh" });
        gate.resolve(null);
        expect(await loading).toBeNull(); await saving;
        await clearing; await replacement;
        expect(b.panelVaultSave).toHaveBeenCalledTimes(2);
        expect(b.panelVaultClear).toHaveBeenCalledTimes(1);
        expect(await fresh.load()).toEqual({ token: "fresh" });
    });
    it("orders in-flight old save, old clear and new save across factories", async () => {
        const b = bridge(); const gate = defer<void>(); const entered = defer<void>();
        const save = b.panelVaultSave.getMockImplementation()!;
        b.panelVaultSave.mockImplementationOnce(async (account, value) => { entered.resolve(); await gate.promise; await save(account, value); });
        const create = renderer(b); const old = (await create(A))!;
        const writing = old.save({ token: "old" }); await entered.promise;
        const clearing = old.clear(); const fresh = (await create(A))!; const replacing = fresh.save({ token: "new" });
        gate.resolve(); await writing; await clearing; await replacing;
        expect(await fresh.load()).toEqual({ token: "new" });
    });
    it("snapshots save arguments and isolates different Discord accounts", async () => {
        const b = bridge(); const create = renderer(b);
        const a = (await create(A))!; const other = (await create(B))!;
        expect(a).not.toBe(other);
        const record = { token: "before" }; const saving = a.save(record); record.token = "after";
        await saving; await other.save({ token: "other" }); await other.clear();
        expect(await a.load()).toEqual({ token: "before" }); expect(await other.load()).toBeNull();
        await create(B); expect(await a.load()).toEqual({ token: "before" });
    });
    it("sanitizes native exceptions and recovers the account queue", async () => {
        const b = bridge(); const vault = (await renderer(b)(A))!;
        b.panelVaultSave.mockRejectedValueOnce(Error("secret-value-or-path"));
        await expect(vault.save({})).rejects.toThrow(message);
        await vault.save({ token: "ok" }); expect(await vault.load()).toEqual({ token: "ok" });
        await expect(vault.save({ callback: () => {} })).rejects.toThrow(message);
    });
    it("retains identity through temporary capability loss so pending auth cleanup can finish", async () => {
        const b = bridge(); const create = renderer(b); const old = (await create(A))!;
        await old.save({ token: "pending" });
        b.panelVaultAvailable.mockResolvedValueOnce(false);
        expect(await create(A)).toBeUndefined();
        await old.clear();
        const restored = (await create(A))!;
        expect(restored).toBe(old); expect(await restored.load()).toBeNull();
    });
    it("does not return an old bridge after an availability probe spans bridge replacement", async () => {
        const oldBridge = bridge(); const create = renderer(oldBridge);
        const old = (await create(A))!;
        const gate = defer<boolean>(); oldBridge.panelVaultAvailable.mockReturnValueOnce(gate.promise);
        const pending = create(A); const nextBridge = bridge(); create.setBridge(nextBridge);
        const fresh = (await create(A))!;
        expect(fresh).not.toBe(old); expect(await create(A)).toBe(fresh);
        gate.resolve(true); expect(await pending).toBeUndefined();
        await fresh.save({ token: "new" }); expect(nextBridge.panelVaultSave).toHaveBeenCalledOnce();
        expect(oldBridge.panelVaultSave).not.toHaveBeenCalled();
    });
});
