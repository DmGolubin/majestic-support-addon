import { describe, expect, it } from "vitest";
import { importBackup, parseRaw } from "../src/core/importer";
import { cleanBinds, isValidBind } from "../src/core/keys";
import { Store, STORE_KEY } from "../src/core/state";

const mem = (init: Record<string, unknown> = {}) => {
    const m = new Map(Object.entries(init));
    return { m, get: async (k: string) => m.get(k), set: async (k: string, v: unknown) => { m.set(k, structuredClone(v)); } };
};

const RAW = "## Majestic RP\n### A\ntext a\n### B\ntext b\n### C\ntext c";

describe("binds from files and saves (audit 2)", () => {
    it("rejects plain keys, reserved and non-canonical combos", () => {
        for (const c of ["Enter", "KeyA", "Ctrl+KeyV", "Shift+KeyA", "Alt+Digit1", "Alt+Ctrl+KeyQ", "Ctrl+Ctrl+KeyQ", "Ctrl+", "Hyper+KeyQ", 5])
            expect(isValidBind(c), String(c)).toBe(false);
        for (const c of ["Ctrl+Alt+KeyQ", "Alt+KeyQ", "F5", "Ctrl+Shift+Digit2"]) expect(isValidBind(c), c).toBe(true);
    });
    it("import drops invalid binds and repeats, keeps valid ones", () => {
        const r = importBackup(JSON.stringify({
            raw: RAW,
            binds: { "Majestic RP||A": "Enter", "Majestic RP||B": "Ctrl+Alt+KeyQ", "Majestic RP||C": "Ctrl+Alt+KeyQ", "Nope||X": "Alt+KeyW" },
        }));
        expect(r.binds).toEqual({ "local:Majestic RP||B": "Ctrl+Alt+KeyQ" });
        expect(r.droppedBinds).toBe(3);
    });
    it("cleanBinds ignores non-objects", () => {
        expect(cleanBinds(null, new Set()).binds).toEqual({});
        expect(cleanBinds("x", new Set()).binds).toEqual({});
    });
});

describe("duplicate titles (audit 6)", () => {
    it("later duplicates get a numbered id; the first keeps the plain one", () => {
        const ts = parseRaw("## Majestic RP\n### Same\nFIRST\n### Same\nSECOND\n### Same\nTHIRD");
        expect(ts.map(t => t.id)).toEqual(["local:Majestic RP||Same", "local:Majestic RP||Same#2", "local:Majestic RP||Same#3"]);
        expect(new Set(ts.map(t => t.id)).size).toBe(3);
    });
    it("the import summary reports them", () => {
        const s = new Store(mem());
        expect(s.importText("## Majestic RP\n### Same\na\n### Same\nb")).toContain("повторяющихся названий: 1");
        expect(s.byId("local:Majestic RP||Same#2")?.text).toBe("b");
    });
});

describe("damaged saves (audit 13)", () => {
    it("repairs field by field and keeps the original aside", async () => {
        const st = mem({
            [STORE_KEY]: {
                v: 2, raw: RAW, favorites: null, recent: ["local:Majestic RP||A", 7], usage: "x",
                binds: { "local:Majestic RP||A": "Enter", "local:Majestic RP||B": "Ctrl+Alt+KeyQ" },
                prefix: "/", previewOpen: "yes", techProject: "eu", intentional: [],
            },
        });
        const s = new Store(st);
        await s.load();
        expect(s.templates).toHaveLength(3);
        expect(s.data.favorites).toEqual([]);
        expect(s.data.recent).toEqual(["local:Majestic RP||A"]);
        expect(s.data.usage).toEqual({});
        expect(s.data.binds).toEqual({ "local:Majestic RP||B": "Ctrl+Alt+KeyQ" });
        expect(s.data.prefix).toBe(";");
        expect(s.data.previewOpen).toBe(true);
        expect(s.data.techProject).toBe("mj");
        expect(s.isFavorite("local:Majestic RP||A")).toBe(false); // no crash on .includes
        expect(st.m.has(STORE_KEY + "_damaged")).toBe(true);
    });
    it("a valid save is loaded as is, without a damaged copy", async () => {
        const st = mem({ [STORE_KEY]: { v: 2, raw: RAW, favorites: ["local:Majestic RP||A"], recent: [], usage: {}, binds: {}, guilds: {}, intentional: [], prefix: ";", previewOpen: false, techProject: "ro" } });
        const s = new Store(st);
        await s.load();
        expect(s.data.favorites).toEqual(["local:Majestic RP||A"]);
        expect(s.data.previewOpen).toBe(false);
        expect(s.data.techProject).toBe("ro");
        expect(st.m.has(STORE_KEY + "_damaged")).toBe(false);
    });
    it("import clears 'intentional' answers of the old texts", () => {
        const s = new Store(mem());
        s.importText(RAW);
        s.markIntentional("local:Majestic RP||A");
        s.importText(RAW);
        expect(s.isIntentional("local:Majestic RP||A")).toBe(false);
    });
});

describe("field names that exist on Object.prototype (audit 18)", () => {
    it("are plain fields", async () => {
        const { fill } = await import("../src/core/tokens");
        const env = { now: new Date(0), clipboard: "", selection: "", url: "", title: "" };
        const values: Record<string, string> = Object.create(null);
        expect(fill("{{__proto__=DEF}}", values, env).text).toBe("DEF");
        expect(fill("{{toString}}|{{constructor}}", values, env).text).toBe("|");
        values.__proto__ = "X";
        expect(fill("{{__proto__}}", values, env).text).toBe("X");
    });
});

describe("generated duplicate ids never collide with real titles", () => {
    it("skips a number already used by a real title", () => {
        const ts = parseRaw("## Majestic RP\n### Same#2\nreal\n### Same\na\n### Same\nb");
        expect(new Set(ts.map(t => t.id)).size).toBe(3);
        expect(ts[2].id).toBe("local:Majestic RP||Same#3");
    });
});

describe("template set version", () => {
    it("every import bumps it", () => {
        const s = new Store(mem());
        const v0 = s.setVersion;
        s.importText(RAW);
        s.importText(RAW);
        expect(s.setVersion).toBe(v0 + 2);
    });
});
