import { describe, expect, it, vi } from "vitest";
import { createPanelPreferencesStorage } from "../src/core/panelPreferences";
import { LEGACY_KEY, Persisted, StorageLike, Store, STORE_KEY } from "../src/core/state";

const A = "123456789012345678";
const B = "223456789012345678";
const FAQ = "faq:majestic:1";
const PERSONAL = "personal:panel:2";
const key = (account = A) => "SupportTemplates_panel_preferences_v1_" + account;
const defaults = () => ({ v: 1, favorites: [], recent: [], usage: {}, binds: {}, prefix: ";", previewOpen: false, techProject: "mj" });
const memory = () => {
    const data = new Map<string, unknown>();
    return {
        data,
        get: vi.fn(async (k: string) => data.get(k)),
        set: vi.fn(async (k: string, value: unknown) => { data.set(k, value); }),
    };
};
const persisted = (fields: Partial<Persisted> = {}): Persisted => ({ ...new Store(memory()).data, ...fields });
const deferred = () => {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

describe("account panel preferences storage", () => {
    it("isolates accounts and underlying stores, without local or legacy reads", async () => {
        const storage = memory();
        storage.data.set(STORE_KEY, persisted({ favorites: [FAQ] }));
        storage.data.set(LEGACY_KEY, { raw: "private legacy text" });
        const a = createPanelPreferencesStorage(storage, A);
        const b = createPanelPreferencesStorage(storage, B);
        expect(await a.get(STORE_KEY)).toBeUndefined();
        await a.set(STORE_KEY, persisted({ favorites: [FAQ] }));
        expect(await b.get(STORE_KEY)).toBeUndefined();
        expect(await createPanelPreferencesStorage(memory(), A).get(STORE_KEY)).toBeUndefined();
        await b.set(STORE_KEY, persisted({ favorites: [PERSONAL] }));
        expect(await createPanelPreferencesStorage(storage, A).get(STORE_KEY)).toMatchObject({ favorites: [FAQ] });
        expect(await b.get(STORE_KEY)).toMatchObject({ favorites: [PERSONAL] });
        expect(storage.get.mock.calls.map(([k]) => k)).toEqual([key(), key(B), key(), key(B)]);
        expect(storage.set.mock.calls.map(([k]) => k)).toEqual([key(), key(B)]);
    });

    it.each(["", "1".repeat(16), "1".repeat(21), "0".repeat(18), "012345678901234567", A + "\n", " " + A, "../" + A, "a".repeat(18), 123, null])(
        "rejects invalid account IDs before IO: %s", account => {
            const storage = memory();
            expect(() => createPanelPreferencesStorage(storage, account as string)).toThrow("account ID");
            expect(storage.get).not.toHaveBeenCalled();
            expect(storage.set).not.toHaveBeenCalled();
        },
    );

    it.each([17, 18, 19, 20])("accepts %i digit account IDs", async length => {
        const storage = memory();
        await createPanelPreferencesStorage(storage, "1".repeat(length)).get(STORE_KEY);
        expect(storage.get).toHaveBeenCalledWith(key("1".repeat(length)));
    });

    it("rejects every key other than STORE_KEY without IO", async () => {
        const storage = memory();
        const adapter = createPanelPreferencesStorage(storage, A);
        for (const invalid of [LEGACY_KEY, STORE_KEY + "_damaged", key(), "", "__proto__"]) {
            await expect(adapter.get(invalid)).rejects.toThrow("key");
            await expect(adapter.set(invalid, persisted())).rejects.toThrow("key");
        }
        expect(storage.get).not.toHaveBeenCalled();
        expect(storage.set).not.toHaveBeenCalled();
    });

    it("writes and reads only the preference projection, retaining unverified catalog references", async () => {
        const storage = memory();
        const adapter = createPanelPreferencesStorage(storage, A);
        const source = persisted({
            favorites: [FAQ, PERSONAL], recent: [PERSONAL], usage: { [FAQ]: { n: 2, last: 100 } },
            binds: { [PERSONAL]: "Ctrl+Alt+KeyQ" }, prefix: "!", previewOpen: true, techProject: "ro",
        });
        for (const field of ["raw", "personal", "folders", "intentional", "guilds", "tokens", "accessToken", "refreshToken", "catalog"]) {
            Object.defineProperty(source, field, { enumerable: true, get() { throw new Error("secret field accessed"); } });
        }
        await adapter.set(STORE_KEY, source);
        const expected = {
            v: 1, favorites: [FAQ, PERSONAL], recent: [PERSONAL], usage: { [FAQ]: { n: 2, last: 100 } },
            binds: { [PERSONAL]: "Ctrl+Alt+KeyQ" }, prefix: "!", previewOpen: true, techProject: "ro",
        };
        expect(storage.data.get(key())).toEqual(expected);
        storage.data.set(key(), { ...expected, raw: "secret", tokens: "secret", catalog: "secret" });
        expect(await adapter.get(STORE_KEY)).toEqual(expected);
        expect(JSON.stringify(await adapter.get(STORE_KEY))).not.toContain("secret");
    });

    it.each([null, false, "broken JSON", [], {}, { v: 2, favorites: [FAQ] }, { v: "1", prefix: "!" }, { v: 99, previewOpen: true }])(
        "defaults corrupt and unknown versions safely: %j", async saved => {
            const storage = memory();
            storage.data.set(key(), saved);
            expect(await createPanelPreferencesStorage(storage, A).get(STORE_KEY)).toEqual(defaults());
            expect(storage.set).not.toHaveBeenCalled();
        },
    );

    it("uses compact defaults and sanitizes fields independently", async () => {
        const storage = memory();
        const adapter = createPanelPreferencesStorage(storage, A);
        await adapter.set(STORE_KEY, { favorites: [FAQ], recent: "bad", usage: [], binds: [], prefix: ";\n", previewOpen: "true", techProject: "other" });
        expect(await adapter.get(STORE_KEY)).toEqual({ ...defaults(), favorites: [FAQ] });
    });

    it("sanitizes corrupted v1 records on read without rewriting or dropping valid references", async () => {
        const storage = memory();
        storage.data.set(key(), {
            v: 1, raw: "secret", personal: [{ text: "secret" }], accessToken: "secret",
            favorites: [FAQ, FAQ, "local:secret", PERSONAL], recent: [PERSONAL, PERSONAL],
            usage: { [FAQ]: { n: Infinity, last: 1 }, [PERSONAL]: { n: 5, last: 12, token: "secret" } },
            binds: { [FAQ]: "F5", [PERSONAL]: "F5", "faq:russia-online:3": "Ctrl+KeyC" },
            prefix: "/", previewOpen: 1, techProject: "ro",
        });
        expect(await createPanelPreferencesStorage(storage, A).get(STORE_KEY)).toEqual({
            ...defaults(), favorites: [FAQ, PERSONAL], recent: [PERSONAL],
            usage: { [PERSONAL]: { n: 5, last: 12 } }, binds: { [FAQ]: "F5" }, techProject: "ro",
        });
        expect(storage.set).not.toHaveBeenCalled();
    });

    it("matches current catalog ID grammar, deduplicates, and rejects local IDs and prototype keys", async () => {
        const storage = memory();
        const adapter = createPanelPreferencesStorage(storage, A);
        const good = [FAQ, PERSONAL, "faq:russia-online:" + "9".repeat(20), "personal:panel:" + "9".repeat(20)];
        const bad = ["faq:opaque", "faq:mj:1", "faq:majestic:0", "faq:majestic:01", "faq:majestic:" + "1".repeat(21),
            "personal:panel:0", "personal:panel:01", "personal:uuid", "local:Majestic RP||A", "folder:panel:1",
            "__proto__", "constructor", "prototype", FAQ + "\n", FAQ + " ", " " + FAQ, null, 12, {}, "faq:" + "a".repeat(500)];
        const all = [...good, ...bad, ...good];
        await adapter.set(STORE_KEY, { favorites: all, recent: all });
        expect(await adapter.get(STORE_KEY)).toEqual({ ...defaults(), favorites: good, recent: good });
    });

    it("bounds arrays, usage maps, bindings and scan sizes", async () => {
        const storage = memory();
        const adapter = createPanelPreferencesStorage(storage, A);
        const ids = Array.from({ length: 10050 }, (_, i) => `faq:majestic:${i + 1}`);
        await adapter.set(STORE_KEY, {
            favorites: ids, recent: [ids[0], ids[0], ...ids],
            usage: Object.fromEntries(ids.map(id => [id, { n: 1, last: 0 }])),
            binds: Object.fromEntries(ids.map((id, i) => [id, `Ctrl+Key${i}`])),
        });
        const saved = await adapter.get(STORE_KEY) as ReturnType<typeof defaults>;
        expect(saved.favorites).toEqual(ids.slice(0, 1000));
        expect(saved.recent).toEqual(ids.slice(0, 20));
        expect(Object.keys(saved.usage)).toEqual(ids.slice(0, 10000));
        expect(Object.keys(saved.binds)).toEqual(ids.slice(0, 1000));
        await adapter.set(STORE_KEY, { favorites: [...Array(10000).fill(null), FAQ] });
        expect(await adapter.get(STORE_KEY)).toEqual(defaults());
    });

    it("rejects unsafe usage numbers without coercion and strips extra nested fields", async () => {
        const storage = memory();
        const adapter = createPanelPreferencesStorage(storage, A);
        const invalid = [NaN, Infinity, -Infinity, -1, 1.5, "12", null, Number.MAX_SAFE_INTEGER + 1];
        const values = [...invalid.map(n => ({ n, last: 10 })), ...invalid.map(last => ({ n: 1, last })),
            { n: 0, last: 1 }, { n: 1_000_000_001, last: 1 }, { n: 1, last: 8_640_000_000_000_001 }, { n: 1 }, null];
        const usage = Object.fromEntries(values.map((u, i) => [`faq:majestic:${i + 10}`, u]));
        usage[FAQ] = { n: 1_000_000_000, last: 8_640_000_000_000_000 };
        Object.assign(usage, { [PERSONAL]: { n: 1, last: 0, token: "secret" } });
        await adapter.set(STORE_KEY, { usage });
        expect(await adapter.get(STORE_KEY)).toEqual({ ...defaults(), usage: {
            [FAQ]: { n: 1_000_000_000, last: 8_640_000_000_000_000 }, [PERSONAL]: { n: 1, last: 0 },
        } });
    });

    it("enforces valid unique canonical binds and bounded strings", async () => {
        const storage = memory();
        const adapter = createPanelPreferencesStorage(storage, A);
        const invalid = ["Ctrl+KeyC", "Ctrl+Alt+KeyT", "Alt+Digit1", "KeyA", "Shift+KeyQ", "Alt+Ctrl+KeyQ", "Ctrl+Ctrl+KeyQ",
            "Ctrl+Escape", "Ctrl+ControlLeft", "Ctrl+KeyQ\n", "Ctrl+" + "A".repeat(100), "", null, {}, 42];
        await adapter.set(STORE_KEY, { binds: {
            [FAQ]: "Ctrl+Alt+KeyQ", [PERSONAL]: "Ctrl+Alt+KeyQ", "faq:russia-online:3": "F5",
            ...Object.fromEntries(invalid.map((combo, i) => [`faq:majestic:${i + 10}`, combo])),
        } });
        expect(await adapter.get(STORE_KEY)).toEqual({ ...defaults(), binds: { [FAQ]: "Ctrl+Alt+KeyQ", "faq:russia-online:3": "F5" } });
    });

    it("ignores inherited fields and accessors, and cannot pollute prototypes", async () => {
        const storage = memory();
        const adapter = createPanelPreferencesStorage(storage, A);
        const poison = JSON.parse('{"__proto__":{"polluted":true},"constructor":"F5","prototype":"F6"}');
        const usage = Object.assign(Object.create({ [FAQ]: { n: 7, last: 8 } }), poison, {
            [PERSONAL]: Object.create({ n: 1, last: 2 }),
        });
        const binds = Object.assign(Object.create({ [FAQ]: "F5" }), poison);
        Object.defineProperty(binds, PERSONAL, { enumerable: true, get() { throw new Error("accessor"); } });
        const source = Object.assign(Object.create({ prefix: "!", previewOpen: true, favorites: [FAQ] }), { usage, binds });
        await adapter.set(STORE_KEY, source);
        expect(await adapter.get(STORE_KEY)).toEqual(defaults());
        expect(Object.prototype).not.toHaveProperty("polluted");
        storage.data.set(key(), Object.create({ v: 1, prefix: "!" }));
        expect(await adapter.get(STORE_KEY)).toEqual(defaults());
    });

    it("returns fresh normalized objects that cannot mutate stored preferences", async () => {
        const storage = memory();
        const adapter = createPanelPreferencesStorage(storage, A);
        await adapter.set(STORE_KEY, persisted({ favorites: [FAQ], usage: { [FAQ]: { n: 1, last: 2 } } }));
        const saved = await adapter.get(STORE_KEY) as Persisted;
        saved.favorites.push(PERSONAL);
        saved.usage[FAQ].n = 999;
        expect(await adapter.get(STORE_KEY)).toMatchObject({ favorites: [FAQ], usage: { [FAQ]: { n: 1, last: 2 } } });
    });

    it("serializes across adapters, captures snapshots at invocation, and makes reopened reads await writes", async () => {
        const storage = memory();
        const gate = deferred();
        const started = deferred();
        storage.set.mockImplementationOnce(async (k, value) => { started.resolve(); await gate.promise; storage.data.set(k, value); });
        const first = createPanelPreferencesStorage(storage, A);
        const second = createPanelPreferencesStorage(storage, A);
        const source = persisted({ favorites: [FAQ], recent: [FAQ], usage: { [FAQ]: { n: 1, last: 2 } }, binds: { [FAQ]: "F5" } });
        const one = first.set(STORE_KEY, source);
        source.favorites.push(PERSONAL);
        const two = second.set(STORE_KEY, source);
        source.favorites.length = 0;
        source.recent.length = 0;
        source.usage[FAQ].n = 999;
        source.binds[FAQ] = "F6";
        const read = createPanelPreferencesStorage(storage, A).get(STORE_KEY);
        await started.promise;
        expect(storage.set).toHaveBeenCalledTimes(1);
        expect(storage.set.mock.calls[0][1]).toMatchObject({ favorites: [FAQ], usage: { [FAQ]: { n: 1 } } });
        expect(storage.get).not.toHaveBeenCalled();
        gate.resolve();
        await Promise.all([one, two]);
        expect(await read).toMatchObject({ favorites: [FAQ, PERSONAL], recent: [FAQ], usage: { [FAQ]: { n: 1, last: 2 } }, binds: { [FAQ]: "F5" } });
        expect(storage.set).toHaveBeenCalledTimes(2);
    });

    it("does not block other accounts or storage objects behind a pending write", async () => {
        const storage = memory();
        const gate = deferred();
        storage.set.mockImplementationOnce(async () => gate.promise);
        const write = createPanelPreferencesStorage(storage, A).set(STORE_KEY, persisted());
        await createPanelPreferencesStorage(storage, B).set(STORE_KEY, persisted({ prefix: "!" }));
        expect(await createPanelPreferencesStorage(storage, B).get(STORE_KEY)).toMatchObject({ prefix: "!" });
        const separate = createPanelPreferencesStorage(memory(), A);
        await separate.set(STORE_KEY, persisted({ prefix: "?" }));
        expect(await separate.get(STORE_KEY)).toMatchObject({ prefix: "?" });
        gate.resolve();
        await write;
    });

    it("propagates a failed pending write to its racing read, then recovers for queued and later operations", async () => {
        const storage = memory();
        const gate = deferred();
        const started = deferred();
        const failure = new Error("disk write failed");
        storage.set.mockImplementationOnce(async () => { started.resolve(); await gate.promise; });
        const adapter = createPanelPreferencesStorage(storage, A);
        const failedWrite = expect(adapter.set(STORE_KEY, persisted())).rejects.toBe(failure);
        const failedRead = expect(createPanelPreferencesStorage(storage, A).get(STORE_KEY)).rejects.toBe(failure);
        const recovery = createPanelPreferencesStorage(storage, A).set(STORE_KEY, persisted({ prefix: "!" }));
        const reopened = createPanelPreferencesStorage(storage, A).get(STORE_KEY);
        await started.promise;
        gate.reject(failure);
        await Promise.all([failedWrite, failedRead, recovery]);
        expect(await reopened).toMatchObject({ prefix: "!" });
        await adapter.set(STORE_KEY, persisted({ prefix: "?" }));
        expect(await adapter.get(STORE_KEY)).toMatchObject({ prefix: "?" });
    });

    it("propagates read errors and synchronous IO throws, without poisoning the next operation", async () => {
        const storage = memory();
        const failure = new Error("IO failure");
        storage.get.mockRejectedValueOnce(failure);
        const adapter = createPanelPreferencesStorage(storage, A);
        await expect(adapter.get(STORE_KEY)).rejects.toBe(failure);
        expect(await adapter.get(STORE_KEY)).toBeUndefined();
        const sync: StorageLike = { get: storage.get, set: vi.fn().mockImplementationOnce(() => { throw failure; }).mockImplementation(storage.set) };
        const syncAdapter = createPanelPreferencesStorage(sync, A);
        await expect(syncAdapter.set(STORE_KEY, persisted())).rejects.toBe(failure);
        expect(await syncAdapter.get(STORE_KEY)).toBeUndefined();
        await syncAdapter.set(STORE_KEY, persisted({ prefix: "!" }));
        expect(await syncAdapter.get(STORE_KEY)).toMatchObject({ prefix: "!" });
    });
});
