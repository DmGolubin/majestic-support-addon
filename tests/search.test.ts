import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importBackup } from "../src/core/importer";
import { search, swapLayout } from "../src/core/search";

const all = importBackup(readFileSync(new URL("./fixtures/config-0.5.1.json", import.meta.url), "utf8")).templates;
const mj = all.filter(t => t.project === "mj");
const titles = (q: string) => search(mj, q).hits.map(h => h.t.title);

describe("search", () => {
    it("empty query returns everything at level 0", () => {
        const r = search(mj, "  ");
        expect(r.hits).toHaveLength(mj.length);
        expect(r.hits.every(h => h.level === 0)).toBe(true);
    });
    it("title words → level 4", () => {
        const r = search(mj, "соедин");
        const conn = r.hits.find(h => h.t.title === "Проблемы с соединением / Server not responding");
        expect(conn?.level).toBe(4);
    });
    it("aliases → level 3 (снр, фпс)", () => {
        const r = search(mj, "снр");
        expect(r.hits.some(h => h.level === 3 && /Server not responding/.test(h.t.title))).toBe(true);
        expect(titles("фпс").some(t => /Фризит игру/.test(t))).toBe(true);
    });
    it("body match → level 2 with best line", () => {
        const r = search(mj, "kaspersky");
        const h = r.hits.find(x => x.level === 2)!;
        expect(h).toBeTruthy();
        expect(h.line!.toLowerCase()).toContain("kaspersky");
    });
    it("fuzzy single word when nothing strict", () => {
        const r = search(mj, "соеднение");
        expect(r.fuzzy).toBe(true);
        expect(r.hits[0].level).toBe(1);
    });
    it("wrong keyboard layout", () => {
        expect(swapLayout("cjtl")).toBe("соед");
        const r = search(mj, "cjtl");
        expect(r.layout).toBe("соед");
        expect(r.hits.length).toBeGreaterThan(0);
    });
    it("exact command → level 5", () => {
        const t = { ...mj[0], command: "nv" };
        expect(search([t], "nv").hits[0].level).toBe(5);
    });
});
