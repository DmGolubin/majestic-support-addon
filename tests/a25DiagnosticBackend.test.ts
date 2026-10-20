import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticPersistence } from "../src/core/diagnosticPersistence";
import { bridgeFS, ERROR, NOW, payload, sourceModule, storageModule as api } from "./a22DiagnosticStorageHarness";

const roots: string[] = [];
const sid = "a".repeat(32);
const state = (seqs: number[], patch = {}) => ({
    schema: 1, continuous: true, enabled: true, optedOut: false, campaign: null, campaignUntil: 0, until: 0,
    sessionId: sid, sequence: Math.max(0, ...seqs), clearGeneration: 0, savedAt: NOW, dropped: 0, deliveryLost: 0,
    events: seqs.map(seq => ({ seq, time: NOW + seq, event: "request.start", data: { method: "GET", route: "/me" } })), ...patch,
});
const report = (seqs: number[], patch = {}) => JSON.stringify(payload({ journal: state(seqs, patch) }));
function fixture(overrides = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "stx-a25-logs-"))); roots.push(root);
    return { root, make: () => api.createDiagnosticFileStorage({ root, fs: { ...fs, ...overrides } }),
        path: join(root, "main.log"), old: join(root, "SupportTemplates-diagnostics.txt") };
}
afterEach(() => {
    vi.useRealTimers();
    for (const root of roots.splice(0)) {
        if (dirname(resolve(root)) !== fs.realpathSync(tmpdir()) || !root.includes("stx-a25-logs-")) throw Error("Unsafe cleanup");
        fs.rmSync(root, { recursive: true, force: true });
    }
});
describe("A25 main.log migration and native folder", () => {
    it("copies old TXT/legacy/archives byte-for-byte, resumes dedupe and never overwrites the old originals", async () => {
        const f = fixture(); await f.make().save(report([1, 2]));
        const original = fs.readFileSync(f.path);
        fs.renameSync(f.path, f.old);
        for (const suffix of [".1", ".9", ".legacy"])
            fs.writeFileSync(join(f.root, `SupportTemplates-diagnostics${suffix}.txt`), original);
        const loaded = await f.make().load();
        expect(loaded.path).toBe(f.path);
        for (const suffix of ["", ".1", ".9", ".legacy"])
            expect(fs.readFileSync(join(f.root, `main${suffix}.log`)).equals(original)).toBe(true);
        await f.make().save(report([1, 2, 3]));
        expect(fs.readFileSync(f.path).subarray(0, original.length).equals(original)).toBe(true);
        expect(fs.readFileSync(f.path, "utf8").match(/"seq":3,/g)).toHaveLength(1);
        await f.make().load();
        for (const suffix of ["", ".1", ".9", ".legacy"])
            expect(fs.readFileSync(join(f.root, `SupportTemplates-diagnostics${suffix}.txt`)).equals(original)).toBe(true);
    });
    it("retries an interrupted archive copy before active migration without destroying either source", async () => {
        let fail = true;
        const f = fixture({ renameSync: (from: string, to: string) => {
            if (fail && to.endsWith("main.1.log")) throw Error("disk unavailable");
            fs.renameSync(from, to);
        } });
        fs.writeFileSync(f.old, "old active\n");
        const archive = join(f.root, "SupportTemplates-diagnostics.1.txt"); fs.writeFileSync(archive, "old archive\n");
        await expect(f.make().load()).rejects.toThrow(ERROR);
        expect(fs.readFileSync(f.old, "utf8")).toBe("old active\n");
        expect(fs.existsSync(f.path)).toBe(false);
        fail = false; await f.make().load();
        expect(fs.readFileSync(f.path, "utf8")).toBe("old active\n");
        expect(fs.readFileSync(join(f.root, "main.1.log"), "utf8")).toBe("old archive\n");
        expect(fs.readFileSync(archive, "utf8")).toBe("old archive\n");
    });
    it("does not mutate old hardlinked logs or copy them into the active history", async () => {
        const f = fixture(); fs.writeFileSync(f.old, "untouched");
        fs.linkSync(f.old, join(f.root, "other"));
        await expect(f.make().load()).rejects.toThrow(ERROR);
        expect(fs.readFileSync(f.old, "utf8")).toBe("untouched");
        expect(fs.existsSync(f.path)).toBe(false);
    });
    it("recovers an old pending append after migration without duplicate lines or changing the old TXT", async () => {
        let fail = false;
        const f = fixture({ writeFileSync: (path: string, bytes: any, options: any) => {
            if (fail && options?.flag === "a") throw Error("disk");
            fs.writeFileSync(path, bytes, options);
        } });
        await f.make().save(report([1]));
        fail = true; await expect(f.make().save(report([2]))).rejects.toThrow(ERROR);
        fs.renameSync(f.path, f.old);
        const before = fs.readFileSync(f.old);
        fail = false;
        expect(JSON.parse((await f.make().load()).state).deliveryCursor).toBe(2);
        await f.make().save(report([2]));
        expect(fs.readFileSync(f.old).equals(before)).toBe(true);
        expect(fs.readFileSync(f.path, "utf8").match(/"seq":2,/g)).toHaveLength(1);
    });
    it("reconciles an old counter only with complete same-session evidence; pending allocation is not loss", async () => {
        const f = fixture(); await f.make().save(report([1, 2, 3], { deliveryLost: 5 }));
        expect(JSON.parse((await f.make().load()).state)).toMatchObject({ deliveryLost: 0, deliveryCursor: 3, deliveryVerifiedThrough: 3 });
        await f.make().save(report([5], { sequence: 10, deliveryLost: 5 }));
        const saved = JSON.parse((await f.make().load()).state);
        expect(saved).toMatchObject({ deliveryLost: 5, deliveryCursor: 5, sequence: 10 });
        expect(saved.deliveryVerifiedThrough).toBeUndefined();
    });
    it("does not scan oversized historical logs to reconcile a counter", async () => {
        const f = fixture(); await f.make().save(report([1], { deliveryLost: 5 }));
        const archive = join(f.root, "main.1.log"); fs.writeFileSync(archive, Buffer.alloc(4 * 1024 * 1024 + 1));
        const reads: string[] = [];
        const storage = api.createDiagnosticFileStorage({ root: f.root, fs: { ...fs,
            readFileSync: (path: string) => { reads.push(path); return fs.readFileSync(path); } } });
        expect(JSON.parse((await storage.load()).state).deliveryLost).toBe(5);
        expect(reads).not.toContain(archive);
    });
    it("BD opens only its owned directory and rejects a changed cached profile or unavailable shell", async () => {
        const f = fixture(); let root = f.root;
        const openPath = vi.fn(async (_path: string) => "");
        const shell = { openPath };
        const bridge = sourceModule("betterdiscord/native/diagnosticStorage.ts", {
            fs: bridgeFS(), path: { join }, electron: { shell },
            "./paths": { installationPaths: () => ({ root, origin: "https://canary.discord.com" }) },
            "../../src/vencord/diagnosticFileNative": api,
        });
        await bridge.openDiagnosticStorageFolder("C:/arbitrary");
        expect(openPath).toHaveBeenCalledExactlyOnceWith(join(root, "diagnostics"));
        expect(fs.readdirSync(join(root, "diagnostics"))).toEqual([]);
        root = join(f.root, "new-profile");
        await expect(bridge.openDiagnosticStorageFolder()).rejects.toThrow(ERROR);
        expect(openPath).toHaveBeenCalledOnce();
        root = f.root; openPath.mockRejectedValue(Error("private details"));
        await expect(bridge.openDiagnosticStorageFolder()).rejects.toThrow(ERROR);
    });
});
describe("A25 delivery restoration and ring boundaries", () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
    function disk(local: ReturnType<typeof state> | null, native: ReturnType<typeof state> | null) {
        const save = vi.fn(async (_raw: string) => ({ path: "main.log" }));
        const storage = createDiagnosticPersistence({ localRead: () => local && JSON.stringify(local), localWrite: vi.fn(),
            load: async () => ({ path: "main.log", state: native && JSON.stringify(native) }), save, report: raw => raw });
        return { storage, save };
    }
    it("merges recoverable pending deltas without reviving the newer local opt-out", async () => {
        const h = disk(state([3, 4, 5], { enabled: false, optedOut: true, savedAt: NOW }),
            state([1, 2], { sequence: 5, deliveryCursor: 2, savedAt: NOW - 1 }));
        const restored = JSON.parse((await h.storage.read())!);
        expect(restored).toMatchObject({ enabled: false, optedOut: true, sequence: 5 });
        expect(restored.events.map((e: any) => e.seq)).toEqual([1, 2, 3, 4, 5]);
        h.storage.write(JSON.stringify(restored)); h.storage.finish(); await vi.advanceTimersByTimeAsync(0);
        expect(h.storage.status.deliveryLost).toBe(0);
    });
    it("does not recount historical ring gaps through a confirmed native cursor", async () => {
        const h = disk(null, state([1, 100], { deliveryCursor: 100, deliveryLost: 5 }));
        h.storage.write((await h.storage.read())!);
        h.storage.write(JSON.stringify(state([100, 101])));
        expect(h.storage.status.deliveryLost).toBe(5);
        h.storage.finish(); await vi.advanceTimersByTimeAsync(0);
        expect(h.save.mock.calls.flatMap(([raw]) => JSON.parse(raw).events.map((e: any) => e.seq))).toEqual([101]);
    });
    it("counts genuinely missing pending events once and keeps a visible warning", async () => {
        const h = disk(null, state([1, 2], { sequence: 5, deliveryCursor: 2 }));
        h.storage.write((await h.storage.read())!);
        h.storage.write(JSON.stringify(state([1, 2, 6])));
        h.storage.write(JSON.stringify(state([1, 2, 6, 7])));
        expect(h.storage.status.deliveryLost).toBe(3);
        h.storage.finish(); await vi.advanceTimersByTimeAsync(0);
        expect(JSON.parse(h.save.mock.calls.at(-1)![0]).deliveryLost).toBe(3);
    });
    it.each([0, 5000])("counts a missing first prefix after a trusted native cursor %s", async cursor => {
        const h = disk(null, state([6000, 6001], { deliveryCursor: cursor }));
        const restored = (await h.storage.read())!;
        h.storage.write(restored); h.storage.write(restored);
        expect(h.storage.status.deliveryLost).toBe(5999 - cursor);
        h.storage.finish(); await vi.advanceTimersByTimeAsync(0);
    });
    it("does not count an intentionally cleared prefix, including clear before the first restored flush", async () => {
        const h = disk(null, state([5000], { deliveryCursor: 5000 }));
        await h.storage.read();
        h.storage.write(JSON.stringify(state([6000], { clearGeneration: 1 })));
        h.storage.write(JSON.stringify(state([6000, 6001], { clearGeneration: 1 })));
        expect(h.storage.status.deliveryLost).toBe(0);
        h.storage.finish(); await vi.advanceTimersByTimeAsync(0);
    });
    it("delivers a 5000-event burst across the 2000-event ring without loss", async () => {
        const h = disk(null, null); await h.storage.read();
        for (let n = 100; n <= 5000; n += 100)
            h.storage.write(JSON.stringify(state(Array.from({ length: Math.min(n, 2000) }, (_, i) => Math.max(1, n - 1999) + i))));
        h.storage.finish(); await vi.advanceTimersByTimeAsync(0);
        expect(h.storage.status.deliveryLost).toBe(0);
        expect(h.save.mock.calls.flatMap(([raw]) => JSON.parse(raw).events.map((e: any) => e.seq)))
            .toEqual(Array.from({ length: 5000 }, (_, i) => i + 1));
        expect(vi.getTimerCount()).toBe(0);
    });
});
