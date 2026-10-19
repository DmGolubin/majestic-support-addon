import { describe, expect, it } from "vitest";
import { importBackup, parseRaw } from "../src/core/importer";
import { LEGACY_KEY, Store, STORE_KEY } from "../src/core/state";

// Compatibility fixtures verified against the pure parseTemplates/tkey methods in
// reference/bd-0.5.1/SupportTemplates.plugin.js. The archived plugin is not a test/runtime dependency.
const rows = [
    { group: "Majestic RP", title: "", name: "Fallback title", text: "Title body" },
    { group: "Majestic RP", title: "Fallback body", text: "", content: "Content body" },
    { group: 0, title: "Common", text: "Common body" },
];
const raw = JSON.stringify(rows);
const keys = ["Majestic RP||Fallback title", "Majestic RP||Fallback body", "||Common"];
const ids = keys.map(key => "local:" + key);
const expected = [
    { id: ids[0], title: "Fallback title", text: "Title body", project: "mj" },
    { id: ids[1], title: "Fallback body", text: "Content body", project: "mj" },
    { id: ids[2], title: "Common", text: "Common body", project: null },
];
const backup = (pinned: unknown = keys) => ({
    app: "SupportTemplates", version: 2, raw, pinned,
    usage: { [keys[0]]: { n: 3, last: 123 }, [keys[2]]: { n: 4, last: 124 } },
    binds: { [keys[0]]: "Ctrl+Alt+KeyF", [keys[2]]: "F8" },
});

describe("Q18 historical JSON compatibility", () => {
    it("retains legacy fallback names/content and the key for a falsy group", () => {
        expect(parseRaw(raw)).toMatchObject(expected);
    });
    it.each(["array", "object"])("imports 0.5.1 %s pins, usage and binds without orphaning fallback records", format => {
        const result = importBackup(JSON.stringify(backup(format === "array" ? keys : Object.fromEntries(keys.map(key => [key, true])))));
        expect(result.templates).toMatchObject(expected);
        expect(result.favorites).toEqual(ids);
        expect(result.usage).toEqual({ [ids[0]]: { n: 3, last: 123 }, [ids[2]]: { n: 4, last: 124 } });
        expect(result.binds).toEqual({ [ids[0]]: "Ctrl+Alt+KeyF", [ids[2]]: "F8" });
        expect(result.droppedBinds).toBe(0);
    });
    it.each(["legacy", "v2"])("restores the same accepted raw records from %s storage", async format => {
        const data = new Map<string, unknown>();
        const storage = {
            get: async (key: string) => structuredClone(data.get(key)),
            set: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
        };
        data.set(format === "legacy" ? LEGACY_KEY : STORE_KEY,
            format === "legacy" ? backup() : { ...new Store(storage).data, raw, favorites: ids,
                usage: { [ids[0]]: { n: 3, last: 123 } }, binds: { [ids[0]]: "Ctrl+Alt+KeyF" } });
        const store = new Store(storage); await store.load(); await store.flush();
        expect(store.templates).toMatchObject(expected);
        expect(store.data.favorites).toEqual(ids);
        expect(store.data.usage[ids[0]]).toEqual({ n: 3, last: 123 });
        expect(store.bindFor(ids[0])).toBe("Ctrl+Alt+KeyF");
    });
    it("prefers nonempty primary fields and retains explicit string zero values", () => {
        expect(parseRaw(JSON.stringify([{ group: "0", title: "0", name: "Unused", text: "0", content: "Unused" }])))
            .toMatchObject([{ id: "local:0||0", title: "0", text: "0" }]);
    });
});
