import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonalDraft } from "../src/core/personal";
import { Store, STORE_KEY } from "../src/core/state";

const draft = (extra: Partial<PersonalDraft> = {}): PersonalDraft => ({ title: "Original", text: "Original answer", project: "mj", command: null, color: null, folderId: null, ...extra });
function harness() {
    const data = new Map<string, unknown>();
    const write = vi.fn(async (key: string, value: unknown) => { data.set(key, structuredClone(value)); });
    const storage = { get: async (key: string) => structuredClone(data.get(key)), set: write };
    vi.spyOn(console, "error").mockImplementation(() => {});
    return { s: new Store(storage), storage, write, data };
}
function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());

describe("personal persistence transactions", () => {
    it("preserves import invocation order across intervening preference writes", async () => {
        const h = harness(), entered = gate(), release = gate(), completed: string[] = [];
        h.write.mockImplementationOnce(async (key, value) => { entered.resolve(); await release.promise; h.data.set(key, structuredClone(value)); });
        const saving = h.s.savePersonal(draft()); await entered.promise;
        const a = h.s.importTextAsync("## Majestic RP\n### Older\nOld answer").then(() => completed.push("A"));
        h.s.setPrefix("!");
        const b = h.s.importTextAsync("## Majestic RP\n### Newer\nNew answer").then(() => completed.push("B"));
        release.resolve(); await Promise.all([saving, a, b]); await h.s.flush();
        expect(completed).toEqual(["A", "B"]);
        const reload = new Store(h.storage); await reload.load();
        expect(reload.templates.some(t => t.title === "Newer")).toBe(true);
        expect(reload.templates.some(t => t.title === "Older")).toBe(false);
        expect(reload.data.prefix).toBe("!");
    });
    it("continues ordered imports after an earlier import fails", async () => {
        const h = harness();
        const a = h.s.importTextAsync("{}").catch(error => error);
        const b = h.s.importTextAsync("## Majestic RP\n### Valid\nAnswer");
        expect(await a).toBeInstanceOf(Error); await b;
        const reload = new Store(h.storage); await reload.load();
        expect(reload.templates.some(t => t.title === "Valid")).toBe(true);
    });
    it("imports a shortcut freed by a pending personal deletion", async () => {
        const h = harness(), id = await h.s.savePersonal(draft()), entered = gate(), release = gate();
        h.s.setBind(id, "Ctrl+KeyQ"); await h.s.flush();
        h.write.mockImplementationOnce(async (key, value) => { entered.resolve(); await release.promise; h.data.set(key, structuredClone(value)); });
        const deleting = h.s.deletePersonal(id); await entered.promise;
        const importing = h.s.importTextAsync(JSON.stringify({ raw: "## Majestic RP\n### Imported\nAnswer", binds: { "Majestic RP||Imported": "Ctrl+KeyQ" } }));
        release.resolve(); await deleting; await importing; await h.s.flush();
        const reload = new Store(h.storage); await reload.load();
        expect(reload.bindFor("local:Majestic RP||Imported")).toBe("Ctrl+KeyQ");
    });
    it("does not publish or later persist a failed edit after the draft is discarded", async () => {
        const h = harness(), id = await h.s.savePersonal(draft());
        const version = h.s.setVersion, changed = vi.fn(); h.s.subscribe(changed);
        h.write.mockRejectedValueOnce(new Error("disk"));
        await expect(h.s.savePersonal(draft({ text: "Discarded answer" }), id)).rejects.toThrow("disk");
        expect(h.s.byId(id)?.text).toBe("Original answer");
        expect(h.s.setVersion).toBe(version); expect(changed).not.toHaveBeenCalled();
        h.s.setPrefix("!"); await h.s.flush();
        const reload = new Store(h.storage); await reload.load();
        expect(reload.byId(id)?.text).toBe("Original answer");
        expect(reload.data.prefix).toBe("!");
        await h.s.savePersonal(draft({ text: "Accepted retry" }), id);
        expect(h.s.byId(id)?.text).toBe("Accepted retry");
    });
    it("failed creation is absent and can retry the same candidate ID", async () => {
        const h = harness(); h.write.mockRejectedValueOnce(new Error("disk"));
        await expect(h.s.savePersonal(draft(), undefined, "personal:retry")).rejects.toThrow("disk");
        expect(h.s.templates).toEqual([]);
        h.s.setPrefix("!"); await h.s.flush();
        expect((h.data.get(STORE_KEY) as any).personal).toEqual([]);
        await h.s.savePersonal(draft(), undefined, "personal:retry");
        expect(h.s.templates.map(t => t.id)).toEqual(["personal:retry"]);
    });
    it("failed deletion preserves content, favorites, binds and usage", async () => {
        const h = harness(), id = await h.s.savePersonal(draft());
        h.s.toggleFavorite(id); h.s.setBind(id, "Ctrl+KeyQ"); h.s.markUsed(id); await h.s.flush();
        const before = structuredClone(h.s.data);
        h.write.mockRejectedValueOnce(new Error("disk"));
        await expect(h.s.deletePersonal(id)).rejects.toThrow("disk");
        expect(h.s.data).toEqual(before); expect(h.s.byId(id)).toBeDefined();
        h.s.setPreviewOpen(false); await h.s.flush();
        const reload = new Store(h.storage); await reload.load();
        expect(reload.byId(id)).toBeDefined(); expect(reload.bindFor(id)).toBe("Ctrl+KeyQ");
        expect(reload.isFavorite(id)).toBe(true); expect(reload.data.usage[id].n).toBe(1);
    });
    it.each(["create", "rename", "delete"])("does not publish failed folder %s or lose template assignments", async op => {
        const h = harness(), folder = await h.s.saveFolder("Original folder"), id = await h.s.savePersonal(draft({ folderId: folder }));
        const before = structuredClone(h.s.data);
        h.write.mockRejectedValueOnce(new Error("disk"));
        await expect(op === "create" ? h.s.saveFolder("New folder", undefined, "folder:retry")
            : op === "rename" ? h.s.saveFolder("Rejected name", folder) : h.s.deleteFolder(folder)).rejects.toThrow("disk");
        expect(h.s.data).toEqual(before); expect(h.s.byId(id)?.category).toBe("Original folder");
        h.s.setPrefix("!"); await h.s.flush();
        const reload = new Store(h.storage); await reload.load();
        expect(reload.data.personal).toEqual(before.personal); expect(reload.data.folders).toEqual(before.folders);
    });
    it.each([true, false])("keeps concurrent preference changes when a pending edit succeeds=%s", async succeeds => {
        const h = harness(), id = await h.s.savePersonal(draft()), entered = gate(), release = gate();
        h.write.mockImplementationOnce(async (key, value) => {
            entered.resolve(); await release.promise;
            if (!succeeds) throw new Error("disk");
            h.data.set(key, structuredClone(value));
        });
        const saving = h.s.savePersonal(draft({ text: "New answer" }), id).catch(() => null);
        await entered.promise;
        const textWhilePending = h.s.byId(id)?.text;
        h.s.setPrefix("!"); h.s.toggleFavorite(id); h.s.markUsed(id);
        release.resolve(); await saving; await h.s.flush();
        expect(textWhilePending).toBe("Original answer");
        const reload = new Store(h.storage); await reload.load();
        expect(reload.byId(id)?.text).toBe(succeeds ? "New answer" : "Original answer");
        expect(reload.data.prefix).toBe("!"); expect(reload.isFavorite(id)).toBe(true);
        expect(reload.data.usage[id].n).toBe(1); expect(h.s.data.personal).toEqual(reload.data.personal);
    });
    it("serializes overlapping creates and does not let a failed draft occupy a command", async () => {
        const h = harness(), entered = gate(), release = gate();
        h.write.mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw new Error("disk"); });
        const first = h.s.savePersonal(draft({ command: "gpu" }), undefined, "personal:first").catch(() => null);
        await entered.promise;
        const second = h.s.savePersonal(draft({ command: "gpu" }), undefined, "personal:second").catch(() => null);
        release.resolve(); await first;
        expect(await second).toBe("personal:second");
        const reload = new Store(h.storage); await reload.load();
        expect(reload.templates.map(t => t.id)).toEqual(["personal:second"]);
    });
    it("checks command uniqueness after an earlier successful queued create", async () => {
        const h = harness(), entered = gate(), release = gate();
        h.write.mockImplementationOnce(async (key, value) => { entered.resolve(); await release.promise; h.data.set(key, structuredClone(value)); });
        const first = h.s.savePersonal(draft({ command: "gpu" }), undefined, "personal:first");
        await entered.promise;
        const second = h.s.savePersonal(draft({ command: "GPU" }), undefined, "personal:second").catch(error => error);
        release.resolve(); await first;
        expect(await second).toBeInstanceOf(Error);
        expect(h.s.templates.map(t => t.id)).toEqual(["personal:first"]);
        const reload = new Store(h.storage); await reload.load();
        expect(reload.templates.map(t => t.id)).toEqual(["personal:first"]);
    });
    it("deletion removes references changed while the write was pending and later writes cannot resurrect them", async () => {
        const h = harness(), id = await h.s.savePersonal(draft()), entered = gate(), release = gate();
        h.write.mockImplementationOnce(async (key, value) => { entered.resolve(); await release.promise; h.data.set(key, structuredClone(value)); });
        const deleting = h.s.deletePersonal(id); await entered.promise;
        h.s.toggleFavorite(id); h.s.markUsed(id); h.s.setBind(id, "Ctrl+KeyQ"); h.s.setPrefix("!");
        release.resolve(); await deleting; await h.s.flush();
        const reload = new Store(h.storage); await reload.load();
        for (const store of [h.s, reload]) {
            expect(store.byId(id)).toBeUndefined(); expect(store.isFavorite(id)).toBe(false);
            expect(store.data.recent).toEqual([]); expect(store.bindFor(id)).toBeUndefined();
            expect(store.data.usage[id]).toBeUndefined(); expect(store.data.prefix).toBe("!");
        }
    });
    it("preserves a concurrent FAQ import when the personal transaction commits", async () => {
        const h = harness(), id = await h.s.savePersonal(draft()), entered = gate(), release = gate();
        h.write.mockImplementationOnce(async (key, value) => { entered.resolve(); await release.promise; h.data.set(key, structuredClone(value)); });
        const saving = h.s.savePersonal(draft({ text: "New answer" }), id); await entered.promise;
        expect(() => h.s.importText("## Majestic RP\n### New FAQ\nNew FAQ answer")).toThrow("Дождитесь сохранения");
        const importing = h.s.importTextAsync("## Majestic RP\n### New FAQ\nNew FAQ answer");
        release.resolve(); await saving; await importing; await h.s.flush();
        const reload = new Store(h.storage); await reload.load();
        for (const store of [h.s, reload]) {
            expect(store.byId(id)?.text).toBe("New answer");
            expect(store.templates.some(t => t.title === "New FAQ" && t.text === "New FAQ answer")).toBe(true);
        }
    });
    it("captures the draft at invocation, not when its queued write begins", async () => {
        const h = harness(), entered = gate(), release = gate();
        h.write.mockImplementationOnce(async (key, value) => { entered.resolve(); await release.promise; h.data.set(key, structuredClone(value)); });
        h.s.setPrefix("!"); await entered.promise;
        const input = draft(), saving = h.s.savePersonal(input, undefined, "personal:captured");
        input.text = "Later unsaved draft";
        release.resolve(); await saving;
        expect(h.s.byId("personal:captured")?.text).toBe("Original answer");
    });
    it("serializes folder rename with a template save using its updated category", async () => {
        const h = harness(), folder = await h.s.saveFolder("Old"), entered = gate(), release = gate();
        h.write.mockImplementationOnce(async (key, value) => { entered.resolve(); await release.promise; h.data.set(key, structuredClone(value)); });
        const renaming = h.s.saveFolder("New", folder); await entered.promise;
        const saving = h.s.savePersonal(draft({ folderId: folder }));
        release.resolve(); await renaming; const id = await saving;
        const reload = new Store(h.storage); await reload.load();
        expect(reload.byId(id)?.category).toBe("New");
    });
});
