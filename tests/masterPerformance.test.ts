import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";
import { search } from "../src/core/search";
import { categoriesOf, sections } from "../src/core/rank";
import { parseProfile, parseSnapshot } from "../src/core/panelCatalog";
import * as sound from "../src/core/ticketSound";

it("measures bounded synthetic catalog/search workloads without timing assertions", () => {
    const date = "2026-10-18T10:00:00.000Z";
    const profile = parseProfile({ schemaVersion: 1, accountId: "1", connectionId: "12345678-1234-1234-1234-123456789abc", name: "Synthetic", projects: ["majestic"], scopes: ["profile:read", "faq:read", "personal:read", "folders:read"], permissionsRevision: "1", minimumPluginVersion: "1.0.0", serverTime: date });
    for (const count of [100, 1000, 10000]) {
        const wire = { schemaVersion: 1, accountId: "1", revision: "1", permissionsRevision: "1", serverTime: date, projects: ["majestic"], limits: { colors: [] }, colorLabels: {}, personal: [], folders: [], trash: [], faq: Array.from({ length: count }, (_, i) => ({ id: `majestic:${i+1}`, version: "1", title: `Answer ${i}`, text: "ordinary body needle\n".repeat(50), format: "text", projects: ["majestic"], category: `Category ${i}`, tags: [], updatedAt: date })) };
        const start = performance.now();
        const catalog = parseSnapshot(wire, profile, () => { throw Error("unexpected HTML"); });
        const parseMs = performance.now() - start;
        const measure = (fn: () => unknown) => { const t = performance.now(); fn(); return +(performance.now()-t).toFixed(3); };
        const coldMs = measure(() => expect(search(catalog.templates, "missingquery").hits).toHaveLength(0));
        const warmMissMs = measure(() => search(catalog.templates, "missingquery"));
        const bodyMs = measure(() => expect(search(catalog.templates, "needle").hits).toHaveLength(count));
        const categoriesMs = measure(() => expect(categoriesOf(catalog.templates)).toHaveLength(count));
        const sectionsMs = measure(() => sections(catalog.templates, { favorites: [], recent: [], usage: {} }));
        console.log(JSON.stringify({ count, bodyChars: 1050, parseMs: +parseMs.toFixed(3), coldMs, warmMissMs, bodyMs, categoriesMs, sectionsMs }));
    }
}, 15000);

it("100 rapid real sound option calls persist in order without rewriting audio", async () => {
    const code = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/ticketSound.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const calls: { key: string; value: any }[] = [];
    const dependencies: Record<string, unknown> = {
        "@webpack/common": { ChannelStore: {}, SelectedChannelStore: {}, FluxDispatcher: { subscribe() {}, unsubscribe() {} } },
        "../core/ticketSound": sound,
        "../platform": { storage: { get: async () => undefined, set: async (key: string, value: any) => { calls.push({ key, value }); } }, toast() {} },
        "./observable": { createObservable(initial: any) { let state = initial; return { get: () => state, set: (patch: any) => { state = { ...state, ...patch }; } }; } },
    };
    const api: any = {};
    runInNewContext(code, { exports: api, require: (id: string) => { if (!(id in dependencies)) throw Error(id); return dependencies[id]; }, console, setTimeout, clearTimeout, Date }, { timeout: 1000 });
    const stop = api.startTicketSound();
    try {
        await new Promise(resolve => setImmediate(resolve));
        expect(api.ticketSoundState.get().loaded).toBe(true);
        const begin = performance.now();
        for (let i = 0; i < 100; i++) api.setTicketSound({ volume: i });
        const enqueueMs = performance.now() - begin;
        await new Promise(resolve => setImmediate(resolve));
        expect(calls).toHaveLength(100);
        expect(calls.map(c => c.value.volume)).toEqual(Array.from({ length: 100 }, (_, i) => i));
        expect(calls.every(c => c.key === "SupportTemplates_ticketSound_v1")).toBe(true);
        console.log(JSON.stringify({ rapidOptions: 100, enqueueMs: +enqueueMs.toFixed(3), drainIncludingYieldMs: +(performance.now()-begin).toFixed(3), writes: calls.length, audioWrites: 0, payloadBytes: Buffer.byteLength(JSON.stringify(calls[99].value)) }));
    } finally { stop(); }
});
