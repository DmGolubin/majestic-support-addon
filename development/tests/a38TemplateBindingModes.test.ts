import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { bindProblem, comboOf } from "../src/core/keys";
import { sanitize, Store, STORE_KEY } from "../src/core/state";
import { TemplateBindMode } from "../src/core/types";

const raw = "## Majestic RP\n### A\nЗдравствуйте!\n\nОтвет A\n### B\nОтвет B\n### C\nОтвет C";
const a = "local:Majestic RP||A", b = "local:Majestic RP||B", c = "local:Majestic RP||C";
const memory = () => {
    const saved = new Map<string, unknown>();
    return { saved, get: async (key: string) => saved.get(key),
        set: async (key: string, value: unknown) => { saved.set(key, structuredClone(value)); } };
};
const setup = () => { const storage = memory(), store = new Store(storage); store.importText(raw); return { store, storage }; };
// The optional third argument extends the existing assignment API; old callers stay ordinary.
const bind = (store: Store, id: string, combo: string, mode: TemplateBindMode = "noGreeting") => store.setBind(id, combo, mode);
const modes = (store: Store) => store.data.bindModes;

describe("A38 custom bind mode persistence and normalization", () => {
    it.each(["Ctrl+Enter", "Ctrl+NumpadEnter"])("preserves %s bindings when assigning and loading", combo => {
        const { store } = setup();
        expect(bindProblem(combo)).toBe("");
        store.setBind(a, combo);
        expect(store.bindFor(a)).toBe(combo);
        const legacy = sanitize({ ...store.data, binds: { [a]: combo, [b]: "F8" } }, store.templates);
        expect(legacy.data.binds).toEqual({ [a]: combo, [b]: "F8" });
        expect(legacy.data.bindModes).toEqual({});
        const result = sanitize({ ...store.data, binds: { [a]: combo, [b]: "F8" },
            bindModes: { [a]: "noGreeting" } }, store.templates);
        expect(result.data.binds).toEqual({ [a]: combo, [b]: "F8" });
        expect(result.data.bindModes).toEqual({ [a]: "noGreeting" });
    });

    it("persists the selected mode through a real storage reload and retains string chords", async () => {
        const { store, storage } = setup();
        bind(store, a, "F8"); store.setBind(b, "F9");
        await store.flush();
        expect(storage.saved.get(STORE_KEY)).toMatchObject({ binds: { [a]: "F8", [b]: "F9" }, bindModes: { [a]: "noGreeting" } });
        const reloaded = new Store(storage); await reloaded.load();
        expect(modes(reloaded)).toEqual({ [a]: "noGreeting" });
        expect(reloaded.templateForCombo("F8")?.id).toBe(a);
        expect(reloaded.bindFor(b)).toBe("F9");
    });

    it("loads old saves with ordinary bindings and no migration warning", () => {
        const { store } = setup();
        const saved: any = { ...store.data, binds: { [a]: "F8" } }; delete saved.bindModes;
        const result = sanitize(saved, store.templates);
        expect(result.data.bindModes).toEqual({});
        expect(result.data.binds).toEqual({ [a]: "F8" });
        expect(result.fixed).toEqual([]);
    });

    it("drops modes for rejected, duplicate, missing and unknown-template bindings", () => {
        const { store } = setup();
        const result = sanitize({ ...store.data, binds: { [a]: "F8", [b]: "F8", [c]: "Ctrl+KeyC", ghost: "F9" },
            bindModes: { [a]: "noGreeting", [b]: "noGreeting", [c]: "noGreeting", ghost: "noGreeting", unbound: "noGreeting" } }, store.templates);
        expect(result.data.bindModes).toEqual({ [a]: "noGreeting" });
        expect(result.fixed).toContain("bindModes");
    });

    it.each([null, [], "noGreeting", { [a]: true }, { [a]: "send" }, { [a]: "insert" }].map(bindModes => ({ bindModes })))("defaults malformed or ordinary mode metadata to ordinary: $bindModes", ({ bindModes }) => {
        const { store } = setup();
        const result = sanitize({ ...store.data, binds: { [a]: "F8" }, bindModes }, store.templates);
        expect(result.data.bindModes).toEqual({});
        expect(result.data.binds).toEqual({ [a]: "F8" });
    });

    it("imports mode metadata using the same legacy IDs and winning bindings as the backup", async () => {
        const { store, storage } = setup();
        bind(store, c, "F10");
        store.importText(JSON.stringify({ raw, binds: { "Majestic RP||A": "F8", "Majestic RP||B": "F8", "Majestic RP||C": "F9" },
            bindModes: { "Majestic RP||A": "noGreeting", "Majestic RP||B": "noGreeting", "Majestic RP||C": "future-mode", unknown: "noGreeting" } }));
        expect(modes(store)).toEqual({ [a]: "noGreeting" });
        expect(store.data.binds).toEqual({ [a]: "F8", [c]: "F9" });
        await store.flush(); const reloaded = new Store(storage); await reloaded.load();
        expect(modes(reloaded)).toEqual({ [a]: "noGreeting" });
        store.importText(JSON.stringify({ raw, binds: { "Majestic RP||A": "F8" } }));
        expect(modes(store)).toEqual({});
    });

    it("retains a personal mode when its chord wins an import conflict", async () => {
        const { store } = setup();
        const id = await store.savePersonal({ title: "Личный", text: "Текст", project: "mj", command: null, color: null, folderId: null });
        bind(store, id, "F8");
        store.importText(JSON.stringify({ raw, binds: { "Majestic RP||A": "F8" }, bindModes: { "Majestic RP||A": "noGreeting" } }));
        expect(store.data.binds).toEqual({ [id]: "F8" });
        expect(modes(store)).toEqual({ [id]: "noGreeting" });
        await store.deletePersonal(id);
        expect(modes(store)).toEqual({});
    });

    it("clears mode metadata on stealing, ordinary rebinding, and removal", () => {
        const { store } = setup();
        bind(store, a, "F8"); bind(store, b, "F9");
        expect(bind(store, b, "F8", "insert")).toBe(a);
        expect(store.data.binds).toEqual({ [b]: "F8" });
        expect(modes(store)).toEqual({});
        bind(store, b, "F9"); store.setBind(b, "F10");
        expect(modes(store)).toEqual({});
        bind(store, b, "F9"); store.clearBind(b);
        expect(modes(store)).toEqual({});
        expect(store.templateForCombo("F9")).toBeUndefined();
    });

    it("rejects assignment to a missing template before stealing its chord", () => {
        const { store } = setup(); bind(store, a, "F8");
        expect(() => bind(store, "unknown", "F8")).toThrow();
        expect(store.templateForCombo("F8")?.id).toBe(a);
        expect(modes(store)).toEqual({ [a]: "noGreeting" });
    });

    it("ignores a stale unknown owner when resolving a surviving binding", () => {
        const { store } = setup();
        store.data.binds = { unknown: "F8", [a]: "F8" };
        expect(store.templateForCombo("F8")?.id).toBe(a);
        store.templates = [];
        expect(store.templateForCombo("F8")).toBeUndefined();
    });

    it("restores panel modes against a validated catalog and prunes only after confirmed deletion", () => {
        const { store: local } = setup();
        const panel = new Store(memory(), true);
        const catalog = { templates: local.templates, personal: [], folders: [] };
        panel.replacePanelCatalog(catalog);
        panel.restorePanelPreferences({ binds: { [a]: "F8", [b]: "F9" }, bindModes: { [a]: "noGreeting", [b]: "noGreeting" } });
        expect(modes(panel)).toEqual({ [a]: "noGreeting", [b]: "noGreeting" });
        panel.clearPanelCatalog();
        expect(panel.templateForCombo("F8")).toBeUndefined();
        expect(modes(panel)).toEqual({ [a]: "noGreeting", [b]: "noGreeting" });
        panel.replacePanelCatalog({ ...catalog, templates: catalog.templates.filter(t => t.id === b) });
        expect(modes(panel)).toEqual({ [b]: "noGreeting" });
    });
});

const source = readFileSync(new URL("../src/vencord/index.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source.slice(source.indexOf("const inForeignInput"), source.indexOf("let host:")), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const key = (extra: any = {}) => ({ code: "F8", key: "F8", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    repeat: false, target: { closest: () => null }, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra });

describe("A38 actual custom-bound dispatch", () => {
    const handler = (store: Store, windowOpen = false) => {
        const insertTemplate = vi.fn(), latchKey = vi.fn();
        const onKey = runInNewContext(code + "\nonKey;", {
            store, comboOf, insertTemplate, latchKey,
            ui: { get: () => ({ windowOpen, menu: null, dialog: null, management: false }) },
            pluginOn: () => true, activeScope: () => "mj", handleInlineKey: () => false, swallowLatched: () => false,
            noteKey() {}, dlog() {}, debugEnabled: () => false, keyDesc: () => "", costStart: () => 0, costEnd() {},
        });
        return { onKey, insertTemplate, latchKey };
    };

    it.each(["insert", "noGreeting"] as const)("dispatches %s to draft insertion with the selected greeting option", mode => {
        const { store } = setup(); bind(store, a, "F8", mode);
        const h = handler(store), event = key(); h.onKey(event);
        const opts = mode === "noGreeting" ? { via: "bind F8", noGreeting: true } : { via: "bind F8" };
        expect(h.insertTemplate).toHaveBeenCalledExactlyOnceWith(store.byId(a), opts);
        expect(h.latchKey).toHaveBeenCalledExactlyOnceWith("F8");
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).toHaveBeenCalledOnce();
        h.onKey(key({ repeat: true }));
        expect(h.insertTemplate).toHaveBeenCalledOnce();
    });

    it("leaves a removed template's chord unclaimed", () => {
        const { store } = setup(); bind(store, a, "F8"); store.templates = [];
        const h = handler(store), event = key(); h.onKey(event);
        expect(h.insertTemplate).not.toHaveBeenCalled(); expect(h.latchKey).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it.each(["Enter", "NumpadEnter"].flatMap(code => ["picker", "button", "foreign"].map(targetKind => ({ code, targetKind }))))(
        "leaves Ctrl+$code owned by $targetKind even with an in-memory legacy custom bind", ({ code, targetKind }) => {
        const { store } = setup(); store.data.binds[a] = "Ctrl+" + code;
        const h = handler(store, true);
        const target = { closest: (selector: string) => {
            if ((selector === ".vc-stx-root" || selector === ".vc-stx-win") && targetKind !== "foreign") return {};
            if (selector === "input, textarea, select" && targetKind === "foreign") return {};
            if (selector === "button" && targetKind === "button") return {};
            return null;
        } };
        const event = key({ code, key: "Enter", ctrlKey: true, target }); h.onKey(event);
        expect(h.insertTemplate).not.toHaveBeenCalled(); expect(h.latchKey).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopPropagation).not.toHaveBeenCalled();
    });

    it.each(["Enter", "NumpadEnter"].flatMap(code => [false, true].map(windowOpen => ({ code, windowOpen }))))(
        "retains the custom Ctrl+$code action on body when windowOpen=$windowOpen", ({ code, windowOpen }) => {
        const { store } = setup(); store.data.binds[a] = "Ctrl+" + code;
        const h = handler(store, windowOpen), event = key({ code, key: "Enter", ctrlKey: true }); h.onKey(event);
        expect(h.insertTemplate).toHaveBeenCalledExactlyOnceWith(store.byId(a), { via: "bind Ctrl+" + code });
        expect(event.preventDefault).toHaveBeenCalledOnce();
    });
});
