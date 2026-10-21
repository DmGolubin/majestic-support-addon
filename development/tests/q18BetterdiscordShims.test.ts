import { describe, expect, it, vi } from "vitest";
import { loadAdapter } from "./betterdiscordHarness";

describe("Q18 BetterDiscord clipboard completion contract", () => {
    it("returns a promise to the debug report caller after native copy succeeds", async () => {
        const native = vi.fn();
        const browser = vi.fn();
        const { copyToClipboard } = loadAdapter("shims/clipboard.ts", { electron: { clipboard: { writeText: native } } },
            { navigator: { clipboard: { writeText: browser } } });
        const copied = vi.fn();
        await copyToClipboard("diagnostic fixture").then(copied);
        expect(native).toHaveBeenCalledExactlyOnceWith("diagnostic fixture");
        expect(copied).toHaveBeenCalledOnce();
        expect(browser).not.toHaveBeenCalled();
    });

    it("waits for the browser fallback before reporting success", async () => {
        let complete!: () => void;
        const browser = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
        const { copyToClipboard } = loadAdapter("shims/clipboard.ts", { electron: {} },
            { navigator: { clipboard: { writeText: browser } } });
        const copied = vi.fn();
        const copying = copyToClipboard("diagnostic fixture").then(copied);
        await Promise.resolve();
        expect(copied).not.toHaveBeenCalled();
        complete(); await copying;
        expect(copied).toHaveBeenCalledOnce();
    });

    it("rejects the caller's promise when both clipboard routes are unavailable", async () => {
        const { copyToClipboard } = loadAdapter("shims/clipboard.ts", { electron: {} },
            { navigator: { clipboard: { writeText: () => Promise.reject(new Error("clipboard denied")) } } });
        await expect(copyToClipboard("diagnostic fixture")).rejects.toThrow("clipboard denied");
    });
});

function storeFixture() {
    const effects: (() => (() => void))[] = [];
    const render = vi.fn();
    const { useStateFromStores } = loadAdapter("shims/common.ts", {}, { BdApi: { React: {
        useState: () => [0, render], useRef: (current: unknown) => ({ current }),
        useEffect: (effect: () => (() => void)) => effects.push(effect)
    } } });
    const listeners = new Set<() => void>();
    const store = { addChangeListener: vi.fn((fn: () => void) => { listeners.add(fn); }),
        removeChangeListener: vi.fn((fn: () => void) => { listeners.delete(fn); }) };
    const mount = () => { useStateFromStores([store], () => "channel"); return effects.shift()!(); };
    return { store, listeners, render, mount };
}

describe("Q18 BetterDiscord Flux hook ownership", () => {
    it("releases a listener registered before addChangeListener throws", () => {
        const f = storeFixture();
        f.store.addChangeListener.mockImplementationOnce(fn => { f.listeners.add(fn); throw Error("host registration failure"); });
        const unmount = f.mount();
        expect(f.listeners.size).toBe(1);
        unmount();
        expect(f.listeners.size).toBe(0);
        const stop = f.mount(); expect(f.listeners.size).toBe(1); stop();
        expect(f.listeners.size).toBe(0);
    });

    it("retries a transient removal failure and fences a retired callback", () => {
        const f = storeFixture(), unmount = f.mount();
        const callback = [...f.listeners][0];
        f.store.removeChangeListener.mockImplementationOnce(() => { throw Error("host removal failure"); });
        unmount();
        expect(f.listeners.size).toBe(0);
        f.render.mockClear(); callback();
        expect(f.render).not.toHaveBeenCalled();
    });
});
