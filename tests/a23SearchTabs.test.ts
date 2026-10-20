import { describe, expect, it, vi } from "vitest";
import { createPanelPreferencesStorage } from "../src/core/panelPreferences";
import { orderHits, RankCtx, windowTabPool } from "../src/core/rank";
import { search } from "../src/core/search";
import { sanitize, Store, STORE_KEY } from "../src/core/state";
import { moveWindowTab, readWindowTabOrder, Template, WINDOW_TABS } from "../src/core/types";

const template = (id: string, extra: Partial<Template> = {}): Template => ({
    id, project: "mj", title: "Ошибка входа", text: "Ответ", category: null, status: "actual", statusNote: null,
    teamUses: 0, command: null, color: null, updatedAt: null, source: "faq", ...extra,
});
const memory = () => {
    const values = new Map<string, unknown>();
    return { values, get: async (key: string) => values.get(key),
        set: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }) };
};
const ctx: RankCtx = { favorites: ["personal:panel:2", "faq:majestic:1"], recent: ["personal:panel:2", "faq:majestic:1"], usage: {} };
const pool = [template("faq:majestic:1"), template("personal:panel:2", { source: "personal" }), template("faq:majestic:3")];
const ids = (items: Template[]) => items.map(t => t.id);

describe("A23 search and tabs", () => {
    it("filters personal source, retaining personal favorites/recent and never widening a scoped pool", () => {
        expect(ids(windowTabPool(pool, "all", ctx, false))).toEqual(["faq:majestic:1", "faq:majestic:3"]);
        expect(windowTabPool(pool, "all", ctx, true)).toEqual(pool);
        expect(ids(windowTabPool(pool, "personal", ctx, false))).toEqual(["personal:panel:2"]);
        for (const tab of ["fav", "recent"] as const) {
            expect(ids(windowTabPool(pool, tab, ctx, false))).toEqual(ctx.favorites);
            expect(windowTabPool([], tab, ctx, true)).toEqual([]);
        }
        expect(windowTabPool([], "personal", ctx, true)).toEqual([]);
        expect(ctx.favorites).toEqual(["personal:panel:2", "faq:majestic:1"]);
    });

    it("groups ranked search results stably without changing relevance, favorite, usage and tie order within either group", () => {
        const items = [
            template("p-body", { source: "personal", title: "Другое", text: "Ошибка входа" }),
            template("p-title", { source: "personal" }), template("g-body", { title: "Другое", text: "Ошибка входа" }),
            template("g-title"), template("g-used"), template("p-fav", { source: "personal" }), template("g-tie"),
        ];
        const ranking = { favorites: ["p-fav"], recent: [], usage: { "g-used": { n: 5, last: 1 } } };
        const hits = search(items, "ошибка").hits;
        const original = [...hits];
        const relevance = orderHits(hits, ranking);
        const grouped = orderHits(hits, ranking, true);
        expect(grouped.map(h => h.t.id)).toEqual(["g-used", "g-title", "g-tie", "g-body", "p-fav", "p-title", "p-body"]);
        for (const personal of [false, true]) {
            expect(grouped.filter(h => (h.t.source === "personal") === personal))
                .toEqual(relevance.filter(h => (h.t.source === "personal") === personal));
        }
        expect(orderHits(hits, ranking, false)).toEqual(relevance);
        expect(hits).toEqual(original);
    });

    it("tab scope applies before fuzzy search fallback and recent stays limited to ten", () => {
        const data = [template("faq:majestic:1", { title: "Ошибка" }),
            template("personal:panel:2", { source: "personal", title: "Ошибочка" })];
        expect(search(windowTabPool(data, "personal", ctx, false), "ошибка").hits.map(h => h.t.id)).toEqual(["personal:panel:2"]);
        const many = Array.from({ length: 15 }, (_, i) => template(String(i)));
        expect(ids(windowTabPool(many, "recent", { ...ctx, recent: ids(many).reverse() }, false))).toEqual(ids(many).reverse().slice(0, 10));
    });

    it("repairs unknown/duplicate tabs and moves in both directions without losing a tab", () => {
        expect(readWindowTabOrder(["recent", "unknown", "recent", "fav"])).toEqual(["recent", "fav", "all", "personal"]);
        expect(readWindowTabOrder(null)).toEqual(WINDOW_TABS);
        expect(moveWindowTab(WINDOW_TABS, "all", "recent")).toEqual(["personal", "fav", "recent", "all"]);
        expect(moveWindowTab(WINDOW_TABS, "recent", "all")).toEqual(["recent", "all", "personal", "fav"]);
        expect(moveWindowTab(WINDOW_TABS, "fav", "fav")).toEqual(WINDOW_TABS);
        const evil: unknown[] = [];
        Object.defineProperty(evil, "0", { get() { throw new Error("accessor"); } });
        expect(readWindowTabOrder(evil)).toEqual(WINDOW_TABS);
    });

    it("migrates missing fields and repairs corrupt values independently", () => {
        const { data, fixed } = sanitize({ showPersonalInAll: "true", generalFirstInSearch: 0, windowTabOrder: ["fav", "fav", "bad"] }, []);
        expect(data).toMatchObject({ showPersonalInAll: false, generalFirstInSearch: true, windowTabOrder: ["fav", "all", "personal", "recent"] });
        expect(fixed).toEqual(expect.arrayContaining(["showPersonalInAll", "generalFirstInSearch", "windowTabOrder"]));
        expect(sanitize({}, []).fixed).toEqual([]);
    });

    it("persists options and reorder through the normal local store", async () => {
        const storage = memory(), store = new Store(storage);
        await store.load();
        store.setShowPersonalInAll(true); store.setGeneralFirstInSearch(false);
        store.setWindowTabOrder(["recent", "all", "fav", "personal"]);
        await store.flush();
        const restored = new Store(storage); await restored.load();
        expect(restored.data).toMatchObject({ showPersonalInAll: true, generalFirstInSearch: false, windowTabOrder: ["recent", "all", "fav", "personal"] });
    });

    it("persists per account, survives catalog refresh, resets defaults, and blocks writes after logout", async () => {
        const storage = memory();
        const accountA = createPanelPreferencesStorage(storage, "123456789012345678");
        const accountB = createPanelPreferencesStorage(storage, "223456789012345678");
        const a = new Store(accountA, true);
        a.restorePanelPreferences(await accountA.get(STORE_KEY));
        a.setShowPersonalInAll(true); a.setGeneralFirstInSearch(false); a.setWindowTabOrder(["fav", "recent", "personal", "all"]);
        await a.flush();
        const restored = new Store(accountA, true);
        restored.restorePanelPreferences(await accountA.get(STORE_KEY));
        restored.replacePanelCatalog({ templates: pool, personal: [], folders: [] });
        expect(restored.data).toMatchObject({ showPersonalInAll: true, generalFirstInSearch: false, windowTabOrder: ["fav", "recent", "personal", "all"] });
        const b = new Store(accountB, true);
        b.restorePanelPreferences(await accountB.get(STORE_KEY));
        expect(b.data).toMatchObject({ showPersonalInAll: false, generalFirstInSearch: true, windowTabOrder: WINDOW_TABS });
        restored.setShowPersonalInAll(false); restored.setGeneralFirstInSearch(true); restored.setWindowTabOrder(WINDOW_TABS);
        await restored.flush();
        const fresh = new Store(accountA, true);
        fresh.restorePanelPreferences(await accountA.get(STORE_KEY));
        expect(fresh.data).toMatchObject({ showPersonalInAll: false, generalFirstInSearch: true, windowTabOrder: WINDOW_TABS });
        const writes = storage.set.mock.calls.length;
        restored.closePanelPreferences(); restored.setShowPersonalInAll(true); await restored.flush();
        expect(storage.set).toHaveBeenCalledTimes(writes);
    });
});
