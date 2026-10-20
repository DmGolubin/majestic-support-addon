/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { constants } from "node:fs";
import { join } from "node:path";

const MAX_PLAIN = 32 * 1024;
const MAX_ENCRYPTED = 64 * 1024;
const failed = () => new Error("Protected panel storage operation failed.");

export function validVaultAccount(value: unknown): value is string {
    return typeof value === "string" && /^[1-9]\d{16,19}$/.test(value)
        && BigInt(value) <= 18446744073709551615n;
}

interface FileInfo {
    size: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}
interface Handle {
    stat(): Promise<FileInfo>;
    read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number; }>;
    writeFile(data: Buffer): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
}
export interface VaultDependencies {
    root: string; // Main-process configuration only; never an IPC argument.
    platform: string;
    randomId(): string;
    fs: {
        mkdir(path: string, options: { recursive: true; mode: number; }): Promise<unknown>;
        lstat(path: string): Promise<FileInfo>;
        open(path: string, flags: number | string, mode?: number): Promise<Handle>;
        rename(from: string, to: string): Promise<void>;
        unlink(path: string): Promise<void>;
    };
    crypto: {
        isEncryptionAvailable(): boolean;
        getSelectedStorageBackend?(): string;
        encryptString(value: string): Buffer | Promise<Buffer>;
        decryptString(value: Buffer): string | Promise<string>;
    };
}

// Validate JSON without invoking getters/toJSON or silently dropping unsupported values.
function recordJSON(value: unknown): string {
    let nodes = 0;
    let characters = 0;
    const visit = (item: unknown, depth: number): void => {
        if (++nodes > 2048 || depth > 16) throw failed();
        if (typeof item === "string") {
            characters += item.length;
            if (characters > MAX_PLAIN) throw failed();
            return;
        }
        if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) return;
        if (typeof item !== "object") throw failed();
        const array = Array.isArray(item);
        if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw failed();
        if (array && item.length > 2048) throw failed();
        const keys = Reflect.ownKeys(item);
        if (keys.length > 2049) throw failed();
        for (const key of keys) {
            if (array && key === "length") continue;
            if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) throw failed();
            characters += key.length;
            if (characters > MAX_PLAIN) throw failed();
            const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
            if (!descriptor.enumerable || !("value" in descriptor)) throw failed();
            if (array && !/^(0|[1-9]\d*)$/.test(key)) throw failed();
            visit(descriptor.value, depth + 1);
        }
        if (array && keys.length !== item.length + 1) throw failed();
    };
    if (!value || typeof value !== "object" || Array.isArray(value)) throw failed();
    visit(value, 0);
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, "utf8") > MAX_PLAIN) throw failed();
    return json;
}

const missing = (error: unknown) => (error as { code?: string; } | null)?.code === "ENOENT";

/** No I/O until a method is called. Dependencies permit tests with no real files or OS keys. */
export function createNativePanelVault(deps: VaultDependencies) {
    let tail: Promise<unknown> = Promise.resolve();
    const serialized = <T>(action: () => Promise<T>): Promise<T> => {
        const next = tail.then(action).catch(() => { throw failed(); });
        tail = next.catch(() => {});
        return next;
    };
    const available = () => {
        try {
            if (!deps.crypto.isEncryptionAvailable()) return false;
            return deps.platform !== "linux" || ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]
                .includes(deps.crypto.getSelectedStorageBackend?.() ?? "");
        } catch { return false; }
    };
    const pathFor = (account: unknown) => {
        if (!validVaultAccount(account)) throw failed();
        return join(deps.root, `${account}.bin`);
    };
    const info = async (path: string) => {
        try { return await deps.fs.lstat(path); }
        catch (error) { if (missing(error)) return null; throw error; }
    };
    const directory = async (create: boolean) => {
        if (create) await deps.fs.mkdir(deps.root, { recursive: true, mode: 0o700 });
        const stat = await info(deps.root);
        if (!stat) return false;
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw failed();
        return true;
    };
    const existing = async (path: string) => {
        const stat = await info(path);
        if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw failed();
        return stat;
    };
    return {
        available,
        load: (account: unknown): Promise<unknown | null> => serialized(async () => {
            const path = pathFor(account);
            if (!available()) throw failed();
            if (!await directory(false)) return null;
            if (!await existing(path)) return null;
            const handle = await deps.fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            let encrypted: Buffer;
            try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ENCRYPTED) throw failed();
                const bytes = Buffer.alloc(MAX_ENCRYPTED + 1);
                let count = 0;
                while (count < bytes.length) {
                    const read = await handle.read(bytes, count, bytes.length - count, count);
                    if (!read.bytesRead) break;
                    count += read.bytesRead;
                }
                if (!count || count > MAX_ENCRYPTED) throw failed();
                encrypted = bytes.subarray(0, count);
            } finally { await handle.close(); }
            const plain = await deps.crypto.decryptString(encrypted);
            if (typeof plain !== "string" || Buffer.byteLength(plain, "utf8") > MAX_PLAIN + 128) throw failed();
            const envelope = JSON.parse(plain);
            if (!envelope || envelope.version !== 1 || envelope.accountId !== account
                || Object.keys(envelope).sort().join(",") !== "accountId,record,version") throw failed();
            recordJSON(envelope.record);
            return envelope.record;
        }),
        save: (account: unknown, record: unknown): Promise<void> => {
            // Capture before queuing so later caller mutation cannot change this write.
            let plain: string;
            let path: string;
            try {
                path = pathFor(account);
                plain = `{"version":1,"accountId":${JSON.stringify(account)},"record":${recordJSON(record)}}`;
            } catch { return Promise.reject(failed()); }
            return serialized(async () => {
                if (!available()) throw failed();
                const encrypted = await deps.crypto.encryptString(plain);
                if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_ENCRYPTED) throw failed();
                await directory(true);
                await existing(path);
                const id = deps.randomId();
                if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw failed();
                const temporary = `${path}.${id}.tmp`;
                let owned = false;
                try {
                    const handle = await deps.fs.open(temporary, "wx", 0o600);
                    owned = true;
                    try { await handle.writeFile(encrypted); await handle.sync(); }
                    finally { await handle.close(); }
                    await deps.fs.rename(temporary, path);
                    owned = false;
                } finally {
                    if (owned) await deps.fs.unlink(temporary).catch(() => {});
                }
            });
        },
        // Deletion must still work if the OS key store becomes unavailable after login.
        clear: (account: unknown): Promise<void> => serialized(async () => {
            const path = pathFor(account);
            if (!await directory(false)) return;
            await existing(path);
            try { await deps.fs.unlink(path); }
            catch (error) { if (!missing(error)) throw error; }
        }),
    };
}
