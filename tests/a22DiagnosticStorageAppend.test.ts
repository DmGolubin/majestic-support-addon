import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeFS, ERROR, NOW, payload, storageModule as api } from "./a22DiagnosticStorageHarness";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) {
        if (!resolve(root).startsWith(fs.realpathSync(tmpdir()) + sep) || !root.includes("stx-a22-append-")) throw Error("Unsafe cleanup");
        fs.rmSync(root, { recursive: true, force: true });
    }
});
function fixture(bridged = false, overrides: Record<string, unknown> = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "stx-a22-append-"))); roots.push(root);
    const hostFS = bridged ? bridgeFS(overrides) : { ...fs, ...overrides };
    return { root, path: join(root, api.DIAGNOSTIC_FILE_NAME), state: join(root, api.DIAGNOSTIC_STATE_NAME),
        legacy: join(root, api.DIAGNOSTIC_LEGACY_NAME),
        archive: (n: number) => join(root, `SupportTemplates-diagnostics.${n}.txt`),
        make: () => api.createDiagnosticFileStorage({ root, fs: hostFS }) };
}
const SID = "a".repeat(32);
function current(seqs: number[] = [1], patch: Record<string, unknown> = {}) {
    const p = payload();
    return { ...p, journal: { schema: 1, continuous: true, enabled: true, optedOut: false,
        campaign: null, campaignUntil: 0, until: 0, sessionId: SID, sequence: Math.max(0, ...seqs),
        clearGeneration: 0, savedAt: NOW, dropped: 0, deliveryLost: 0,
        events: seqs.map(seq => ({ seq, time: NOW + seq, event: "request.start",
            data: { method: "GET", route: "/me", status: 200 } })), ...patch } };
}
const encode = (seqs?: number[], patch?: Record<string, unknown>) => JSON.stringify(current(seqs, patch));
function lines(path: string) {
    return fs.readFileSync(path, "utf8").trim().split("\n").map(line => {
        expect(line).toMatch(/^\[\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}\] /);
        return { event: line.slice(line.indexOf("] ") + 2, line.indexOf(" {")), ...JSON.parse(line.slice(line.indexOf("{"))) };
    });
}
function fill(path: string, size: number) {
    const line = fs.readFileSync(path, "utf8").split("\n")[0] + "\n";
    const count = Math.floor(size / Buffer.byteLength(line));
    fs.writeFileSync(path, line.repeat(count));
}

describe("A22 append/control state contract", () => {
    it.each([false, true])("preserves byte prefix and dedupes deltas across restart, bridge=%s", async bridged => {
        const f = fixture(bridged), store = f.make();
        await store.save(encode([1, 2], { sequence: 100 }));
        const prefix = fs.readFileSync(f.path);
        await store.save(encode([2, 3], { sequence: 100 }));
        await f.make().save(encode([1, 2, 3, 4], { sequence: 100 }));
        expect(fs.readFileSync(f.path).subarray(0, prefix.length).equals(prefix)).toBe(true);
        const events = lines(f.path).filter(e => e.seq);
        expect(events.map(e => e.seq)).toEqual([1, 2, 3, 4]);
        expect(events[0].timeUtc).toBe(new Date(NOW + 1).toISOString());
        const state = JSON.parse(fs.readFileSync(f.state, "utf8"));
        expect(state.cursors[SID]).toBe(4);
        expect(state.report.journal.sequence).toBe(100);
        expect(state.report.journal.events.map((e: any) => e.seq)).toEqual([1, 2, 3, 4]);
        const restored = JSON.parse((await f.make().load()).state);
        expect(restored.sequence).toBe(100);
        expect(restored.deliveryLost).toBe(96);
    });
    it("serializes duplicate saves from multiple store instances", async () => {
        const f = fixture();
        await Promise.all(Array.from({ length: 12 }, () => f.make().save(encode())));
        expect(lines(f.path).filter(e => e.seq)).toHaveLength(1);
    });
    it("emits safe gap markers only on deliveryLost increases", async () => {
        const f = fixture(), store = f.make();
        await store.save(encode([1], { deliveryLost: 4 }));
        await store.save(encode([2], { deliveryLost: 4 }));
        await store.save(encode([3], { deliveryLost: 7 }));
        expect(lines(f.path).filter(e => e.event === "recorder.gap").map(e => e.deliveryLost)).toEqual([4, 7]);
    });
    it("migrates .29 bytes as a legacy archive, resumes continuous state and never repeats old deltas", async () => {
        const f = fixture(), old = JSON.stringify(payload(), null, 2);
        fs.writeFileSync(f.path, old);
        expect(JSON.parse((await f.make().load()).state).campaign).toBe("mvp-file-2026-10");
        await f.make().save(encode());
        expect(fs.readFileSync(f.legacy, "utf8")).toBe(old);
        expect(lines(f.path).filter(e => e.seq)).toHaveLength(1);
        await f.make().save(encode());
        expect(lines(f.path).filter(e => e.seq)).toHaveLength(1);
        expect(JSON.parse((await f.make().load()).state)).toMatchObject({ continuous: true, enabled: true, until: 0 });
    });
    it("clearGeneration deletes archives and prior state while off; empty deltas and stale saves cannot clear", async () => {
        const f = fixture(), store = f.make();
        fs.writeFileSync(f.path, JSON.stringify(payload()));
        await store.save(encode());
        fs.writeFileSync(f.archive(1), fs.readFileSync(f.path));
        const before = fs.readFileSync(f.path);
        await store.save(encode([], { sequence: 1 }));
        expect(fs.readFileSync(f.path).equals(before)).toBe(true);
        const off = current([], { sequence: 1, clearGeneration: 1, savedAt: NOW + 1, enabled: false, optedOut: true });
        off.recording = false;
        await store.save(JSON.stringify(off));
        expect(fs.readdirSync(f.root).sort()).toEqual([api.DIAGNOSTIC_STATE_NAME, api.DIAGNOSTIC_FILE_NAME].sort());
        expect(lines(f.path).some(e => e.seq)).toBe(false);
        const clean = fs.readFileSync(f.path);
        await f.make().save(encode([1]));
        expect(fs.readFileSync(f.path).equals(clean)).toBe(true);
        expect(JSON.parse((await f.make().load()).state)).toMatchObject({ enabled: false, optedOut: true, clearGeneration: 1, events: [], deliveryLost: 0 });
    });
    it("reconstructs actual appended cursor from plaintext after corrupt sidecar", async () => {
        const f = fixture();
        await f.make().save(encode([1, 2]));
        fs.writeFileSync(f.state, "{corrupt");
        expect(JSON.parse((await f.make().load()).state).optedOut).toBe(true);
        await f.make().save(encode([1, 2, 3]));
        expect(lines(f.path).filter(e => e.seq).map(e => e.seq)).toEqual([1, 2, 3]);
    });
    it("reconstructs clearGeneration without mistaking an existing generation for a new clear", async () => {
        const f = fixture();
        await f.make().save(encode([10], { clearGeneration: 1 }));
        const before = fs.readFileSync(f.path);
        fs.writeFileSync(f.state, "{corrupt");
        await f.make().save(encode([10, 11], { clearGeneration: 1 }));
        expect(fs.readFileSync(f.path).subarray(0, before.length).equals(before)).toBe(true);
        expect(lines(f.path).filter(e => e.seq).map(e => e.seq)).toEqual([10, 11]);
    });
    it("fails closed on oversized/nonparseable active data; explicit clear repairs owned regular file", async () => {
        const f = fixture();
        fs.writeFileSync(f.path, Buffer.alloc(api.DIAGNOSTIC_FILE_MAX_BYTES + 1, 120));
        expect(JSON.parse((await f.make().load()).state)).toMatchObject({ enabled: false, optedOut: true, until: 0 });
        await expect(f.make().save(encode())).rejects.toThrow(ERROR);
        await f.make().save(encode([], { clearGeneration: 1, enabled: false, optedOut: true }));
        expect(fs.statSync(f.path).size).toBeLessThan(5000);
    });
    it.each(["partial", "afterAppend", "commit"])("recovers %s failure without repeating bytes, including new process", async stage => {
        let armed = false, failed = false;
        const f = fixture(false, {
            writeFileSync: (path: string, data: any, options: any) => {
                if (armed && !failed && options.flag === "a" && stage !== "commit") {
                    failed = true;
                    fs.writeFileSync(path, stage === "partial" ? Buffer.from(data).subarray(0, 53) : data, options);
                    throw Error("secret-path");
                }
                fs.writeFileSync(path, data, options);
            },
            renameSync: (from: string, to: string) => {
                if (armed && !failed && stage === "commit" && JSON.parse(fs.readFileSync(from, "utf8")).schema === 2) {
                    failed = true; throw Error("secret-path");
                }
                fs.renameSync(from, to);
            }
        });
        const store = f.make();
        await store.save(encode());
        const prefix = fs.readFileSync(f.path);
        armed = true;
        await expect(store.save(encode([2]))).rejects.toThrow(ERROR);
        await f.make().save(encode([2]));
        expect(fs.readFileSync(f.path).subarray(0, prefix.length).equals(prefix)).toBe(true);
        expect(lines(f.path).filter(e => e.seq).map(e => e.seq)).toEqual([1, 2]);
        expect(JSON.parse(fs.readFileSync(f.state, "utf8")).schema).toBe(2);
    });
    it("refuses an altered pending UTC value and raw secret payload during recovery", async () => {
        let armed = false;
        const f = fixture(false, { writeFileSync: (path: string, data: any, options: any) => {
            if (armed && options.flag === "a") throw Error("disk");
            fs.writeFileSync(path, data, options);
        } });
        await f.make().save(encode()); armed = true;
        await expect(f.make().save(encode([2]))).rejects.toThrow(ERROR);
        const pending = JSON.parse(fs.readFileSync(f.state, "utf8"));
        pending.text = pending.text.replace(/"timeUtc":"[^"]+"/, '"timeUtc":"private-secret"');
        fs.writeFileSync(f.state, JSON.stringify(pending)); armed = false;
        await expect(f.make().save(encode([2]))).rejects.toThrow(ERROR);
        expect(fs.readFileSync(f.path, "utf8")).not.toContain("private-secret");
    });
    it("does not cache away hardlink checks or accept sidecar/archive hardlinks on clear", async () => {
        const f = fixture(), store = f.make();
        await store.save(encode());
        const alias = join(f.root, "other");
        fs.linkSync(f.path, alias);
        await expect(store.save(encode([2]))).rejects.toThrow(ERROR);
        fs.unlinkSync(alias);
        fs.linkSync(f.state, f.archive(1));
        await expect(store.save(encode([], { clearGeneration: 1 }))).rejects.toThrow(ERROR);
    });
});

describe("A22 bounded rotation and steady-state I/O", () => {
    it("rotates only at 10MiB; nine archive slots including legacy bound total text to 100MiB", async () => {
        const f = fixture();
        fs.writeFileSync(f.path, JSON.stringify(payload()));
        const store = f.make();
        await store.save(encode());
        for (let rotation = 1; rotation <= 10; rotation++) {
            fill(f.path, api.DIAGNOSTIC_FILE_MAX_BYTES);
            const original = fs.readFileSync(f.path);
            // Enough appended text to cross the remaining fraction of a line.
            await store.save(encode([rotation * 10 + 1, rotation * 10 + 2, rotation * 10 + 3]));
            expect(fs.readFileSync(f.archive((rotation - 1) % 9 + 1)).equals(original)).toBe(true);
            expect(fs.existsSync(f.legacy)).toBe(rotation < 9);
            const logs = fs.readdirSync(f.root).filter(p => p.endsWith(".txt"));
            expect(logs.length).toBeLessThanOrEqual(10);
            expect(logs.reduce((n, name) => n + fs.statSync(join(f.root, name)).size, 0)).toBeLessThanOrEqual(100 * 1024 * 1024);
            const before = fs.readFileSync(f.path);
            await store.save(encode([]));
            expect(fs.readFileSync(f.path).equals(before)).toBe(true);
        }
    }, 30000);
    it("recovery with all nine archives selects oldest modification time, not slot one", async () => {
        const f = fixture(); await f.make().save(encode());
        const sample = fs.readFileSync(f.path);
        for (let slot = 1; slot <= 9; slot++) {
            fs.writeFileSync(f.archive(slot), sample);
            fs.utimesSync(f.archive(slot), new Date(NOW + slot * 10000), new Date(NOW + slot * 10000));
        }
        fs.utimesSync(f.archive(6), new Date(NOW - 10000), new Date(NOW - 10000));
        fill(f.path, api.DIAGNOSTIC_FILE_MAX_BYTES);
        const original = fs.readFileSync(f.path);
        fs.writeFileSync(f.state, "{corrupt");
        await f.make().save(encode([2, 3, 4]));
        expect(fs.readFileSync(f.archive(6)).equals(original)).toBe(true);
        expect(fs.readFileSync(f.archive(1)).equals(sample)).toBe(true);
    }, 30000);
    it("measures 100 near-10MiB appends and avoids full-log I/O on cached appends/state-only flushes", async () => {
        let activeReadBytes = 0, activeWrites = 0, stateWriteBytes = 0;
        const f = fixture(false, {
            readFileSync: (path: string) => {
                const data = fs.readFileSync(path);
                if (path.endsWith(api.DIAGNOSTIC_FILE_NAME)) activeReadBytes += data.length;
                return data;
            },
            writeFileSync: (path: string, data: any, options: any) => {
                if (path.endsWith(api.DIAGNOSTIC_FILE_NAME)) {
                    activeWrites++;
                    expect(["a", "wx"]).toContain(options.flag);
                } else stateWriteBytes += Buffer.byteLength(data);
                fs.writeFileSync(path, data, options);
            }
        });
        const store = f.make();
        const seed = current(Array.from({ length: 2000 }, (_, i) => i + 1));
        for (const e of seed.journal.events) Object.assign(e.data, { durationMs: 100, retryAfterMs: 100,
            requestId: 100, attempt: 1, count: 100, elapsedMs: 100, templates: 100 });
        await store.save(JSON.stringify(seed));
        fill(f.path, api.DIAGNOSTIC_FILE_MAX_BYTES - 128 * 1024);
        await store.save(encode([] , { sequence: 2000 })); // validate external fixture once
        const prefixSize = fs.statSync(f.path).size;
        const restartReportBytes = Buffer.byteLength(JSON.stringify(JSON.parse(fs.readFileSync(f.state, "utf8")).report));
        activeReadBytes = 0; activeWrites = 0; stateWriteBytes = 0;
        const mem = process.memoryUsage(), samples: number[] = [];
        let lastBeat = performance.now(), maxHeartbeatDelay = 0, beats = 0;
        const timer = setInterval(() => {
            const now = performance.now();
            maxHeartbeatDelay = Math.max(maxHeartbeatDelay, now - lastBeat - 10);
            lastBeat = now; beats++;
        }, 10);
        let peakHeap = mem.heapUsed, peakRss = mem.rss;
        try {
            for (let i = 1; i <= 100; i++) {
                const start = performance.now();
                await store.save(encode([2000 + i]));
                samples.push(performance.now() - start);
                const usage = process.memoryUsage();
                peakHeap = Math.max(peakHeap, usage.heapUsed); peakRss = Math.max(peakRss, usage.rss);
                await new Promise<void>(resolve => setImmediate(resolve));
            }
        } finally { clearInterval(timer); }
        expect(activeReadBytes).toBe(0);
        expect(activeWrites).toBe(100);
        const written = activeWrites;
        for (let i = 0; i < 10; i++) await store.save(encode([], { sequence: 2100, savedAt: NOW + i }));
        expect(activeReadBytes).toBe(0); expect(activeWrites).toBe(written);
        samples.sort((a, b) => a - b);
        process.stdout.write("A22_BENCH " + JSON.stringify({ fixtureBytes: prefixSize, appends: 100, eventsPerAppend: 1,
            restoredEvents: 2000, restartReportBytes, activeReadBytes, stateWriteBytes, p50Ms: samples[49], p95Ms: samples[94],
            maxMs: samples[99], totalMs: samples.reduce((a, b) => a + b, 0), heartbeatBeats: beats, maxHeartbeatDelayMs: maxHeartbeatDelay,
            peakHeapDeltaMiB: (peakHeap - mem.heapUsed) / 1048576, peakRssDeltaMiB: (peakRss - mem.rss) / 1048576 }) + "\n");
    }, 30000);
});
