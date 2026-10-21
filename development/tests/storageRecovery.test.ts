import { describe, expect, it, vi } from "vitest";
import { LEGACY_KEY, STORE_KEY, Store } from "../src/core/state";

describe("local storage recovery without overwriting unread data", () => {
    it.each([STORE_KEY, LEGACY_KEY])("blocks writes after %s read failure, then restores saved preferences", async failedKey => {
        let fail = true;
        const original = { ...new Store({ get: async () => undefined, set: async () => {} }).data, prefix: "!" };
        const io = {
            get: vi.fn(async (key: string) => {
                if (fail && key === failedKey) throw new Error("unavailable");
                return key === STORE_KEY && !fail ? structuredClone(original) : undefined;
            }),
            set: vi.fn(async () => {}),
        };
        const store = new Store(io);
        await expect(store.load()).rejects.toThrow("unavailable");
        store.setPrefix("?");
        store.setPreviewOpen(false);
        await store.flush();
        expect(io.set).not.toHaveBeenCalled();
        expect(store.loadError).toBe(true);
        expect(() => store.importText("## Majestic RP\n### New\nOverwrite")).toThrow("восстановите");
        fail = false;
        await store.load();
        expect(store.loadError).toBe(false);
        expect(store.data.prefix).toBe("!");
        expect(io.set).not.toHaveBeenCalled();
        store.setPrefix("?");
        await store.flush();
        expect(io.set).toHaveBeenCalledOnce();
    });

    it("coalesces repeated retries while the original read is pending", async () => {
        let resolve!: (v: unknown) => void;
        const pending = new Promise<unknown>(r => { resolve = r; });
        const get = vi.fn(() => pending), set = vi.fn(async () => {});
        const store = new Store({ get, set });
        const a = store.load(), b = store.load();
        store.setPrefix("!");
        await store.flush();
        expect(set).not.toHaveBeenCalled();
        expect(a).toBe(b);
        resolve({ ...store.data, v: 2, prefix: ";" });
        await a;
        expect(get).toHaveBeenCalledOnce();
        expect(store.data.prefix).toBe(";");
    });
});
