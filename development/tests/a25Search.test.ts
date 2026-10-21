import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { importBackup } from "../src/core/importer";
import { orderHits } from "../src/core/rank";
import { search } from "../src/core/search";
import { Template } from "../src/core/types";

const make = (id: string, title: string, text = "", extra: Partial<Template> = {}): Template => ({
    id, title, text, source: "faq", project: "mj", category: null, status: "actual", statusNote: null,
    teamUses: 0, command: null, color: null, updatedAt: null, ...extra,
});
const ids = (pool: Template[], q: string) => search(pool, q).hits.map(h => h.t.id);

describe("A25 bounded smart search", () => {
    it.each([
        ["акаунт", "Аккаунт"], ["аккааунт", "Аккаунт"], ["аккаутн", "Аккаунт"],
        ["соеденение", "Соединение"], ["соеднение", "Соединение"],
        ["переустанвока", "Переустановка"], ["подкючение", "Подключение"],
        ["серевр", "Сервер"], ["падключенее", "Подключение"],
        ["conection", "Connection"], ["connetcion", "Connection"],
    ])("finds %s as %s with insertion/deletion/substitution/transposition", (query, title) => {
        const t = make("match", title), result = search([t], query);
        expect(result.fuzzy).toBe(true); expect(result.hits.map(h => h.t.id)).toEqual(["match"]);
    });
    it("handles a typo in a typed title prefix without allowing arbitrary body prefixes", () => {
        const title = make("title", "Не удаётся подключиться");
        const body = make("body", "Инструкция", "Не удаётся подключиться");
        expect(ids([body, title], "подклю")).toEqual(["title", "body"]);
        expect(ids([body, title], "падклю")).toEqual(["title"]);
    });
    it.each(["кто", "дон", "бан", "ад", "ы", "13", "1234", "v123"])(
        "does not fuzz short queries or identifiers: %s", query => {
            expect(search([make("x", "Кот дом бак да 1243 v124")], query).hits).toEqual([]);
        });
    it("rejects distant edits and cross-word subsequences", () => {
        expect(ids([make("x", "А---к---к---а---у---н---т")], "аккаунт")).toEqual([]);
        expect(ids([make("x", "подробное описание на другом сервере")], "подкючение")).toEqual([]);
        expect(ids([make("x", "подключение")], "падклучиня")).toEqual([]);
        expect(ids([make("x", "Ошибочка")], "ошибка")).toEqual([]); // Two edits are too broad for six letters.
    });
    it("searches body-only content and returns the relevant original line", () => {
        const t = make("body", "Порядок действий", "Первый шаг\nПроверьте соединение с сервером.\nЗавершение");
        expect(search([t], "соединение").hits).toEqual([{ t, level: 2, line: "Проверьте соединение с сервером." }]);
        const fuzzy = search([t], "соеденение");
        expect(fuzzy.fuzzy).toBe(true);
        expect(fuzzy.hits[0]).toEqual({ t, level: 0.5, line: "Проверьте соединение с сервером." });
    });
    it("requires every word across title/body and supports two bounded errors across a multiword query", () => {
        const t = make("match", "Восстановление аккаунта", "Проверьте соединение\nПерезапустите лаунчер");
        expect(ids([t], "аккаунта лаунчер")).toEqual(["match"]);
        expect(search([t], "акаунта лаунчре")).toMatchObject({ fuzzy: true, hits: [{ t }] });
        expect(ids([t], "акаунта отсутствует")).toEqual([]);
        expect(ids([t], "аккаунта на")).toEqual([]); // Short body fragments are not anchors.
        expect(ids([make("x", "сервер аккаунт форум")], "серевр акаунт фоурм")).toEqual([]); // Three edits exceed query budget.
    });
    it("preserves aliases, ё normalization and wrong-layout correction including typo fallback", () => {
        const t = make("conn", "Проблемы с соединением / Server not responding");
        expect(search([t], "снр").hits[0].level).toBe(3);
        expect(search([t], "cjtl").layout).toBe("соед");
        expect(search([make("x", "Сервер")], "cthtdh")).toMatchObject({ fuzzy: true, layout: "серевр", hits: [{ t: { id: "x" } }] });
        expect(search([make("x", "Чёрный экран")], "черный экран").fuzzy).toBe(false);
        expect(ids([t], "сервер not")).toEqual(["conn"]); // Russian alias + English title.
    });
    it("tries exact corrected layout before accidental Latin typo matches", () => {
        const pool = [make("latin", "cjtq"), make("ru", "Соединение")];
        expect(search(pool, "cjtl")).toMatchObject({ fuzzy: false, layout: "соед", hits: [{ t: { id: "ru" } }] });
    });
    it("orders command/exact title/title prefix/title/alias/mixed/body, preserving stable ties", () => {
        const pool = [
            make("body", "Ответ", "соединение"), make("mixed", "Сеть соединение", "проверка"),
            make("title", "Проблема: соединение"), make("prefix", "Соединение с сервером"),
            make("exact-a", "Соединение"), make("exact-b", "Соединение"), make("command", "Команда", "", { command: "соединение" }),
        ];
        const expected = ["command", "exact-a", "exact-b", "prefix", "mixed", "title", "body"];
        expect(ids(pool, "соединение")).toEqual(expected);
        expect(orderHits(search(pool, "соединение").hits, { favorites: ["body"], recent: [], usage: { body: { n: 100, last: 1 } } })
            .map(h => h.t.id)).toEqual(expected);
        expect(ids(pool, "соединение проверка")).toEqual(["mixed"]);
        const before = pool.map(t => t.id);
        for (let i = 0; i < 5; i++) expect(ids(pool, "соединение")).toEqual(expected);
        expect(pool.map(t => t.id)).toEqual(before);
    });
    it("keeps exact results exclusive and puts fuzzy title before fuzzy body", () => {
        const title = make("title", "Соединение"), body = make("body", "Инструкция", "Соединение");
        expect(ids([body, title], "соеденение")).toEqual(["title", "body"]);
        const exact = make("exact", "Текст", "соеденение");
        expect(search([body, title, exact], "соеденение")).toMatchObject({ fuzzy: false, hits: [{ t: exact, level: 2 }] });
    });
    it("does not search placeholder names, and never reuses fields from another template object", () => {
        const old = make("same", "Старый", "{{секретныйпараметр}} Текст");
        expect(ids([old], "секретныйпараметр")).toEqual([]);
        expect(ids([old], "новый")).toEqual([]);
        expect(ids([{ ...old, title: "Новый" }], "новый")).toEqual(["same"]);
    });
    it("keeps Unicode exact search without treating fragments of non-RU/EN words as typo candidates", () => {
        const t = make("x", "café 中文插件", "𠮷alpha café");
        expect(ids([t], "café")).toEqual(["x"]);
        expect(ids([t], "中文")).toEqual(["x"]);
        expect(ids([t], "caff")).toEqual([]);
        expect(ids([t], "alhpa")).toEqual([]);
    });
    it("bounds fuzzy token count and long words without weakening exact content lookup", () => {
        const t = make("x", "а".repeat(100), "один два три четыре пять шесть семь восемь девять");
        expect(ids([t], "а".repeat(90))).toEqual(["x"]);
        expect(ids([t], "а".repeat(90) + "б")).toEqual([]);
        expect(ids([t], "один два три четыре пять шесть семь восемь девать")).toEqual([]);
        expect(ids([t], "один два три четыре пять шесть семь восемь девять")).toEqual(["x"]);
    });
});

describe("A25 large catalog benchmark", () => {
    it("measures cold indexing and warm exact/fuzzy/mixed/no-hit searches over 1000 × 20000-character bodies", () => {
        const imported = importBackup(readFileSync(new URL("./fixtures/config-0.5.1.json", import.meta.url), "utf8")).templates;
        const ordinaryPool = Array.from({ length: 100 }, (_, i) => ({ ...imported[i % imported.length], id: `ordinary:${i}` }));
        const ordinaryQueries = ["соединение", "соеденение", "kaspersky", "акаунт", "несуществующееслово", "cjtl"];
        const ordinaryCold = performance.now();
        for (const query of ordinaryQueries) search(ordinaryPool, query);
        const ordinaryColdMs = performance.now() - ordinaryCold, ordinaryWarm: number[] = [];
        for (let repeat = 0; repeat < 5; repeat++) for (const query of ordinaryQueries) {
            const began = performance.now(); search(ordinaryPool, query);
            ordinaryWarm.push(performance.now() - began);
        }
        ordinaryWarm.sort((a, b) => a - b);
        process.stdout.write("A25_SEARCH_ORDINARY " + JSON.stringify({ templates: ordinaryPool.length,
            averageBodyChars: Math.round(ordinaryPool.reduce((n, t) => n + t.text.length, 0) / ordinaryPool.length),
            coldSixQueriesMs: ordinaryColdMs, warmP95Ms: ordinaryWarm[Math.floor(ordinaryWarm.length * .95)],
            warmMaxMs: ordinaryWarm.at(-1) }) + "\n");
        const pool = Array.from({ length: 1000 }, (_, i) => {
            const seed = imported[i % imported.length];
            const body = (seed.text + "\n").repeat(Math.ceil(20000 / (seed.text.length + 1)));
            return { ...seed, id: `bench:${i}`, text: (`Карточка ${i}\n` + body).slice(0, 20000) };
        });
        const queries = ["соединение", "соеденение", "аккаунт", "акаунт", "kaspersky", "лаунчер файлы", "подкючение ошибка", "несуществующееслово", "cjtl"];
        const mem = process.memoryUsage(), start = performance.now();
        const coldQueries: { query: string; ms: number; }[] = [];
        const baseline = queries.map(q => {
            const began = performance.now(), result = search(pool, q).hits.map(h => [h.t.id, h.level]);
            coldQueries.push({ query: q, ms: performance.now() - began });
            return result;
        });
        const coldMs = performance.now() - start, samples: number[] = [];
        let peakHeap = process.memoryUsage().heapUsed;
        for (let i = 0; i < 5; i++) {
            for (let j = 0; j < queries.length; j++) {
                const began = performance.now(), result = search(pool, queries[j]);
                samples.push(performance.now() - began);
                expect(result.hits.map(h => [h.t.id, h.level])).toEqual(baseline[j]);
                peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
            }
        }
        samples.sort((a, b) => a - b);
        process.stdout.write("A25_SEARCH_BENCH " + JSON.stringify({ templates: pool.length, bodyChars: 20000,
            distinctBodies: new Set(pool.map(t => t.text)).size, coldNineQueriesMs: coldMs,
            coldMaxMs: Math.max(...coldQueries.map(q => q.ms)), coldQueries, warmQueries: samples.length, warmP50Ms: samples[Math.floor(samples.length / 2)],
            warmP95Ms: samples[Math.floor(samples.length * .95)], warmMaxMs: samples.at(-1),
            peakHeapDeltaMiB: (peakHeap - mem.heapUsed) / 1048576 }) + "\n");
    }, 30000);
});
