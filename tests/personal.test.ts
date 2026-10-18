import { describe, expect, it, vi } from "vitest";
import { PersonalDraft } from "../src/core/personal";
import { Store, STORE_KEY } from "../src/core/state";
import { poolOf } from "../src/core/guard";

const draft = (extra: Partial<PersonalDraft> = {}): PersonalDraft => ({ title: "Драйвер", text: "Привет\n[[greeting:end]]\nИнструкция", project: "mj", command: "driver", color: "#3b82f6", folderId: null, ...extra });
const memory = () => {
    const data = new Map<string, unknown>();
    return { data, get: async (k: string) => data.get(k), set: async (k: string, v: unknown) => { data.set(k, structuredClone(v)); } };
};
describe("personal library", () => {
    it("copies a full existing record without replacing its original identity", async () => {
        const storage = memory(), s = new Store(storage);
        const originalId = await s.savePersonal(draft());
        const original = s.data.personal[0];
        const copiedId = await s.savePersonal({ ...original, title: "Копия", command: null }, undefined, "personal:copy");
        expect(copiedId).toBe("personal:copy");
        expect(s.byId(originalId)?.title).toBe("Драйвер");
        expect(s.data.personal).toHaveLength(2);
        await s.deletePersonal(copiedId);
        const reloaded = new Store(storage); await reloaded.load();
        expect(reloaded.data.personal).toHaveLength(1);
        expect(reloaded.byId(originalId)?.command).toBe("driver");
    });
    it("persists records separately, keeps stable IDs on edit and participates in project pools", async () => {
        const storage = memory(), s = new Store(storage);
        const id = await s.savePersonal(draft());
        const version = s.setVersion;
        await s.savePersonal(draft({ title: "Новое название", project: null }), id);
        expect(s.setVersion).toBeGreaterThan(version);
        const reloaded = new Store(storage); await reloaded.load();
        expect(reloaded.byId(id)?.title).toBe("Новое название");
        expect(poolOf(reloaded.templates, "ro", "mj")).toHaveLength(1);
        expect(reloaded.byId(id)?.color).toBe("#3b82f6");
    });
    it("FAQ import preserves personal folders, favorites and binds", async () => {
        const s = new Store(memory());
        const folderId = await s.saveFolder("Драйверы");
        const id = await s.savePersonal(draft({ folderId }));
        s.toggleFavorite(id); s.setBind(id, "Ctrl+Alt+KeyD");
        s.importText("## Majestic RP\n### FAQ\nОсновной текст");
        await s.flush();
        expect(s.templates).toHaveLength(2);
        expect(s.byId(id)?.text).toContain("Инструкция");
        expect(s.bindFor(id)).toBe("Ctrl+Alt+KeyD");
        expect(s.isFavorite(id)).toBe(true);
        expect(s.data.folders[0].name).toBe("Драйверы");
    });
    it("folder rename updates categories and delete moves templates out without losing them", async () => {
        const s = new Store(memory());
        const f = await s.saveFolder("Один");
        const id = await s.savePersonal(draft({ folderId: f }));
        await s.saveFolder("Два", f);
        expect(s.byId(id)?.category).toBe("Два");
        await s.deleteFolder(f);
        expect(s.data.personal[0].folderId).toBeNull();
        expect(s.byId(id)?.category).toBe("Мои шаблоны");
    });
    it("validates fields and command collisions across overlapping scopes", async () => {
        const s = new Store(memory());
        await s.savePersonal(draft());
        await expect(s.savePersonal(draft({ project: null }))).rejects.toThrow("команда");
        await s.savePersonal(draft({ project: "ro" }));
        for (const change of [{ title: " " }, { text: "" }, { color: "url(x)" }, { command: ";hi" }, { folderId: "gone" }]) {
            await expect(s.savePersonal(draft(change))).rejects.toThrow();
        }
    });
    it("does not edit or delete imported FAQ; removes personal references on deletion", async () => {
        const s = new Store(memory());
        s.importText("## Majestic RP\n### FAQ\nОсновной текст");
        const faq = s.templates[0];
        await expect(s.savePersonal(draft(), faq.id)).rejects.toThrow();
        await expect(s.deletePersonal(faq.id)).rejects.toThrow();
        const id = await s.savePersonal(draft());
        s.toggleFavorite(id); s.markUsed(id); s.setBind(id, "Ctrl+Alt+KeyD");
        await s.deletePersonal(id);
        expect(s.byId(id)).toBeUndefined();
        expect(s.isFavorite(id)).toBe(false);
        expect(s.bindFor(id)).toBeUndefined();
        expect(s.data.recent).toEqual([]);
    });
    it("loads old and malformed data safely", async () => {
        const storage = memory();
        storage.data.set(STORE_KEY, { v: 2, raw: "", personal: [null, { id: "local:faq" }, { id: "personal:bad" }], folders: [null] });
        const s = new Store(storage); await s.load();
        expect(s.data.personal).toEqual([]); expect(s.data.folders).toEqual([]);
    });
    it("surfaces write failure and can retry with the same ID", async () => {
        const storage = memory();
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const s = new Store({ ...storage, set: vi.fn().mockRejectedValueOnce(new Error("disk")).mockImplementation(storage.set) });
        await expect(s.savePersonal(draft(), undefined, "personal:test")).rejects.toThrow("disk");
        expect(s.byId("personal:test")).toBeUndefined();
        await s.savePersonal(draft(), undefined, "personal:test");
        expect(s.data.personal).toHaveLength(1);
        log.mockRestore();
    });
    it("retries folder creation and deletion after storage failure", async () => {
        const storage = memory();
        const write = vi.fn().mockImplementation(storage.set);
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const s = new Store({ ...storage, set: write });
        write.mockRejectedValueOnce(new Error("disk"));
        await expect(s.saveFolder("GPU", undefined, "folder:retry")).rejects.toThrow("disk");
        expect(s.data.folders).toEqual([]);
        await s.saveFolder("GPU", undefined, "folder:retry");
        expect(s.data.folders).toHaveLength(1);
        const id = await s.savePersonal(draft());
        write.mockRejectedValueOnce(new Error("disk"));
        await expect(s.deletePersonal(id)).rejects.toThrow("disk");
        await s.deletePersonal(id);
        const reload = new Store(storage); await reload.load();
        expect(reload.data.personal).toHaveLength(0);
        expect(reload.data.folders).toHaveLength(1);
        log.mockRestore();
    });
});
