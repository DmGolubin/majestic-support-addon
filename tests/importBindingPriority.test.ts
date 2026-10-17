import { expect, it } from "vitest";
import { Store } from "../src/core/state";

it("keeps a personal hotkey when an imported FAQ claims the same combination", async () => {
    const memory = new Map<string, unknown>();
    const storage = { get: async (k: string) => memory.get(k), set: async (k: string, v: unknown) => { memory.set(k, structuredClone(v)); } };
    const s = new Store(storage);
    const id = await s.savePersonal({ title: "Личный", text: "Текст", project: "mj", command: null, color: null, folderId: null });
    s.setBind(id, "Ctrl+Alt+KeyF");
    const result = s.importText(JSON.stringify({ raw: "## Majestic RP\n### FAQ\nОтвет", binds: { "Majestic RP||FAQ": "Ctrl+Alt+KeyF" } }));
    expect(s.bindFor(id)).toBe("Ctrl+Alt+KeyF");
    expect(s.bindFor("local:Majestic RP||FAQ")).toBeUndefined();
    expect(result).toContain("клавиш не принято: 1");
    await s.flush();
    const reload = new Store(storage); await reload.load();
    expect(reload.templateForCombo("Ctrl+Alt+KeyF")?.id).toBe(id);
});
