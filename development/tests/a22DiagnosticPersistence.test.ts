import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticPersistence } from "../src/core/diagnosticPersistence";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const state = (savedAt: number, until = 0) => JSON.stringify({ schema: 1, savedAt, until, events: [] });
function fixture(extra = {}) {
    const options = {
        localRead: vi.fn(() => null as string | null), localWrite: vi.fn(),
        load: vi.fn(async () => ({ path: "profile/diagnostics/SupportTemplates-diagnostics.txt", state: null as string | null })),
        save: vi.fn(async (_report: string) => ({ path: "profile/diagnostics/SupportTemplates-diagnostics.txt" })),
        report: (raw: string) => JSON.stringify({ product: "SupportTemplates", journal: JSON.parse(raw) }),
        ...extra,
    };
    return { options, disk: createDiagnosticPersistence(options) };
}
describe("automatic diagnostic file persistence", () => {
    it("coalesces a request burst into one latest snapshot and remains idle afterwards", async () => {
        const { options, disk } = fixture(); await disk.read();
        for (let i = 0; i < 100; i++) disk.write(state(Date.now(), i));
        expect(options.save).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        expect(options.save).toHaveBeenCalledTimes(1);
        expect(JSON.parse(options.save.mock.calls[0][0]).journal.until).toBe(99);
        expect(disk.status.lastSavedAt).toBe(Date.now()); expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000); expect(options.save).toHaveBeenCalledTimes(1);
    });
    it("serializes slow writes and keeps only the latest pending state on stop", async () => {
        let release!: (value: { path: string }) => void;
        const save = vi.fn((_report: string) => new Promise<{ path: string }>(resolve => { release = resolve; }));
        const { disk } = fixture({ save }); await disk.read(); disk.write(state(Date.now(), 1));
        await vi.advanceTimersByTimeAsync(1000);
        for (let i = 2; i <= 50; i++) disk.write(state(Date.now(), i));
        disk.finish(); expect(save).toHaveBeenCalledTimes(1);
        release({ path: "fixed.txt" }); await vi.advanceTimersByTimeAsync(0);
        expect(save).toHaveBeenCalledTimes(2);
        expect(JSON.parse(save.mock.calls[1][0]).journal.until).toBe(50);
        release({ path: "fixed.txt" }); await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
    });
    it("uses file storage even when localStorage is unavailable", async () => {
        const { disk, options } = fixture({ localRead: () => { throw Error("denied"); }, localWrite: () => { throw Error("denied"); } });
        await disk.read(); expect(disk.status.localError).toBe(true);
        expect(() => disk.write(state(Date.now()))).not.toThrow();
        disk.finish(); await vi.advanceTimersByTimeAsync(0);
        expect(options.save).toHaveBeenCalledOnce(); expect(disk.status.fileError).toBe(false);
    });
    it("does not revive an old file opt-in when local storage contains a newer opt-out", async () => {
        const local = state(Date.now(), 0), file = state(Date.now() - 1000, Date.now() + 10000);
        const { disk } = fixture({ localRead: () => local, load: async () => ({ path: "fixed.txt", state: file }) });
        expect(await disk.read()).toBe(local);
    });
    it("prefers valid newer disk history over stale or broken local history", async () => {
        const file = state(Date.now());
        for (const local of ["broken", state(Date.now() - 1000)]) {
            const { disk } = fixture({ localRead: () => local, load: async () => ({ path: "fixed.txt", state: file }) });
            expect(await disk.read()).toBe(file);
        }
    });
    it("honors a same-millisecond local opt-out when its disk write failed", async () => {
        const local = state(Date.now(), 0);
        const { disk } = fixture({ localRead: () => local, load: async () => ({ path: "fixed.txt", state: state(Date.now(), Date.now() + 10000) }) });
        expect(await disk.read()).toBe(local);
    });
    it("bounds startup wait and ignores a late native read", async () => {
        let release!: (value: { path: string; state: string }) => void;
        const local = state(Date.now());
        const { disk } = fixture({ localRead: () => local, load: () => new Promise(resolve => { release = resolve; }) });
        const reading = disk.read(); await vi.advanceTimersByTimeAsync(1500);
        expect(await reading).toBe(local); expect(disk.status.fileError).toBe(true);
        release({ path: "late.txt", state: state(Date.now()) }); await vi.advanceTimersByTimeAsync(0);
        expect(disk.status.path).toBe(""); expect(vi.getTimerCount()).toBe(0);
    });
    it("backs off disk failure without retry timers or flooding; manual retry saves latest state", async () => {
        const save = vi.fn().mockRejectedValueOnce(Error("disk full")).mockResolvedValue({ path: "fixed.txt" });
        const { disk } = fixture({ save }); await disk.read(); disk.write(state(Date.now(), 1));
        await vi.advanceTimersByTimeAsync(1000); expect(disk.status.fileError).toBe(true);
        for (let i = 2; i <= 100; i++) disk.write(state(Date.now(), i));
        expect(vi.getTimerCount()).toBe(0); expect(save).toHaveBeenCalledTimes(1);
        disk.retry(); await vi.advanceTimersByTimeAsync(1000);
        expect(save).toHaveBeenCalledTimes(2);
        expect(JSON.parse(save.mock.calls[1][0]).journal.until).toBe(100);
        expect(disk.status.fileError).toBe(false); expect(vi.getTimerCount()).toBe(0);
    });
});
