import { afterEach, describe, expect, it, vi } from "vitest";
import { importBackup } from "../src/core/importer";
import { favoritesOf, recentOf } from "../src/core/rank";
import { Store, STORE_KEY } from "../src/core/state";

const RAW = "## Majestic\n### A\nAnswer A\n### B\nAnswer B";
const A = "local:Majestic||A", B = "local:Majestic||B";
const defaults = () => new Store({ get: async () => undefined, set: async () => {} }).data;
function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());

describe("Q18 core saved-state recovery", () => {
    it("serializes automatic repair with later writes and includes repair in flush", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const initial = { ...defaults(), raw: RAW, prefix: "/" };
        let disk: unknown = initial;
        const entered = gate(), release = gate();
        let writes = 0;
        const storage = {
            get: async (key: string) => key === STORE_KEY ? structuredClone(disk) : undefined,
            set: async (key: string, value: unknown) => {
                if (key !== STORE_KEY) return;
                const snapshot = structuredClone(value);
                if (++writes === 1) { entered.resolve(); await release.promise; }
                disk = snapshot;
            },
        };
        const store = new Store(storage);
        await store.load();
        await entered.promise;
        let flushed = false;
        const flush = store.flush().then(() => { flushed = true; });
        await Promise.resolve(); await Promise.resolve();
        const escapedRepair = flushed;
        store.setPrefix("!");
        // Give an incorrectly unqueued later write a chance to finish before the repair.
        for (let i = 0; i < 6; i++) await Promise.resolve();
        release.resolve();
        await flush; await store.flush();
        expect.soft(escapedRepair).toBe(false);
        const reloaded = new Store(storage); await reloaded.load();
        expect(reloaded.data.prefix).toBe("!");
        expect(reloaded.templates.map(t => t.id)).toEqual([A, B]);
    });

    it.each(["n", "last"] as const)("does not let an uncoercible %s field block a whole local library", async field => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const saved = { ...defaults(), raw: RAW, prefix: "!", favorites: [A], usage: {
            [A]: { n: 3, last: 12, [field]: { toString: null, valueOf: null } },
            [B]: { n: 4, last: 15 },
        } };
        const store = new Store({ get: async () => saved, set: async () => {} });
        await store.load();
        expect(store.loadError).toBe(false);
        expect(store.templates.map(t => t.id)).toEqual([A, B]);
        expect(store.data.prefix).toBe("!");
        expect(store.data.favorites).toEqual([A]);
        expect(store.data.usage[B]).toEqual({ n: 4, last: 15 });
        if (field === "n") expect(store.data.usage[A]).toBeUndefined();
        else expect(store.data.usage[A]).toEqual({ n: 3, last: 0 });
        await store.flush();
    });

    it("does not restore nonfinite usage", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const store = new Store({ get: async () => ({ ...defaults(), raw: RAW,
            usage: { [A]: { n: "1e999", last: 0 }, [B]: { n: 2, last: "1e999" } },
        }), set: async () => {} });
        await store.load();
        expect(store.data.usage[A]).toBeUndefined();
        expect(store.data.usage[B]).toEqual({ n: 2, last: 0 });
        await store.flush();
    });
    it("restores each favorite/recent row once, preserving first occurrence order", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const store = new Store({ get: async () => ({ ...defaults(), raw: RAW,
            favorites: [A, A, B], recent: [B, B, A], intentional: [A, A],
        }), set: async () => {} });
        await store.load();
        expect(favoritesOf(store.templates, store.ctx()).map(t => t.id)).toEqual([A, B]);
        expect(recentOf(store.templates, store.ctx(), 20).map(t => t.id)).toEqual([B, A]);
        await store.flush();
    });
});

describe("Q18 core legacy usage import", () => {
    it.each(["n", "last"] as const)("isolates invalid %s while preserving templates and valid usage", field => {
        const result = importBackup(JSON.stringify({ raw: RAW, usage: {
            "Majestic||A": { n: 3, last: 12, [field]: { toString: null } },
            "Majestic||B": { n: "4", last: "15" },
        } }));
        expect(result.templates).toHaveLength(2);
        expect(result.usage[B]).toEqual({ n: 4, last: 15 });
        if (field === "n") expect(result.usage[A]).toBeUndefined();
        else expect(result.usage[A]).toEqual({ n: 3, last: 0 });
    });
    it("rejects nonfinite counts and replaces nonfinite timestamps with zero", () => {
        const result = importBackup(JSON.stringify({ raw: RAW, usage: {
            "Majestic||A": { n: "1e999", last: 0 }, "Majestic||B": { n: 2, last: "1e999" },
        } }));
        expect(result.usage).toEqual({ [B]: { n: 2, last: 0 } });
    });
});
