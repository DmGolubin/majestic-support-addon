import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInteractionIdle } from "../src/core/interactionIdle";

describe("pointer interaction persistence scheduling", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("keeps persistence pending throughout a long drag, then releases after the final frame", async () => {
        const gate = createInteractionIdle(), end = gate.beginInteraction();
        let writes = 0;
        const write = gate.waitForInteractionIdle().then(() => { writes++; });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(writes).toBe(0);
        end();
        await vi.advanceTimersByTimeAsync(149);
        expect(writes).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        await write;
        expect(writes).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("a new drag cancels pending idle work and duplicate releases cannot unlock it", async () => {
        const gate = createInteractionIdle(), first = gate.beginInteraction();
        let completed = false;
        const write = gate.waitForInteractionIdle().then(() => { completed = true; });
        first();
        await vi.advanceTimersByTimeAsync(100);
        const second = gate.beginInteraction();
        first();
        await vi.advanceTimersByTimeAsync(1000);
        expect(completed).toBe(false);
        second();
        await vi.advanceTimersByTimeAsync(150);
        await write;
        expect(completed).toBe(true);
    });

    it("waits for every simultaneous gesture and uses a single timer", async () => {
        const gate = createInteractionIdle(), first = gate.beginInteraction(), second = gate.beginInteraction();
        const a = gate.waitForInteractionIdle(), b = gate.waitForInteractionIdle();
        first();
        await vi.advanceTimersByTimeAsync(1000);
        expect(vi.getTimerCount()).toBe(0);
        second();
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(160);
        await Promise.all([a, b]);
    });

    it("lets a new pointer task interrupt two independently queued storage writers", async () => {
        const gate = createInteractionIdle(), end = gate.beginInteraction();
        const writes: string[] = [];
        let endNext = () => {};
        const native = gate.waitForInteractionIdle().then(() => {
            writes.push("native");
            // Simulate the next queued input task after the native sync body.
            setTimeout(() => { endNext = gate.beginInteraction(); }, 0);
        });
        const backup = gate.waitForInteractionIdle().then(() => { writes.push("backup"); });
        end();
        await vi.advanceTimersByTimeAsync(152);
        await native;
        expect(writes).toEqual(["native"]);
        endNext();
        await vi.advanceTimersByTimeAsync(160);
        await backup;
        expect(writes).toEqual(["native", "backup"]);
    });

    it("yields a task between writes so a new pointer event can interrupt a backlog", async () => {
        const gate = createInteractionIdle();
        const writes: number[] = [];
        const one = gate.waitForInteractionIdle().then(() => { writes.push(1); });
        await Promise.resolve();
        expect(writes).toEqual([]);
        await vi.advanceTimersByTimeAsync(0); await one;
        const two = gate.waitForInteractionIdle().then(() => { writes.push(2); });
        const end = gate.beginInteraction();
        await vi.advanceTimersByTimeAsync(1000);
        expect(writes).toEqual([1]);
        end();
        await vi.advanceTimersByTimeAsync(150); await two;
        expect(writes).toEqual([1, 2]);
    });
});
