import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as buffer from "node:buffer";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ERROR, NOW, payload, sourceModule, storageModule as api } from "./a22DiagnosticStorageHarness";
import { diagnosticData } from "../src/core/diagnosticJournal";

const { diagnosticFileSystem } = sourceModule("betterdiscord/native/diagnosticStorage.ts", {});
const roots: string[] = [];
function temporary() {
    const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "stx-a30-diagnostics-")));
    roots.push(base); return base;
}
afterEach(() => {
    for (const base of roots.splice(0)) {
        if (dirname(resolve(base)) !== fs.realpathSync(tmpdir())
            || !base.split(/[\\/]/).at(-1)?.startsWith("stx-a30-diagnostics-")) throw Error("Unsafe cleanup");
        fs.rmSync(base, { recursive: true, force: true });
    }
});
const SID = "a".repeat(32);
function report(seq: number) {
    return JSON.stringify(payload({ journal: { schema: 1, continuous: true, enabled: true, optedOut: false,
        sessionId: SID, sequence: seq, clearGeneration: 0, savedAt: NOW + seq, dropped: 0, deliveryLost: 0,
        events: [{ seq, time: NOW + seq, event: "request.start", data: { method: "GET", route: "/me" } }] } }));
}

// BD 1.14.3 preload getStats copies native Stats fields and exposes three bound
// methods through contextBridge; renderer lstatSync is an alias of statSync.
// Count both filesystem entry points and returned-method bridge calls.
function bridge() {
    const calls: string[] = [], predicates: string[] = [];
    const host = Object.fromEntries(["existsSync", "statSync", "realpathSync", "mkdirSync", "readFileSync",
        "writeFileSync", "renameSync", "unlinkSync"].map(name => [name, (...args: any[]) => {
        calls.push(name + ":" + String(args[0]) + (args[1]?.bigint === true ? ":bigint" : ""));
        try {
            const result = (fs as any)[name](...args);
            if (name !== "statSync") return result;
            return { ...result, ...Object.fromEntries(["isFile", "isDirectory", "isSymbolicLink"].map(method =>
                [method, () => { predicates.push(method); return result[method](); }])) };
        } catch { throw Error("Bridged filesystem error"); }
    }]));
    host.lstatSync = host.statSync;
    return { host, calls, predicates };
}

describe("A30 BD diagnostic bridge cost", () => {
    it("uses module Buffer and avoids re-parsing unchanged absolute paths on warm appends", async () => {
        const paths = { ...path, resolve: vi.fn(path.resolve), dirname: vi.fn(path.dirname) };
        const module = sourceModule("src/vencord/diagnosticFileNative.ts", {
            crypto, buffer, path: paths, "./core/diagnosticJournal": { diagnosticData }
        }, { Buffer: undefined });
        const root = join(temporary(), "diagnostics"), b = bridge();
        const store = module.createDiagnosticFileStorage({ root, fs: diagnosticFileSystem(b.host) });
        await store.save(report(1));
        paths.resolve.mockClear(); paths.dirname.mockClear(); b.calls.length = 0;
        await store.save(report(2));
        expect(paths.dirname).not.toHaveBeenCalled();
        expect(paths.resolve.mock.calls.length).toBeLessThan(12);
        expect(b.calls.filter(c => c.startsWith("realpathSync:")).length).toBeGreaterThan(100);
        expect(fs.readFileSync(join(root, "main.log"), "utf8")).toContain('"seq":2');
    });

    it("preserves exact bigint stat metadata and computes its predicates locally", () => {
        const info = { mode: 0x41edn, ino: 37999121856422523n, dev: 12n, isDirectory: vi.fn(() => true) };
        const statSync = vi.fn(() => info);
        const adapted = diagnosticFileSystem({ statSync });
        const result = adapted.statSync("fixed", { bigint: true });
        expect(statSync).toHaveBeenCalledWith("fixed", { bigint: true });
        expect(result.ino).toBe(37999121856422523n);
        expect(result.isDirectory()).toBe(true);
        expect(info.isDirectory).not.toHaveBeenCalled();
    });

    it.each(["safe", "bigint"] as const)(
        "preserves the full filesystem call trace and saved bytes while eliminating stat predicate crossings (%s identity)", async identity => {
        const base = temporary();
        const runs: { calls: string[]; predicates: number; bytes: string; times: number[]; }[] = [];
        for (const optimized of [false, true]) {
            const root = join(base, optimized ? "after" : "before", "profile", "BetterDiscord", "identity", "diagnostics");
            const b = bridge();
            // Separate real NTFS directories can randomly fall on opposite sides
            // of MAX_SAFE_INTEGER, selecting different display-path proof branches.
            // Pin only this fixture's root inode; retain all actual filesystem
            // calls, type/link metadata and content, and explicitly test both paths.
            const inode = identity === "safe" ? 1234n : 37999121856422523n;
            const stat = b.host.statSync;
            b.host.statSync = (...args: any[]) => {
                const info = stat(...args);
                return args[0] === root ? { ...info, ino: typeof info.ino === "bigint" ? inode : Number(inode) } : info;
            };
            b.host.lstatSync = b.host.statSync;
            const store = api.createDiagnosticFileStorage({ root,
                fs: optimized ? diagnosticFileSystem(b.host) : b.host, randomId: () => "b".repeat(32) });
            await store.save(report(1));
            const times: number[] = [];
            let calls: string[] = [], predicates = 0;
            for (let seq = 2; seq <= 6; seq++) {
                b.calls.length = b.predicates.length = 0;
                const start = performance.now();
                await store.save(report(seq));
                times.push(performance.now() - start);
                if (seq === 2) {
                    calls = b.calls.map(call => call.replace(join(base, optimized ? "after" : "before"), "<profile>"));
                    predicates = b.predicates.length;
                }
            }
            runs.push({ calls, predicates, times, bytes: fs.readFileSync(join(root, "main.log"), "utf8") });
            expect(JSON.parse((await store.load()).state).deliveryCursor).toBe(6);
        }
        const [before, after] = runs;
        expect(after.calls).toEqual(before.calls);
        expect(before.calls.some(call => call.endsWith(":bigint"))).toBe(identity === "bigint");
        expect(after.bytes).toBe(before.bytes);
        expect(before.predicates).toBeGreaterThan(200);
        expect(after.predicates).toBe(0);
        const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
        console.info("A30 warm diagnostic append: " + JSON.stringify({
            identity,
            filesystemCalls: [before.calls.length, after.calls.length],
            predicateBridgeCalls: [before.predicates, after.predicates],
            totalBridgeCalls: [before.calls.length + before.predicates, after.calls.length],
            localMedianMs: [median(before.times), median(after.times)].map(n => Number(n.toFixed(2))),
            samples: before.times.length,
            note: "Native fs with BD-shaped wrapper; not live Electron contextBridge latency."
        }));
    });

    it.each([0x8000, 0x4000, 0xa000, 0x1000, 0x2000, 0x6000, 0xc000, 0])(
        "decodes file kind %i from each fresh snapshot, preserving ownership/signature metadata", kind => {
            const info = { mode: kind | 0o640, nlink: 2, ino: 42, dev: 3, size: 4, mtimeMs: 5, ctimeMs: 6,
                isFile: vi.fn(), isDirectory: vi.fn(), isSymbolicLink: vi.fn() };
            const host = { statSync: vi.fn(() => info), lstatSync: vi.fn(() => info) };
            const adapted = diagnosticFileSystem(host);
            for (const method of ["statSync", "lstatSync"]) {
                const first = adapted[method]("fixed");
                expect(first).toMatchObject({ nlink: 2, ino: 42, dev: 3, size: 4, mtimeMs: 5, ctimeMs: 6 });
                expect([first.isFile(), first.isDirectory(), first.isSymbolicLink()])
                    .toEqual([kind === 0x8000, kind === 0x4000, kind === 0xa000]);
                info.mode = 0x4000;
                const second = adapted[method]("fixed");
                expect(second.isDirectory()).toBe(true);
                expect(first.isDirectory()).toBe(kind === 0x4000);
                expect(host[method as keyof typeof host]).toHaveBeenCalledTimes(2);
                info.mode = kind | 0o640;
            }
            expect(info.isFile).not.toHaveBeenCalled();
            expect(info.isDirectory).not.toHaveBeenCalled();
            expect(info.isSymbolicLink).not.toHaveBeenCalled();
        });

    it.each([undefined, null, "32768", NaN, Infinity, -1, 1.5, 0x100000000])(
        "keeps host predicates when mode is unavailable or invalid: %s", mode => {
            const info = { mode, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
            const adapted = diagnosticFileSystem({ statSync: () => info });
            expect(adapted.statSync("fixed")).toBe(info);
            expect(adapted.lstatSync).toBeUndefined();
        });

    it("does not mutate host stats, methods or realpath.native", () => {
        const info = Object.freeze({ mode: 0x8000, isFile: () => true });
        const statSync = () => info, native = vi.fn();
        const realpathSync = Object.assign(vi.fn(), { native });
        const host = Object.freeze({ statSync, lstatSync: statSync, realpathSync });
        const adapted = diagnosticFileSystem(host);
        expect(adapted.realpathSync).toBe(realpathSync);
        expect(adapted.realpathSync.native).toBe(native);
        expect(host.statSync).toBe(statSync);
        expect(adapted.statSync("fixed").isFile()).toBe(true);
    });
});

describe("A30 BD diagnostic validation remains fresh", () => {
    it("rejects hard links introduced after a successful warm save", async () => {
        const base = temporary(), root = join(base, "diagnostics"), b = bridge();
        const store = api.createDiagnosticFileStorage({ root, fs: diagnosticFileSystem(b.host) });
        await store.save(report(1));
        const log = join(root, "main.log"), other = join(base, "other");
        fs.linkSync(log, other);
        const previous = fs.readFileSync(other, "utf8");
        await expect(store.save(report(2))).rejects.toThrow(ERROR);
        expect(fs.readFileSync(other, "utf8")).toBe(previous);
    });

    it.each(["before-save", "after-stage"])("rejects a new ancestor junction %s with BD's aliased lstat", async when => {
        const base = temporary(), root = join(base, "diagnostics"), moved = join(base, "moved"), other = join(base, "other");
        fs.mkdirSync(other);
        const b = bridge();
        let staged = false;
        const redirect = () => {
            fs.renameSync(root, moved);
            fs.symlinkSync(other, root, process.platform === "win32" ? "junction" : "dir");
        };
        const write = b.host.writeFileSync;
        b.host.writeFileSync = (...args: any[]) => {
            write(...args);
            if (staged) { staged = false; redirect(); }
        };
        const store = api.createDiagnosticFileStorage({ root, fs: diagnosticFileSystem(b.host) });
        await store.save(report(1));
        if (when === "before-save") redirect();
        else staged = true;
        await expect(store.save(report(2))).rejects.toThrow(ERROR);
        expect(fs.readdirSync(other)).toEqual([]);
        expect(fs.readFileSync(join(moved, "main.log"), "utf8")).not.toContain('"seq":2');
    });

    it("retains genuine lstat and rejects a dangling link", async () => {
        const base = temporary(), root = join(base, "diagnostics"); fs.mkdirSync(root);
        fs.symlinkSync(join(base, "missing"), join(root, "main.log"), process.platform === "win32" ? "junction" : "dir");
        const store = api.createDiagnosticFileStorage({ root, fs: diagnosticFileSystem(fs) });
        await expect(store.save(report(1))).rejects.toThrow(ERROR);
        expect(fs.lstatSync(join(root, "main.log")).isSymbolicLink()).toBe(true);
    });

    it("keeps staged recovery and deduplication after a failed rename", async () => {
        const root = join(temporary(), "diagnostics"), b = bridge();
        let fail = false;
        const rename = b.host.renameSync;
        b.host.renameSync = (...args: any[]) => { if (fail) throw Error("private path"); return rename(...args); };
        const store = api.createDiagnosticFileStorage({ root, fs: diagnosticFileSystem(b.host) });
        await store.save(report(1)); fail = true;
        await expect(store.save(report(2))).rejects.toThrow(ERROR);
        fail = false;
        await store.save(report(2)); await store.save(report(2));
        expect(fs.readFileSync(join(root, "main.log"), "utf8").match(/"seq":2/g)).toHaveLength(1);
        expect(JSON.parse((await store.load()).state).deliveryCursor).toBe(2);
    });
});
