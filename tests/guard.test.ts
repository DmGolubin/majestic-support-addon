import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decide, findMirror, foreignMarkers, serverMode, TECH_GUILD } from "../src/core/guard";
import { importBackup } from "../src/core/importer";

const all = importBackup(readFileSync(new URL("./fixtures/config-0.5.1.json", import.meta.url), "utf8")).templates;
const roConn = all.find(t => t.project === "ro" && /Проблемы с соединением/.test(t.title))!;

describe("guard", () => {
    it("server mode: fixed table — mj, ro, Tech = all; everything else and DMs off", () => {
        expect(serverMode("530693013622489088")).toBe("mj");
        expect(serverMode("1089530150540034181")).toBe("ro");
        expect(serverMode("1395915167040016545")).toBe("all");
        expect(TECH_GUILD).toBe("1395915167040016545");
        expect(serverMode("42")).toBe("off");
        expect(serverMode("")).toBe("off");
        expect(serverMode(null)).toBe("off");
    });
    it("finds the mirror template of the other project", () => {
        const m = findMirror(roConn, all, "mj")!;
        expect(m.project).toBe("mj");
        expect(m.title).toBe(roConn.title);
    });
    it("most RO templates have a Majestic mirror", () => {
        const ro = all.filter(t => t.project === "ro");
        const mirrored = ro.filter(t => findMirror(t, all, "mj"));
        expect(mirrored.length / ro.length).toBeGreaterThan(0.8);
    });
    it("decide: ok for own and common, mirror for other project, foreign when no pair", () => {
        expect(decide(roConn, "ro", all).kind).toBe("ok");
        const d = decide(roConn, "mj", all);
        expect(d.kind).toBe("mirror");
        const lonely = { ...roConn, id: "x", title: "Только в РО уникальное" };
        expect(decide(lonely, "mj", [...all, lonely]).kind).toBe("foreign");
        expect(decide({ ...roConn, project: null }, "mj", all).kind).toBe("ok");
    });
    it("spots the other project's markers in text", () => {
        expect(foreignMarkers("Зайдите на forum.russia.online", "mj")).toEqual(["russia.online"]);
        expect(foreignMarkers("Сайт majestic-rp.ru", "ro")).toEqual(["majestic-rp.ru"]);
        expect(foreignMarkers("Обычный текст", "mj")).toEqual([]);
    });
});
