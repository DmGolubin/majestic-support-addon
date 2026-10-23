import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadAdapter } from "./betterdiscordHarness";

const account = "123456789012345678";
const dirs: string[] = [];
const temporary = () => { const dir = mkdtempSync(join(tmpdir(), "stx-q18-dpapi-")); dirs.push(dir); return dir; };
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        const target = resolve(dir);
        if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("stx-q18-dpapi-")) throw new Error("Unsafe fixture cleanup");
        rmSync(target, { recursive: true, force: true });
    }
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function cipher() {
    const key = randomBytes(32);
    return {
        isEncryptionAvailable: () => true,
        encryptString(value: string) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
            return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]); },
        decryptString(value: Buffer) { const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
            cipher.setAuthTag(value.subarray(-16)); return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString(); }
    };
}

describe("q18 asynchronous native vault lifecycle", () => {
    it("awaits encrypt/decrypt in order, snapshots saves and drains accepted work before releasing ownership", async () => {
        const dir = temporary(), sync = cipher(), encryptGate = deferred(), decryptGate = deferred();
        const crypto = { ...sync,
            encryptString: vi.fn(async (value: string) => { await encryptGate.promise; return sync.encryptString(value); }),
            decryptString: vi.fn(async (value: Buffer) => { await decryptGate.promise; return sync.decryptString(value); }) };
        const { createVaultSession } = loadAdapter("native/vault.ts");
        const one = createVaultSession({ root: dir, crypto, platform: "win32" });
        const two = createVaultSession({ root: dir, crypto: sync, platform: "win32" });
        const vault = one.forAccount(account), record = { refreshToken: "q18-first-private" };
        const first = vault.save(record); record.refreshToken = "mutated";
        const loaded = vault.load(), last = vault.save({ refreshToken: "q18-last-private" });
        // Attach rejection handlers immediately, including on the red implementation.
        const results = Promise.allSettled([first, loaded, last]);
        let closed = false;
        const closing = one.close().then(() => { closed = true; });
        try {
            await vi.waitFor(() => expect(crypto.encryptString).toHaveBeenCalledOnce());
            expect(closed).toBe(false);
            expect(crypto.decryptString).not.toHaveBeenCalled();
            expect(two.forAccount(account)).toBeUndefined();
            await expect(vault.save({ refreshToken: "too-late" })).rejects.toThrow();
            encryptGate.resolve();
            await vi.waitFor(() => expect(crypto.decryptString).toHaveBeenCalledOnce());
            expect(crypto.encryptString).toHaveBeenCalledOnce();
            expect(closed).toBe(false);
            expect(two.forAccount(account)).toBeUndefined();
            expect(readFileSync(join(dir, account + ".bin")).includes(Buffer.from("q18-first-private"))).toBe(false);
            decryptGate.resolve();
            expect(await results).toEqual([
                { status: "fulfilled", value: undefined },
                { status: "fulfilled", value: { refreshToken: "q18-first-private" } },
                { status: "fulfilled", value: undefined }
            ]);
            await closing;
            const replacement = two.forAccount(account);
            expect(await replacement.load()).toEqual({ refreshToken: "q18-last-private" });
            await replacement.clear();
        } finally { encryptGate.resolve(); decryptGate.resolve(); await results; await closing; await two.close(); }
        expect(readdirSync(dir)).toEqual([]);
    });
    it("sanitizes rejected crypto promises, preserves prior ciphertext and recovers the queue", async () => {
        const dir = temporary(), sync = cipher();
        const crypto = { ...sync, encryptString: vi.fn(async (value: string) => sync.encryptString(value)),
            decryptString: vi.fn(async (value: Buffer) => sync.decryptString(value)) };
        const { createVaultSession } = loadAdapter("native/vault.ts");
        const session = createVaultSession({ root: dir, crypto, platform: "win32" }), vault = session.forAccount(account);
        try {
            await vault.save({ refreshToken: "original" });
            const before = readFileSync(join(dir, account + ".bin"));
            crypto.encryptString.mockRejectedValueOnce(new Error("private encryption detail"));
            await expect(vault.save({ refreshToken: "replacement" })).rejects.toThrow("Protected panel storage operation failed.");
            expect(readFileSync(join(dir, account + ".bin"))).toEqual(before);
            crypto.decryptString.mockRejectedValueOnce(new Error("private decryption detail"));
            await expect(vault.load()).rejects.toThrow("Protected panel storage operation failed.");
            expect(await vault.load()).toEqual({ refreshToken: "original" });
        } finally { await session.close(); }
    });
    it.each(["native/vault.ts", "native/vaultHost.ts"])("%s serializes open, cancellation by close, and reopen around a pending probe", async adapter => {
        const dir = temporary(), plugins = join(dir, "plugins"); mkdirSync(plugins);
        const calls: any[] = [];
        const execFile = vi.fn((_file, _args, _options, callback) => {
            const call = { callback, request: undefined as any };
            calls.push(call);
            return { stdin: Object.assign(new EventEmitter(), { end(input: string) { call.request = JSON.parse(input); } }), kill: vi.fn() };
        });
        const mod = loadAdapter(adapter, { electron: {}, "@electron/remote": {}, "node:child_process": {
            execFile, spawnSync() { throw new Error("Synchronous child forbidden"); }
        } }, { location: { origin: "https://discord.com" }, BdApi: { Plugins: { folder: plugins } } });
        let closed = false;
        const opened = mod.createPanelVault(account), duplicate = mod.createPanelVault(account);
        const closing = mod.closePanelVault().then(() => { closed = true; });
        const reopened = mod.createPanelVault(account);
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        expect(closed).toBe(false);
        expect(calls[0].request.operation).toBe("probe");
        calls[0].callback(null, calls[0].request.data, "");
        const stale = await opened;
        expect(stale).toBeDefined();
        expect(await duplicate).toBe(stale);
        await closing;
        await expect(stale.save({ refreshToken: "cancelled" })).rejects.toThrow();
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        calls[1].callback(null, calls[1].request.data, "");
        expect(await reopened).toBeDefined();
        expect(await reopened).not.toBe(stale);
        await mod.closePanelVault();
    });
    it("continues using synchronous Electron safeStorage without starting DPAPI", async () => {
        const dir = temporary(), plugins = join(dir, "plugins"); mkdirSync(plugins);
        const execFile = vi.fn();
        const mod = loadAdapter("native/vault.ts", { electron: { safeStorage: cipher() }, "node:child_process": { execFile } },
            { location: { origin: "https://discord.com" }, BdApi: { Plugins: { folder: plugins } } });
        try {
            const vault = await mod.createPanelVault(account);
            await vault.save({ refreshToken: "sync-safeStorage" });
            expect(await vault.load()).toEqual({ refreshToken: "sync-safeStorage" });
            expect(execFile).not.toHaveBeenCalled();
        } finally { await mod.closePanelVault(); }
    });
});
