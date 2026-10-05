import { describe, expect, it } from "vitest";
import { fieldsOf, fill } from "../src/core/tokens";

const env = { now: new Date(2026, 9, 5, 19, 7), clipboard: "CLIP", selection: "Ivan_Petrov", url: "https://discord.com/x", title: "ticket-1" };

describe("tokens", () => {
    it("lists user fields once, skips built-ins", () => {
        const f = fieldsOf("{{ник}} {{сервер|NY|Detroit}} {{ник}} {{date+3d}} {{clipboard}} {{срок=2 дня}}");
        expect(f).toEqual([
            { name: "ник", def: "", options: [] },
            { name: "сервер", def: "", options: ["NY", "Detroit"] },
            { name: "срок", def: "2 дня", options: [] },
        ]);
    });
    it("fills built-ins with date/time offsets", () => {
        expect(fill("{{date}} {{time}} {{date+3d}} {{time-30m}} {{date+1w}}", {}, env).text)
            .toBe("05.10.2026 19:07 08.10.2026 18:37 12.10.2026");
        expect(fill("{{clipboard}}|{{selection}}|{{url}}|{{title}}", {}, env).text)
            .toBe("CLIP|Ivan_Petrov|https://discord.com/x|ticket-1");
    });
    it("fills fields: value, default, first option", () => {
        expect(fill("{{a}}/{{b=деф}}/{{c|x|y}}", { a: "1" }, env).text).toBe("1/деф/x");
    });
    it("caret marker is removed and its position returned", () => {
        expect(fill("ab{|}cd", {}, env)).toEqual({ text: "abcd", caret: 2 });
        expect(fill("abcd", {}, env).caret).toBeNull();
    });
});
