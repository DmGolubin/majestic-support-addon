/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { join, posix, win32 } from "node:path";

const ORIGINS = ["https://discord.com", "https://ptb.discord.com", "https://canary.discord.com"];
const MAX_LOCK_BYTES = 512;

/** userData must come from main-process realpath(app.getPath("userData")), never IPC. */
export function panelVaultRoot(base: string, userData: string, origin: string, platform: string): string {
    const path = platform === "win32" ? win32 : posix;
    if (!path.isAbsolute(userData) || !ORIGINS.includes(origin)) throw new Error("Protected panel storage unavailable.");
    let normalized = path.normalize(userData);
    if (normalized !== path.parse(normalized).root) normalized = normalized.replace(/[\\/]+$/, "");
    if (platform === "win32") normalized = normalized.toLowerCase();
    const namespace = createHash("sha256").update(JSON.stringify([normalized, origin])).digest("hex");
    return join(base, "support-templates-vault-v2", namespace);
}

interface Info {
    size: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
}
export interface VaultLockFS {
    mkdirSync(path: string, options: { recursive: true; mode: number; }): unknown;
    lstatSync(path: string): Info;
    openSync(path: string, flags: number | string, mode?: number): number;
    fstatSync(fd: number): Info;
    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
    writeFileSync(fd: number, data: string): void;
    fsyncSync(fd: number): void;
    closeSync(fd: number): void;
    unlinkSync(path: string): void;
}
interface Owner { version: 1; pid: number; nonce: string; }
const validNonce = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9-]{16,64}$/.test(value);
const validPID = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;

/** True only for ESRCH, never EPERM or an unknown probe failure. No signal is sent. */
export function verifiedDeadPID(pid: number, probe: (pid: number, signal: 0) => unknown): boolean {
    if (!validPID(pid)) return false;
    try { probe(pid, 0); return false; }
    catch (error) { return (error as { code?: string; } | null)?.code === "ESRCH"; }
}

export function createVaultProcessLock(deps: {
    root: string;
    pid: number;
    nonce: string;
    fs: VaultLockFS;
    isDead(pid: number): boolean;
}) {
    const { fs } = deps;
    const lock = join(deps.root, "owner.lock");
    const gate = join(deps.root, "acquire.gate");
    let held = false;
    const missing = (error: unknown) => (error as { code?: string; } | null)?.code === "ENOENT";
    const readOwner = (): Owner | null => {
        let stat: Info;
        try { stat = fs.lstatSync(lock); }
        catch (error) { if (missing(error)) return null; throw error; }
        if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > MAX_LOCK_BYTES) throw new Error();
        const fd = fs.openSync(lock, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            const opened = fs.fstatSync(fd);
            if (!opened.isFile() || !opened.size || opened.size > MAX_LOCK_BYTES) throw new Error();
            const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1);
            let count = 0;
            while (count < buffer.length) {
                const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
                if (!read) break;
                count += read;
            }
            if (!count || count > MAX_LOCK_BYTES) throw new Error();
            const value = JSON.parse(buffer.subarray(0, count).toString("utf8"));
            if (!value || value.version !== 1 || !validPID(value.pid) || !validNonce(value.nonce)
                || Object.keys(value).sort().join(",") !== "nonce,pid,version") throw new Error();
            return value;
        } finally { fs.closeSync(fd); }
    };
    const ours = (owner: Owner | null) => owner?.pid === deps.pid && owner.nonce === deps.nonce;
    const underGate = (action: () => boolean): boolean => {
        let fd: number | undefined;
        let success = false;
        try {
            if (!validPID(deps.pid) || !validNonce(deps.nonce)) return false;
            fs.mkdirSync(deps.root, { recursive: true, mode: 0o700 });
            const root = fs.lstatSync(deps.root);
            if (!root.isDirectory() || root.isSymbolicLink()) return false;
            // All acquire/release paths use this gate. Never recover a leftover gate:
            // ambiguity after a crash deliberately requires repair, not stealing a lock.
            fd = fs.openSync(gate, "wx", 0o600);
            success = action();
        } catch { success = false; }
        finally {
            if (fd !== undefined) {
                try { fs.closeSync(fd); } catch { success = false; }
                try { fs.unlinkSync(gate); } catch { success = false; }
            }
        }
        return success;
    };
    return {
        acquire(): boolean {
            return underGate(() => {
                const owner = readOwner();
                if (held) return ours(owner);
                if (owner) {
                    if (!deps.isDead(owner.pid)) return false;
                    // Removal and replacement both occur inside the exclusive gate.
                    fs.unlinkSync(lock);
                }
                const fd = fs.openSync(lock, "wx", 0o600);
                try {
                    fs.writeFileSync(fd, JSON.stringify({ version: 1, pid: deps.pid, nonce: deps.nonce }));
                    fs.fsyncSync(fd);
                } finally { fs.closeSync(fd); }
                held = true;
                return true;
            });
        },
        release(): void {
            if (!held) return;
            underGate(() => {
                if (!ours(readOwner())) return false;
                fs.unlinkSync(lock);
                held = false;
                return true;
            });
        },
    };
}
