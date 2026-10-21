import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { LEGACY_KEY, Store, STORE_KEY } from "../src/core/state";

const fixture = readFileSync(new URL("./fixtures/config-0.5.1.json", import.meta.url), "utf8");
const mem = (init: Record<string, unknown> = {}) => {
    const m = new Map(Object.entries(init));
    return { m, get: async (k: string) => m.get(k), set: async (k: string, v: unknown) => { m.set(k, structuredClone(v)); } };
};

describe("Store", () => {
    it("persists a custom prefix across reload", async () => {
        const st = mem();
        const s = new Store(st);
        await s.load();
        s.setPrefix("$");
        await s.flush();
        const reloaded = new Store(st);
        await reloaded.load();
        expect(reloaded.data.prefix).toBe("$");
    });
    it("imports the 0.5.1 config and persists", async () => {
        const st = mem();
        const s = new Store(st);
        await s.load();
        expect(s.templates).toHaveLength(0);
        const msg = s.importText(fixture);
        expect(msg).toContain("133");
        expect(s.templates).toHaveLength(133);
        expect(s.data.favorites).toHaveLength(17);
        await s.flush();
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
    it("old saves with server answers still load (kept, unused)", async () => {
        const s = new Store(mem());
        await s.load();
        const old = { ...s.data, guilds: { "42": "none", "@dm": "mj" } };
        const s2 = new Store(mem({ [STORE_KEY]: old }));
        await s2.load();
        expect(s2.data.guilds).toEqual({ "42": "none", "@dm": "mj" });
        expect(s2.data.prefix).toBe(";");
    });
    it("intentional marks, prefix", async () => {
        const s = new Store(mem());
        await s.load();
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
    it("a failing storage write is logged, not thrown, and subscribers still run", async () => {
        const err = new Error("disk full");
        const s = new Store({ get: async () => undefined, set: () => Promise.reject(err) });
        await s.load();
        const log = vi.spyOn(console, "error").mockImplementation(() => { });
        let n = 0;
        s.subscribe(() => n++);
        s.toggleFavorite("x");
        expect(n).toBe(1);
        await new Promise(r => setTimeout(r, 0));
        expect(log).toHaveBeenCalledWith("[SupportTemplates]", err);
        log.mockRestore();
    });
});

describe("Store previewOpen default", () => {
    it("is open for a new install", async () => {
        const s = new Store(mem());
        await s.load();
        expect(s.data.previewOpen).toBe(true);
    });
    it("respects a saved value", async () => {
        const s = new Store(mem());
        await s.load();
        s.setPreviewOpen(false);
        await Promise.resolve();
        const st = mem({ [STORE_KEY]: { ...s.data } });
        const s2 = new Store(st);
        await s2.load();
        expect(s2.data.previewOpen).toBe(false);
    });
    it("old saves without the field get the new default", async () => {
        const s = new Store(mem());
        await s.load();
        const { previewOpen: _, ...old } = s.data;
        const s2 = new Store(mem({ [STORE_KEY]: old }));
        await s2.load();
        expect(s2.data.previewOpen).toBe(true);
    });
});

describe("Store techProject", () => {
    it("defaults to Majestic and old saves without the field get it", async () => {
        const s = new Store(mem());
        await s.load();
        expect(s.data.techProject).toBe("mj");
        const { techProject: _, ...old } = s.data;
        const s2 = new Store(mem({ [STORE_KEY]: old }));
        await s2.load();
        expect(s2.data.techProject).toBe("mj");
    });
    it("persists the choice and survives an import; junk values fall back to mj", async () => {
        const s = new Store(mem());
        await s.load();
        s.setTechProject("ro");
        expect(s.data.techProject).toBe("ro");
        s.importText("## Majestic RP\n### A\na");
        expect(s.data.techProject).toBe("ro");
        const s2 = new Store(mem({ [STORE_KEY]: { ...s.data } }));
        await s2.load();
        expect(s2.data.techProject).toBe("ro");
        const s3 = new Store(mem({ [STORE_KEY]: { ...s.data, techProject: "xx" } }));
        await s3.load();
        expect(s3.data.techProject).toBe("mj");
        expect(() => s.setTechProject("xx" as any)).toThrow();
    });
});
