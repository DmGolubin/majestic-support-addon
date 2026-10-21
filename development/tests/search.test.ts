import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importBackup } from "../src/core/importer";
import { search, subseqSpan, swapLayout } from "../src/core/search";
import { hard } from "../src/core/text";

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
    it.each(["рздел", "разел", "раздл"])("finds a later compact fuzzy match for %s", q => {
        const title = "Направление в технический раздел форума";
        const r = search(mj, q);
        expect(subseqSpan(q, hard(title))).toBe(6);
        expect(r.fuzzy).toBe(true);
        expect(r.hits.find(h => h.t.title === title)?.level).toBe(1);
    });
    it.each([
        ["стример", "Вопросы по Media"],
        ["стим", "Запускается версия Steam"],
        ["steamapi", "Запускается версия Steam"],
    ])("finds current fixture titles via alias %s", (q, title) => {
        const r = search(mj, q);
        expect(r.fuzzy).toBe(false);
        expect(r.hits.find(h => h.t.title === title)?.level).toBe(3);
    });
    it.each([
        ["стример", "Вопросы по медиа"],
        ["steamapi", "Запускается версия стим"],
    ])("retains legacy title aliases for %s", (q, title) => {
        const t = { ...mj[0], title, text: "" };
        expect(search([t], q).hits).toEqual([{ t, level: 3, line: null }]);
    });
    it("keeps strict body matches ahead of fuzzy fallback", () => {
        const t = { ...mj[0], id: "strict-body", title: "Ответ", text: "рздел" };
        const r = search([...mj, t], "рздел");
        expect(r.fuzzy).toBe(false);
        expect(r.hits).toEqual([{ t, level: 2, line: "рздел" }]);
    });
    it("rejects scattered subsequences and fuzzy short tokens", () => {
        const t = { ...mj[0], title: "a---b---c--d", text: "" };
        expect(search([t], "abcd").hits).toHaveLength(0);
        expect(search([{ ...t, title: "a---b---c---d" }], "abcd").hits).toHaveLength(0);
        expect(search([t], "abc").hits).toHaveLength(0);
        expect(search([t], "ab cd").hits).toHaveLength(0);
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

describe("shortest subsequence span", () => {
    it.each([
        ["abcd", "a----b----c----d abxcd", 5],
        ["aab", "a---aab", 3],
        ["aab", "ab", -1],
        ["aab", "axb", -1],
        ["abcd", "abc", -1],
        ["abcd", "dcba", -1],
        ["a", "ba", 1],
        ["", "abc", -1],
    ])("%s in %s has span %s", (needle, hay, span) => {
        expect(subseqSpan(needle, hay)).toBe(span);
    });
});

describe("search field cache", () => {
    it("repeated searches give identical results", () => {
        const q = ["соедин", "антивирус", "снр", "cjtl"];
        const first = q.map(x => search(mj, x).hits.map(h => [h.t.id, h.level, h.line]));
        const second = q.map(x => search(mj, x).hits.map(h => [h.t.id, h.level, h.line]));
        expect(second).toEqual(first);
    });
    it("a re-imported template (new object) is searched by its own text", () => {
        const t = { ...mj[0], title: "Уникальныйзаголовок", text: "текст" };
        expect(search([mj[0]], "уникальныйзаголовок").hits).toHaveLength(0);
        expect(search([t], "уникальныйзаголовок").hits).toHaveLength(1);
    });
});
