import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticBackup } from "../src/core/diagnosticBackup";
import { createDiagnosticPersistence } from "../src/core/diagnosticPersistence";
import { beginInteraction, waitForInteractionIdle } from "../src/core/interactionIdle";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const state = (sequence: number, optedOut = false) => JSON.stringify({ schema: 1, continuous: true,
    enabled: !optedOut, optedOut, sessionId: "a".repeat(32), clearGeneration: 0, sequence,
    savedAt: Date.now(), events: [] });
const deferred = <T>() => {
    let resolve!: (v: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
function fixture(beforeWrite = async () => {}) {
    let disk: unknown;
    const read = vi.fn(async () => disk), write = vi.fn(async (v: string) => { disk = v; });
    const backup = createDiagnosticBackup({ read, write, beforeWrite });
    return { backup, read, write, disk: () => disk };
}
describe("coalesced host diagnostic backup", () => {
    it("writes one bounded latest state for a burst and leaves no idle polling", async () => {
        const h = fixture(); await h.backup.read();
        for (let n = 1; n <= 1000; n++) h.backup.write(state(n));
        const latest = state(1000);
        expect(h.write).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(4999); expect(h.write).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.write).toHaveBeenCalledExactlyOnceWith(latest);
        expect(vi.getTimerCount()).toBe(0);
        h.backup.write("x".repeat(512 * 1024 + 1));
        expect(h.backup.failed).toBe(true);
        await vi.advanceTimersByTimeAsync(10000);
        expect(h.write).toHaveBeenCalledOnce();
    });
    it("selects the newest opt-out after the interaction gate, including finish", async () => {
        const gate = deferred<void>(), h = fixture(() => gate.promise);
        h.backup.write(state(1)); h.backup.finish();
        for (let n = 2; n <= 100; n++) h.backup.write(state(n));
        const off = state(101, true); h.backup.write(off, true);
        await vi.advanceTimersByTimeAsync(20000);
        expect(h.write).not.toHaveBeenCalled();
        expect(await h.backup.read()).toBe(off);
        gate.resolve(); await vi.advanceTimersByTimeAsync(0);
        expect(h.write).toHaveBeenCalledExactlyOnceWith(off);
    });
    it("serializes a slow old write before newer opt-out/clear and never overwrites it on restart", async () => {
        const h = fixture(), slow = deferred<void>();
        h.write.mockImplementationOnce(async () => slow.promise);
        h.backup.write(state(1), true); await vi.advanceTimersByTimeAsync(0);
        const off = state(2, true); h.backup.write(off, true); h.backup.finish();
        expect(await h.backup.read()).toBe(off);
        expect(h.write).toHaveBeenCalledOnce();
        slow.resolve(); await vi.advanceTimersByTimeAsync(0);
        expect(h.write.mock.calls.map(c => c[0])).toEqual([state(1), off]);
        expect(h.disk()).toBe(off); expect(h.backup.failed).toBe(false);
    });
    it("retains the newer state after rejection and clears errors only after confirmed retry", async () => {
        const h = fixture(), slow = deferred<void>();
        h.write.mockImplementationOnce(() => slow.promise);
        h.backup.write(state(1), true); await vi.advanceTimersByTimeAsync(0);
        const off = state(2, true); h.backup.write(off, true);
        slow.reject(Error("host unavailable")); await vi.advanceTimersByTimeAsync(0);
        expect(h.backup.failed).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        const confirmation = deferred<void>();
        h.write.mockImplementationOnce(() => confirmation.promise);
        h.backup.retry(); await vi.advanceTimersByTimeAsync(0);
        expect(h.write).toHaveBeenLastCalledWith(off);
        expect(h.backup.failed).toBe(true);
        confirmation.resolve(); await vi.advanceTimersByTimeAsync(0);
        expect(h.backup.failed).toBe(false);
    });
    it("retains latest pending opt-out when beforeWrite rejects before consuming a snapshot", async () => {
        const gate = vi.fn().mockRejectedValueOnce(Error("gate failed")).mockResolvedValue(undefined);
        const h = fixture(gate), off = state(2, true);
        h.backup.write(state(1)); h.backup.write(off, true);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.write).not.toHaveBeenCalled(); expect(h.backup.failed).toBe(true);
        expect(await h.backup.read()).toBe(off);
        h.backup.retry(); await vi.advanceTimersByTimeAsync(0);
        expect(h.write).toHaveBeenCalledExactlyOnceWith(off);
        expect(h.backup.failed).toBe(false);
    });
    it("does not let an old successful write hide a newer oversized-input failure", async () => {
        const h = fixture(), slow = deferred<void>();
        h.write.mockImplementationOnce(() => slow.promise);
        h.backup.write(state(1), true); await vi.advanceTimersByTimeAsync(0);
        h.backup.write("x".repeat(512 * 1024 + 1));
        slow.resolve(); await vi.advanceTimersByTimeAsync(0);
        expect(h.backup.failed).toBe(true);
        h.backup.write(state(2), true); await vi.advanceTimersByTimeAsync(0);
        expect(h.backup.failed).toBe(false);
    });
    it("bounds a hung read, ignores late completion and recovers on a real successful read", async () => {
        const h = fixture(), hung = deferred<unknown>();
        h.read.mockImplementationOnce(() => hung.promise);
        const loading = h.backup.read(); await vi.advanceTimersByTimeAsync(1500);
        expect(await loading).toBeNull(); expect(h.backup.failed).toBe(true);
        hung.resolve(state(1, true)); await vi.advanceTimersByTimeAsync(0);
        expect(h.backup.failed).toBe(true);
        h.read.mockResolvedValueOnce(state(2, true));
        expect(await h.backup.read()).toBe(state(2, true));
        expect(h.backup.failed).toBe(false);
    });
    it.each(["broken", JSON.stringify({ schema: 1, events: [] }), "x".repeat(512 * 1024 + 1)])("reports invalid host backup instead of pretending it is empty (%#)", async value => {
        const h = fixture(); h.read.mockResolvedValueOnce(value);
        expect(await h.backup.read()).toBeNull(); expect(h.backup.failed).toBe(true);
    });
    it("merges an asynchronous same-millisecond opt-out ahead of the old native opt-in", async () => {
        const h = fixture(), on = state(1), off = state(2, true);
        h.read.mockResolvedValueOnce(off);
        const disk = createDiagnosticPersistence({ backup: h.backup,
            load: async () => ({ path: "main.log", state: on }), save: async () => ({ path: "main.log" }), report: v => v });
        expect(JSON.parse((await disk.read())!).optedOut).toBe(true);
        expect(disk.status.localError).toBe(false);
    });
    it("uses the real shared gesture gate and does not invoke the synchronous host body during drag", async () => {
        const release = beginInteraction();
        const h = fixture(waitForInteractionIdle);
        try {
            h.backup.write(state(1)); h.backup.finish();
            await vi.advanceTimersByTimeAsync(6000);
            h.backup.write(state(2, true), true);
            expect(h.write).not.toHaveBeenCalled();
        } finally { release(); }
        await vi.advanceTimersByTimeAsync(149);
        expect(h.write).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(20);
        expect(h.write).toHaveBeenCalledOnce();
        expect(JSON.parse(h.write.mock.calls[0][0]).optedOut).toBe(true);
    });
});
