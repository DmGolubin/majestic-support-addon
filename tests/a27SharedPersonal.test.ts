import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as guard from "../src/core/guard";
import { comboOf } from "../src/core/keys";
import { parseProfile, parseSnapshot } from "../src/core/panelCatalog";
import { createPanelPreferencesStorage } from "../src/core/panelPreferences";
import { favoritesOf, orderHits, windowTabPool } from "../src/core/rank";
import { search } from "../src/core/search";
import { Store } from "../src/core/state";
import * as text from "../src/core/text";
import * as tokens from "../src/core/tokens";
import * as types from "../src/core/types";

const date = "2026-10-20T12:00:00Z";
const accountId = "123456789012345678";
const wireProjects = ["majestic", "russia-online"];
function fixture(projects = wireProjects, account = accountId) {
    const profile = parseProfile({ schemaVersion: 1, accountId: account, connectionId: "12345678-1234-1234-1234-123456789abc",
        name: "Support", projects, scopes: ["profile:read", "faq:read", "personal:read", "folders:read"],
        permissionsRevision: "rights-1", minimumPluginVersion: "1.0.0", serverTime: date });
    const wire = {
        schemaVersion: 1, accountId: account, permissionsRevision: "rights-1", revision: "snapshot-1", serverTime: date, projects,
        faq: projects.map(project => ({ id: `${project}:1`, version: "faq-1", title: "Common title", text: `FAQ ${project}`,
            format: "text", projects: [project], category: "FAQ", tags: [], status: "actual", updatedAt: date })),
        personal: projects.map((project, i) => ({ id: String(i + 1), version: `personal-${i}`, title: `Personal ${project}`, text: `Private answer ${project === "majestic" ? "alpha" : "beta"}`,
            projects: [project], shared: false, format: "text", command: `cmd${i}`, color: null, folderId: String(i + 1), updatedAt: date })),
        folders: projects.map((project, i) => ({ id: String(i + 1), version: "folder-1", title: `Folder ${project}`, project, position: i, updatedAt: date })),
        trash: [], limits: { colors: [] }, colorLabels: {},
    };
    return { profile, wire, catalog: parseSnapshot(wire, profile, value => value) };
}
const ids = (rows: types.Template[]) => rows.map(t => t.id);
const compile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;

describe("A27 fetched personal visibility", () => {
    it("keeps source records, project, folder, and object identity while adding authorized display projects", () => {
        const { catalog, wire } = fixture();
        expect(catalog.personal.map(t => t.project)).toEqual(["mj", "ro"]);
        expect(catalog.personal.map(t => t.personalVisibleIn)).toEqual([["mj", "ro"], ["mj", "ro"]]);
        expect(catalog.personal.map(t => t.folderId)).toEqual(["folder:panel:1", "folder:panel:2"]);
        expect(catalog.personal.map(t => t.category)).toEqual(["Folder majestic", "Folder russia-online"]);
        for (const t of catalog.personal) expect(catalog.templates.find(row => row.id === t.id)).toBe(t);
        expect(catalog.personalRecords.map(t => ({ projects: t.projects, shared: t.shared, folder: t.folderId })))
            .toEqual([{ projects: ["mj"], shared: false, folder: "1" }, { projects: ["ro"], shared: false, folder: "2" }]);
        expect(wire.personal.every(t => !t.shared && t.projects.length === 1)).toBe(true);
        expect(catalog.templates.filter(t => t.source === "faq").every(t => t.personalVisibleIn === undefined)).toBe(true);
    });

    it.each(["mj", "ro"] as const)("includes both fetched personal records but only %s FAQ in All/My/search/favorites/recent/Tech", project => {
        const { catalog } = fixture();
        const pool = guard.poolOf(catalog.templates, project, project);
        const faqId = `faq:${project === "mj" ? "majestic" : "russia-online"}:1`;
        expect(ids(pool)).toEqual([faqId, "personal:panel:1", "personal:panel:2"]);
        expect(guard.poolOf(catalog.templates, "all", project)).toEqual(pool);
        const ctx = { favorites: ["personal:panel:2", "personal:panel:1", "faq:majestic:1", "faq:russia-online:1"], recent: ["personal:panel:1", "personal:panel:2"], usage: {} };
        expect(ids(windowTabPool(pool, "all", ctx, false))).toEqual([faqId]);
        expect(windowTabPool(pool, "all", ctx, true)).toEqual(pool);
        expect(ids(windowTabPool(pool, "personal", ctx, false))).toEqual(["personal:panel:1", "personal:panel:2"]);
        expect(ids(favoritesOf(pool, ctx))).toEqual(["personal:panel:2", "personal:panel:1", faqId]);
        expect(ids(windowTabPool(pool, "recent", ctx, false))).toEqual(ctx.recent);
        expect(search(pool, "beta").hits.map(h => h.t.id)).toEqual(["personal:panel:2"]);
        expect(orderHits(search(pool, "cmd0").hits, ctx)[0].t).toBe(catalog.personal[0]);
        expect(guard.poolOf(catalog.templates, null, project)).toEqual([]);
    });

    it("does not expand source authorization or trust wire-supplied visibility", () => {
        const { wire, profile, catalog } = fixture(["majestic"]);
        expect(catalog.personal[0].personalVisibleIn).toEqual(["mj"]);
        expect(guard.poolOf(catalog.templates, "ro", "ro")).toEqual([]);
        expect(guard.poolOf(catalog.templates, "all", "ro")).toEqual([]);
        Object.assign(wire.personal[0], { personalVisibleIn: ["mj", "ro"] });
        expect(parseSnapshot(wire, profile, t => t).personal[0].personalVisibleIn).toEqual(["mj"]);
        wire.personal[0].projects = ["russia-online"];
        expect(() => parseSnapshot(wire, profile, t => t)).toThrow();
    });

    it("does not mirror a fetched personal record into a same-title FAQ or broaden local/FAQ guards", () => {
        const { catalog } = fixture();
        const personal = catalog.personal[1];
        personal.title = "Common title";
        expect(guard.decide(personal, "mj", catalog.templates)).toEqual({ kind: "ok", t: personal });
        expect(guard.findMirror(personal, catalog.templates, "mj")).toBeNull();
        const foreignFaq = catalog.templates[1];
        expect(guard.decide(foreignFaq, "mj", catalog.templates)).toEqual({ kind: "mirror", from: foreignFaq, t: catalog.templates[0] });
        expect(guard.templateFitsProject({ ...foreignFaq, personalVisibleIn: ["mj", "ro"] }, "mj")).toBe(false);
        expect(guard.templateFitsProject({ ...personal, personalVisibleIn: undefined }, "mj")).toBe(false);
        expect(guard.templateFitsProject({ ...personal, source: "local" }, "mj")).toBe(false);
    });

    it("replacement/revocation drops cross-project text and references without persisting catalog or visibility", async () => {
        const saved = new Map<string, unknown>();
        const storage = { get: async (key: string) => saved.get(key), set: async (key: string, value: unknown) => { saved.set(key, structuredClone(value)); } };
        const store = new Store(createPanelPreferencesStorage(storage, accountId), true);
        store.replacePanelCatalog(fixture().catalog);
        store.toggleFavorite("personal:panel:2");
        store.setBind("personal:panel:2", "F8");
        await store.flush();
        expect(JSON.stringify([...saved])).not.toContain("Private answer");
        expect(JSON.stringify([...saved])).not.toContain("personalVisibleIn");
        store.clearPanelCatalog();
        expect(guard.poolOf(store.templates, "mj", "mj")).toEqual([]);
        store.replacePanelCatalog(fixture(["majestic"]).catalog);
        expect(store.byId("personal:panel:2")).toBeUndefined();
        expect(store.templateForCombo("F8")).toBeUndefined();
        expect(store.data.favorites).toEqual([]);
        const other = new Store(createPanelPreferencesStorage(storage, "223456789012345678"), true);
        expect(other.templates).toEqual([]);
        expect(other.data.favorites).toEqual([]);
    });
});

const flowCode = compile("../src/vencord/ui/flow.ts");
function flowHarness() {
    const store = new Store({ get: async () => undefined, set: async () => {} }, true);
    store.replacePanelCatalog(fixture().catalog);
    const editor = { isConnected: true, textContent: "Existing draft", focus: vi.fn(), closest: () => null };
    const state: any = { dialog: null, menu: null, windowOpen: false, management: false };
    let scope: guard.Scope | null = "mj";
    const insert = vi.fn(() => true), toast = vi.fn();
    const deps: Record<string, unknown> = {
        "../core/guard": guard, "../core/text": text, "../core/tokens": tokens, "../core/types": types,
        "../platform": { activeEditor: () => editor, currentChannel: () => ({ id: "channel", guildId: types.PROJECTS.mj.guildId, name: "ticket" }), insertText: insert, toast, readClipboard: async () => "" },
        "./debug": { debugEnabled: () => false, dlog() {} },
        "./op": { generationNow: () => 1, targetNow: () => ({ editor, selection: "" }) },
        "./uiState": { store, ui: { get: () => state, set: (patch: any) => Object.assign(state, patch) }, activeScope: () => scope, currentMode: () => scope, libraryIsFresh: () => true, ensureLibraryFresh: async () => true },
    };
    const api: any = {};
    runInNewContext(flowCode, { exports: api, document: { activeElement: editor, body: {} }, require: (id: string) => {
        if (!(id in deps)) throw new Error(`Unexpected import ${id}`); return deps[id];
    } });
    return { api, store, state, insert, toast, setScope: (next: guard.Scope | null) => { scope = next; } };
}

describe("A27 real insertion and key handlers", () => {
    it("inserts the same foreign-source personal record without source-project warning or FAQ mirroring", async () => {
        const h = flowHarness(), personal = h.store.byId("personal:panel:2")!;
        personal.title = "Common title";
        await h.api.insertTemplate(personal);
        expect(h.insert).toHaveBeenCalledExactlyOnceWith("Private answer beta");
        expect(h.state.dialog).toBeNull();
        expect(h.store.byId(personal.id)).toBe(personal);
        expect(personal.project).toBe("ro");
    });

    it("still warns on actual other-project text in personal templates", async () => {
        const h = flowHarness(), personal = h.store.byId("personal:panel:2")!;
        personal.text = "Посетите russia.online";
        const pending = h.api.insertTemplate(personal);
        for (let i = 0; i < 12; i++) await Promise.resolve();
        expect(h.state.dialog.label).toBe("Упоминается другой проект");
        h.state.dialog.resolve({ ok: false, checked: false });
        await pending;
        expect(h.insert).not.toHaveBeenCalled();
    });

    it.each(["revoked", "account", "deleted"] as const)("rejects captured personal objects after %s", async reason => {
        const h = flowHarness(), old = h.store.byId("personal:panel:2")!;
        if (reason === "revoked") h.setScope(null);
        else if (reason === "deleted") h.store.replacePanelCatalog(fixture(["majestic"]).catalog);
        else h.store.clearPanelCatalog();
        await h.api.insertTemplate(old);
        expect(h.insert).not.toHaveBeenCalled();
        expect(h.state.dialog).toBeNull();
    });

    it.each(["mj", "ro", "all"] as const)("uses shared personal records for binds and closed-window Alt favorites in %s", scope => {
        const file = readFileSync(new URL("../src/vencord/index.tsx", import.meta.url), "utf8");
        const code = ts.transpileModule(file.slice(file.indexOf("const inForeignInput"), file.indexOf("let host:")), {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const store = new Store({ get: async () => undefined, set: async () => {} }, true);
        store.replacePanelCatalog(fixture().catalog);
        const personal = store.byId("personal:panel:2")!, foreignFaq = store.byId("faq:russia-online:1")!;
        store.setBind(personal.id, "F8"); store.setBind(foreignFaq.id, "F9"); store.toggleFavorite(personal.id);
        const insert = vi.fn(), toast = vi.fn();
        const onKey = runInNewContext(code + "\nonKey;", {
            ui: { get: () => ({ windowOpen: false }) }, store, comboOf, activeScope: () => scope, pluginOn: () => true,
            templateFitsProject: guard.templateFitsProject, poolFor: () => guard.poolOf(store.templates, scope, "mj"), favoritesOf,
            swallowLatched: () => false, handleInlineKey: () => false, insertTemplate: insert, toast, latchKey() {},
            debugEnabled: () => false, noteKey() {}, dlog() {}, keyDesc: () => "", costStart: () => 0, costEnd() {},
        });
        const press = (code: string, altKey = false) => onKey({ code, key: code, altKey, ctrlKey: false, shiftKey: false, metaKey: false, repeat: false,
            target: { closest: () => null }, preventDefault() {}, stopPropagation() {} });
        press("F8"); press("Digit1", true);
        expect(insert.mock.calls).toEqual([[personal, { via: "bind F8" }], [personal, { via: "alt-1" }]]);
        if (scope === "all") {
            press("F9");
            expect(insert).toHaveBeenCalledTimes(2);
            expect(toast).toHaveBeenCalledOnce();
        }
    });
});
