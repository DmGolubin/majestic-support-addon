import { describe, expect, it } from "vitest";
import { favoritesOf, orderHits, sections } from "../src/core/rank";
import { Template } from "../src/core/types";

const T = (id: string, extra: Partial<Template> = {}): Template => ({
    id, project: "mj", title: id, text: id, category: null, status: "actual", statusNote: null,
    teamUses: 0, command: null, updatedAt: null, source: "local", ...extra,
});
const pool = ["a", "b", "c", "d", "e", "f", "g", "h"].map(id => T(id));

describe("rank", () => {
    it("favorites keep their own order and skip missing", () => {
        expect(favoritesOf(pool, { favorites: ["c", "zz", "a"], recent: [], usage: {} }).map(t => t.id)).toEqual(["c", "a"]);
    });
    it("sections: favorites, recent (max 5, no favorites), then rest by popularity", () => {
        const s = sections(pool, { favorites: ["c"], recent: ["c", "b", "d", "e", "f", "g", "h"], usage: { a: { n: 9, last: 1 } } });
        expect(s.map(x => x.key)).toEqual(["fav", "recent", "cat:"]);
        expect(s[0].items.map(t => t.id)).toEqual(["c"]);
        expect(s[1].items.map(t => t.id)).toEqual(["b", "d", "e", "f", "g"]);
        expect(s[2].items.map(t => t.id)).toEqual(["a", "h"]);
        expect(s[2].title).toBe("Все шаблоны");
    });
    it("sections group by category in first-seen order", () => {
        const p = [T("x", { category: "Навигация" }), T("y", { category: "Частые проблемы" }), T("z", { category: "Навигация" })];
        expect(sections(p, { favorites: [], recent: [], usage: {} }).map(s => s.title)).toEqual(["Навигация", "Частые проблемы"]);
    });
    it("orderHits: level first, then favorite, then usage", () => {
        const hits = [
            { t: T("a"), level: 2, line: null },
            { t: T("b"), level: 4, line: null },
            { t: T("c"), level: 4, line: null },
        ];
        const r = orderHits(hits, { favorites: ["c"], recent: [], usage: { b: { n: 50, last: 0 } } });
        expect(r.map(h => h.t.id)).toEqual(["c", "b", "a"]);
    });
});
