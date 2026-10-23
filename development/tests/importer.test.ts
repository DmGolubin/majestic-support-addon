import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importBackup, localId, parseRaw, projectOfGroup } from "../src/core/importer";

const fixture = readFileSync(new URL("./fixtures/config-0.5.1.json", import.meta.url), "utf8");

describe("importer", () => {
    it("maps group names to projects", () => {
        expect(projectOfGroup("Majestic RP")).toBe("mj");
        expect(projectOfGroup("Россия Онлайн")).toBe("ro");
        expect(projectOfGroup("")).toBeNull();
    });
    it("parses ## project / ### title format with escaped headings", () => {
        const t = parseRaw("### Общий\nтекст\n## Majestic RP\n### Один\n\\## не заголовок\nстрока\n## Россия Онлайн\n### Два\nтело");
        expect(t.map(x => [x.project, x.title])).toEqual([[null, "Общий"], ["mj", "Один"], ["ro", "Два"]]);
        expect(t[1].text).toBe("## не заголовок\nстрока");
        expect(t[1].id).toBe(localId("Majestic RP", "Один"));
        expect(t[1].source).toBe("local");
        expect(t[1].status).toBe("actual");
    });
    it("parses JSON array format", () => {
        const t = parseRaw(JSON.stringify([{ title: "A", text: "x", group: "Majestic RP" }]));
        expect(t).toHaveLength(1);
        expect(t[0].project).toBe("mj");
    });
    it("imports the real 0.5.1 config", () => {
        const r = importBackup(fixture);
        expect(r.templates).toHaveLength(133);
        expect(r.templates.filter(t => t.project === "mj")).toHaveLength(68);
        expect(r.templates.filter(t => t.project === "ro")).toHaveLength(65);
        expect(r.favorites).toHaveLength(17);
        expect(r.favorites[0]).toBe("local:Россия Онлайн||Проблемы с соединением / Server not responding");
        expect(Object.keys(r.usage).length).toBeGreaterThan(20);
    });
    it("imports plain text and rejects garbage", () => {
        expect(importBackup("## Majestic RP\n### A\nb").templates).toHaveLength(1);
        expect(() => importBackup("ничего")).toThrow();
    });
});
