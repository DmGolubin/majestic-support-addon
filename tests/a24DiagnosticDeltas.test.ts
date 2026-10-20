import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticPersistence } from "../src/core/diagnosticPersistence";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const sessionId = "a".repeat(32);
const state = (first: number, last: number, extra = {}) => JSON.stringify({
    schema: 1, continuous: true, enabled: true, optedOut: false, until: 0, savedAt: Date.now(),
    sessionId, sequence: last, clearGeneration: 0,
    events: Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => ({ seq: first + i, time: Date.now(), event: "request.success", data: { status: 200 } })), ...extra,
});
function fixture(save = vi.fn(async (_report: string) => ({ path: "fixture.txt" }))) {
    let local: string | null = null;
    const disk = createDiagnosticPersistence({
        save, load: async () => ({ path: "fixture.txt", state: null }),
        localRead: () => local, localWrite: raw => { local = raw; },
        report: raw => JSON.stringify({ journal: JSON.parse(raw) }),
    });
    return { disk, save, local: () => JSON.parse(local!) };
}
const sequences = (save: ReturnType<typeof vi.fn>) => save.mock.calls.flatMap(([raw]) => JSON.parse(raw).journal.events.map((e: any) => e.seq));
describe("A24 append delivery", () => {
    it("unions intermediate snapshots across ring rollover and drains ordered batches, not just the final snapshot", async () => {
        const h = fixture(); await h.disk.read();
        h.disk.write(state(1, 1000));
        await vi.advanceTimersByTimeAsync(1000);
        for (let n = 1100; n <= 3000; n += 100) h.disk.write(state(Math.max(1, n - 1999), n));
        h.disk.finish(); await vi.advanceTimersByTimeAsync(0);
        expect(sequences(h.save)).toEqual(Array.from({ length: 3000 }, (_, i) => i + 1));
        expect(h.disk.status.deliveryLost).toBe(0); expect(vi.getTimerCount()).toBe(0);
        expect(h.save.mock.calls.every(([raw]) => JSON.parse(raw).journal.events.length <= 100)).toBe(true);
    });
    it("retains all deltas while a write is in flight; clear has a distinct durable generation", async () => {
        let release!: (value: { path: string }) => void;
        const save = vi.fn((_raw: string) => new Promise<{ path: string }>(resolve => { release = resolve; }));
        const h = fixture(save); await h.disk.read();
        h.disk.write(state(1, 100)); await vi.advanceTimersByTimeAsync(1000);
        h.disk.write(state(1, 200)); h.disk.write(state(1, 300));
        expect(save).toHaveBeenCalledTimes(1);
        release({ path: "fixture.txt" }); await vi.advanceTimersByTimeAsync(0);
        release({ path: "fixture.txt" }); await vi.advanceTimersByTimeAsync(0);
        expect(sequences(save)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
        h.disk.write(state(301, 300, { clearGeneration: 1 }));
        release({ path: "fixture.txt" }); await vi.advanceTimersByTimeAsync(0);
        expect(JSON.parse(save.mock.calls.at(-1)![0]).journal).toMatchObject({ clearGeneration: 1, sequence: 300, events: [] });
        release({ path: "fixture.txt" }); await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
    });
    it("retries failed delta batches without forgetting intervening snapshots", async () => {
        const save = vi.fn().mockRejectedValueOnce(Error("full")).mockResolvedValue({ path: "fixture.txt" });
        const h = fixture(save); await h.disk.read(); h.disk.write(state(1, 100));
        await vi.advanceTimersByTimeAsync(1000);
        h.disk.write(state(1, 200)); h.disk.write(state(1, 300));
        expect(vi.getTimerCount()).toBe(0); h.disk.retry(); await vi.advanceTimersByTimeAsync(1000);
        expect(sequences(save).slice(100)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
        expect(h.disk.status.fileError).toBe(false);
    });
    it("bounds an undrainable flood and exposes lost delivery count in state and reports", async () => {
        const h = fixture(); await h.disk.read();
        for (let n = 100; n <= 5000; n += 100) h.disk.write(state(Math.max(1, n - 1999), n));
        expect(h.disk.status.deliveryLost).toBe(3000); expect(h.local().deliveryLost).toBe(3000);
        h.disk.finish(); await vi.advanceTimersByTimeAsync(0);
        expect(sequences(h.save)).toEqual(Array.from({ length: 2000 }, (_, i) => i + 3001));
        expect(JSON.parse(h.save.mock.calls.at(-1)![0]).journal.deliveryLost).toBe(3000);
    });
    it("does not revive opt-out when newer local state and same-millisecond native state disagree", async () => {
        const local = state(1, 0, { enabled: false, optedOut: true });
        const disk = createDiagnosticPersistence({
            localRead: () => local, localWrite: vi.fn(),
            load: async () => ({ path: "fixture.txt", state: state(1, 0) }),
            save: async () => ({ path: "fixture.txt" }), report: raw => raw,
        });
        expect(await disk.read()).toBe(local);
    });
});
