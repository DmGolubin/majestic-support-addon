import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEGACY_KEY, Store, STORE_KEY } from "../src/core/state";

const fixture = readFileSync(new URL("./fixtures/config-0.5.1.json", import.meta.url), "utf8");
const mem = (init: Record<string, unknown> = {}) => {
    const m = new Map(Object.entries(init));
    return { m, get: async (k: string) => m.get(k), set: async (k: string, v: unknown) => { m.set(k, structuredClone(v)); } };
};

describe("Store", () => {
    it("imports the 0.5.1 config and persists", async () => {
        const st = mem();
        const s = new Store(st);
        await s.load();
        expect(s.templates).toHaveLength(0);
        const msg = s.importText(fixture);
        expect(msg).toContain("133");
        expect(s.templates).toHaveLength(133);
        expect(s.data.favorites).toHaveLength(17);
        await Promise.resolve();
        const s2 = new Store(st);
        await s2.load();
        expect(s2.templates).toHaveLength(133);
    });
    it("migrates the spike's DataStore key", async () => {
        const legacy = JSON.parse(fixture);
        const s = new Store(mem({ [LEGACY_KEY]: { raw: legacy.raw, usage: legacy.usage, pinned: legacy.pinned, tabs: {} } }));
        await s.load();
        expect(s.templates).toHaveLength(133);
        expect(s.data.favorites).toHaveLength(17);
    });
    it("favorites, recent and usage", async () => {
        const s = new Store(mem());
        await s.load();
        s.importText("## Majestic RP\n### A\na\n### B\nb");
        const [a, b] = s.templates;
        s.toggleFavorite(b.id);
        expect(s.isFavorite(b.id)).toBe(true);
        s.markUsed(a.id); s.markUsed(b.id); s.markUsed(a.id);
        expect(s.data.recent).toEqual([a.id, b.id]);
        expect(s.data.usage[a.id].n).toBe(2);
        expect(s.ctx().favorites).toEqual([b.id]);
    });
    it("binds: validated, unique, stolen from previous owner", async () => {
        const s = new Store(mem());
        await s.load();
        s.importText("## Majestic RP\n### A\na\n### B\nb");
        const [a, b] = s.templates;
        expect(() => s.setBind(a.id, "Ctrl+KeyC")).toThrow();
        expect(s.setBind(a.id, "Ctrl+Alt+KeyF")).toBeNull();
        expect(s.templateForCombo("Ctrl+Alt+KeyF")?.id).toBe(a.id);
        expect(s.setBind(b.id, "Ctrl+Alt+KeyF")).toBe(a.id);
        expect(s.bindFor(a.id)).toBeUndefined();
        s.clearBind(b.id);
        expect(s.templateForCombo("Ctrl+Alt+KeyF")).toBeUndefined();
    });
    it("server bindings, intentional marks, prefix", async () => {
        const s = new Store(mem());
        await s.load();
        s.setGuild("42", "none");
        expect(s.data.guilds["42"]).toBe("none");
        s.clearGuilds();
        expect(s.data.guilds).toEqual({});
        s.markIntentional("x");
        expect(s.isIntentional("x")).toBe(true);
        s.setPrefix(".");
        expect(s.data.prefix).toBe(".");
        expect(() => s.setPrefix("/")).toThrow();
    });
    it("notifies subscribers", async () => {
        const s = new Store(mem());
        await s.load();
        let n = 0;
        const off = s.subscribe(() => n++);
        s.setPreviewOpen(true);
        off();
        s.setPreviewOpen(false);
        expect(n).toBe(1);
        expect(STORE_KEY).toBe("SupportTemplates_v2");
    });
});
