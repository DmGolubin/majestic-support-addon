import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createVaultProcessLock, panelVaultRoot, verifiedDeadPID, VaultLockFS } from "../src/vencord/panelVaultLock";

const ROOT = "fake-vault";
const NONCE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NONCE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const error = (code: string) => Object.assign(new Error("fixture failure"), { code });

function fakeFS() {
    const files = new Map<string, Buffer>();
    const directories = new Set<string>();
    const links = new Set<string>();
    const handles = new Map<number, string>();
    let next = 0;
    const info = (path: string) => {
        if (!files.has(path) && !directories.has(path)) throw error("ENOENT");
        return { size: files.get(path)?.length ?? 0, isDirectory: () => directories.has(path),
            isFile: () => files.has(path), isSymbolicLink: () => links.has(path) };
    };
    const fs: VaultLockFS = {
        mkdirSync: vi.fn(path => { directories.add(path); }),
        lstatSync: vi.fn(info),
        openSync: vi.fn((path, flags) => {
            if (flags === "wx") {
                if (files.has(path)) throw error("EEXIST");
                files.set(path, Buffer.alloc(0));
            } else if (!files.has(path)) throw error("ENOENT");
            const fd = ++next; handles.set(fd, path); return fd;
        }),
        fstatSync: vi.fn(fd => info(handles.get(fd)!)),
        readSync: vi.fn((fd, target, offset, length, position) => {
            const bytes = files.get(handles.get(fd)!)!;
            const count = Math.max(0, Math.min(length, bytes.length - position));
            if (count) bytes.copy(target, offset, position, position + count);
            return count;
        }),
        writeFileSync: vi.fn((fd, data) => { files.set(handles.get(fd)!, Buffer.from(data)); }),
        fsyncSync: vi.fn(),
        closeSync: vi.fn(fd => { handles.delete(fd); }),
        unlinkSync: vi.fn(path => { if (!files.delete(path)) throw error("ENOENT"); }),
    };
    const ownerPath = (root = ROOT) => join(root, "owner.lock");
    const gatePath = (root = ROOT) => join(root, "acquire.gate");
    const putOwner = (pid: number, nonce = NONCE_A, root = ROOT) => files.set(ownerPath(root), Buffer.from(JSON.stringify({ version: 1, pid, nonce })));
    const owner = (root = ROOT) => JSON.parse(files.get(ownerPath(root))!.toString());
    const lock = (pid: number, nonce = NONCE_A, isDead = (_pid: number) => false, root = ROOT) => createVaultProcessLock({ root, fs, pid, nonce, isDead });
    return { fs, files, directories, links, handles, ownerPath, gatePath, putOwner, owner, lock };
}

describe("profile/channel vault namespaces", () => {
    it("isolates Stable, PTB and Canary even when DATA_DIR and account are shared", () => {
        const roots = ["https://discord.com", "https://ptb.discord.com", "https://canary.discord.com"]
            .map(origin => panelVaultRoot("shared-data", "C:\\Discord", origin, "win32"));
        expect(new Set(roots).size).toBe(3);
        for (const root of roots) { expect(root).toMatch(/[a-f0-9]{64}$/); expect(root).not.toContain("Discord"); }
    });
    it("normalizes Windows case, separators and trailing slash, but separates actual profiles", () => {
        const root = panelVaultRoot("shared", "C:\\Users\\Test\\Discord", "https://discord.com", "win32");
        expect(panelVaultRoot("shared", "c:/users/test/x/../discord/", "https://discord.com", "win32")).toBe(root);
        expect(panelVaultRoot("shared", "C:\\Users\\Other\\Discord", "https://discord.com", "win32")).not.toBe(root);
        expect(panelVaultRoot("shared", "/Home/Test", "https://discord.com", "linux"))
            .not.toBe(panelVaultRoot("shared", "/home/test", "https://discord.com", "linux"));
    });
    it("rejects relative profiles and untrusted origins", () => {
        expect(() => panelVaultRoot("base", "relative", "https://discord.com", "win32")).toThrow();
        expect(() => panelVaultRoot("base", "C:\\profile", "https://discord.com.evil", "win32")).toThrow();
    });
});

describe("process death verification", () => {
    it("uses signal zero and accepts only ESRCH as proof of death", () => {
        const live = vi.fn(); expect(verifiedDeadPID(42, live)).toBe(false); expect(live).toHaveBeenCalledWith(42, 0);
        expect(verifiedDeadPID(42, () => { throw error("ESRCH"); })).toBe(true);
        for (const code of ["EPERM", "EACCES", "EINVAL", "UNKNOWN"]) {
            expect(verifiedDeadPID(42, () => { throw error(code); })).toBe(false);
        }
        expect(verifiedDeadPID(42, () => { throw null; })).toBe(false);
        expect(verifiedDeadPID(-1, live)).toBe(false); expect(live).toHaveBeenCalledTimes(1);
    });
});

describe("exclusive process vault lock with fake filesystem/processes", () => {
    it("allows only one owner in a shared namespace and never stomps a live process", () => {
        const h = fakeFS(); const a = h.lock(100), b = h.lock(200, NONCE_B);
        expect(a.acquire()).toBe(true); expect(a.acquire()).toBe(true);
        expect(b.acquire()).toBe(false); expect(h.owner()).toEqual({ version: 1, pid: 100, nonce: NONCE_A });
        expect(h.fs.openSync).toHaveBeenCalledWith(h.ownerPath(), "wx", 0o600);
        expect(h.fs.openSync).toHaveBeenCalledWith(h.gatePath(), "wx", 0o600);
        b.release(); expect(h.owner().pid).toBe(100);
        a.release(); expect(b.acquire()).toBe(true); expect(h.owner().pid).toBe(200);
        expect(h.handles.size).toBe(0);
    });
    it("permits independent processes for distinct profiles and channels", () => {
        const h = fakeFS(); const roots = [
            panelVaultRoot("base", "C:\\profile1", "https://discord.com", "win32"),
            panelVaultRoot("base", "C:\\profile2", "https://discord.com", "win32"),
            panelVaultRoot("base", "C:\\profile1", "https://ptb.discord.com", "win32"),
        ];
        roots.forEach((root, index) => expect(h.lock(100 + index, NONCE_A, () => false, root).acquire()).toBe(true));
        expect(h.files.size).toBe(3);
    });
    it("recovers a verified dead owner and refuses PID reuse or an uncertain result", () => {
        const h = fakeFS(); h.putOwner(99);
        const dead = vi.fn(pid => pid === 99); const next = h.lock(100, NONCE_B, dead);
        expect(next.acquire()).toBe(true); expect(dead).toHaveBeenCalledWith(99); expect(h.owner().nonce).toBe(NONCE_B);
        expect(h.lock(101, NONCE_A, () => false).acquire()).toBe(false);
        expect(h.lock(101, NONCE_A, () => { throw error("EPERM"); }).acquire()).toBe(false);
        expect(h.owner().pid).toBe(100);
    });
    it("holds the acquisition gate across dead-owner check, removal and replacement", () => {
        const h = fakeFS(); h.putOwner(99);
        const contender = h.lock(200, NONCE_B, pid => pid === 99);
        let competingResult: boolean | undefined;
        const winner = h.lock(100, NONCE_A, pid => {
            expect(h.files.has(h.gatePath())).toBe(true);
            competingResult = contender.acquire();
            return pid === 99;
        });
        expect(winner.acquire()).toBe(true); expect(competingResult).toBe(false);
        expect(contender.acquire()).toBe(false); expect(h.owner().pid).toBe(100);
        const removals = vi.mocked(h.fs.unlinkSync).mock.calls.filter(([path]) => path === h.ownerPath());
        expect(removals).toHaveLength(1);
    });
    it.each(["", "not-json", JSON.stringify({ pid: 99 }), JSON.stringify({ version: 2, pid: 99, nonce: NONCE_A }),
        JSON.stringify({ version: 1, pid: -1, nonce: NONCE_A }), JSON.stringify({ version: 1, pid: 99, nonce: "bad" }),
        JSON.stringify({ version: 1, pid: 99, nonce: NONCE_A, extra: true }), "x".repeat(513)])("fails closed on malformed owner record %#", bytes => {
        const h = fakeFS(); h.files.set(h.ownerPath(), Buffer.from(bytes)); const dead = vi.fn(() => true);
        expect(h.lock(100, NONCE_A, dead).acquire()).toBe(false);
        expect(dead).not.toHaveBeenCalled(); expect(h.files.get(h.ownerPath())!.toString()).toBe(bytes);
    });
    it("never automatically removes a leftover acquisition gate", () => {
        const h = fakeFS(); h.files.set(h.gatePath(), Buffer.alloc(0)); h.putOwner(99);
        const dead = vi.fn(() => true); expect(h.lock(100, NONCE_B, dead).acquire()).toBe(false);
        expect(dead).not.toHaveBeenCalled(); expect(h.fs.unlinkSync).not.toHaveBeenCalled(); expect(h.owner().pid).toBe(99);
    });
    it("release checks both PID and nonce and never deletes replacement ownership", () => {
        const h = fakeFS(); const a = h.lock(100); expect(a.acquire()).toBe(true);
        h.putOwner(100, NONCE_B); a.release(); expect(h.owner().nonce).toBe(NONCE_B);
        h.putOwner(200, NONCE_A); a.release(); expect(h.owner().pid).toBe(200);
        expect(a.acquire()).toBe(false);
    });
    it("release uses the same gate and leaves ownership alone if the gate is busy", () => {
        const h = fakeFS(); const a = h.lock(100); expect(a.acquire()).toBe(true);
        h.files.set(h.gatePath(), Buffer.alloc(0)); a.release(); expect(h.owner().pid).toBe(100);
    });
    it("rejects root and owner symlinks and never probes a symlink's PID", () => {
        for (const path of [ROOT, join(ROOT, "owner.lock")]) {
            const h = fakeFS(); h.putOwner(99); h.links.add(path); const dead = vi.fn(() => true);
            expect(h.lock(100, NONCE_B, dead).acquire()).toBe(false); expect(dead).not.toHaveBeenCalled();
            expect(h.owner().pid).toBe(99);
        }
    });
    it("fails closed after interrupted owner creation without treating partial data as stale", () => {
        const h = fakeFS(); vi.mocked(h.fs.writeFileSync).mockImplementationOnce(() => { throw error("EIO"); });
        expect(h.lock(100).acquire()).toBe(false);
        const dead = vi.fn(() => true); expect(h.lock(200, NONCE_B, dead).acquire()).toBe(false);
        expect(dead).not.toHaveBeenCalled(); expect(h.files.get(h.ownerPath())!.length).toBe(0);
    });
    it("does not report availability when gate cleanup fails", () => {
        const h = fakeFS(); const unlink = h.fs.unlinkSync;
        h.fs.unlinkSync = vi.fn(path => { if (path === h.gatePath()) throw error("EACCES"); unlink(path); });
        const lock = h.lock(100);
        expect(lock.acquire()).toBe(false); expect(lock.acquire()).toBe(false);
        expect(h.owner().pid).toBe(100); expect(h.files.has(h.gatePath())).toBe(true);
    });
});
