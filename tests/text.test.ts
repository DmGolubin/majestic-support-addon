import { describe, expect, it } from "vitest";
import { hard, soft, splitGreeting, stripMarker, titleKey, tokenize } from "../src/core/text";

describe("text", () => {
    it("soft keeps length, folds ё and nbsp", () => {
        expect(soft("Ёлка\u00A0X")).toBe("елка x");
        expect(soft("Ёлка\u00A0X").length).toBe(6);
    });
    it("hard drops {placeholders} and squeezes spaces", () => {
        expect(hard("  Привет {user name}  мир ")).toBe("привет мир");
        expect(tokenize("Server  NOT")).toEqual(["server", "not"]);
    });
    it("titleKey ignores punctuation and case", () => {
        expect(titleKey("Проблемы с соединением / Server not responding"))
            .toBe(titleKey("проблемы\u00A0 с соединением — server not responding!"));
    });
    it("splitGreeting uses panel marker", () => {
        const r = splitGreeting("**Привет!**\n[[greeting:end]]\nТело");
        expect(r).toEqual({ greeting: "**Привет!**", body: "Тело" });
    });
    it("splitGreeting falls back to first greeting paragraph", () => {
        const r = splitGreeting("**Приветствую! Благодарим Вас.**\n\n*Убедитесь…*\n\n1. Шаг");
        expect(r.greeting).toBe("**Приветствую! Благодарим Вас.**");
        expect(r.body).toBe("*Убедитесь…*\n\n1. Шаг");
    });
    it("splitGreeting leaves text without greeting", () => {
        expect(splitGreeting("Просто текст\n\nещё")).toEqual({ greeting: "", body: "Просто текст\n\nещё" });
    });
    it.each(["\n", "\r\n"])("preserves body indentation after greeting boundaries with %j", newline => {
        const body = `    first line${newline}\tsecond line`;
        const text = `Здравствуйте!${newline}[[greeting:end]]${newline}${body}`;
        expect(splitGreeting(text)).toEqual({ greeting: "Здравствуйте!", body });
        expect(stripMarker(text)).toBe(`Здравствуйте!${newline}${body}`);
        expect(splitGreeting(`Здравствуйте![[greeting:end]]${newline} \t${newline}${body}`).body).toBe(body);
        expect(splitGreeting(`Здравствуйте!${newline} \t${newline}${body}`).body).toBe(body);
    });
    it("keeps inline greeting boundary spacing semantics", () => {
        expect(splitGreeting("Здравствуйте! [[greeting:end]]   Инструкция."))
            .toEqual({ greeting: "Здравствуйте!", body: "Инструкция." });
        expect(splitGreeting("Здравствуйте![[greeting:end]]Инструкция."))
            .toEqual({ greeting: "Здравствуйте!", body: "Инструкция." });
    });
    it.each([
        "Отключите приветствие в настройках.",
        "Приветствие можно отключить в настройках.",
        "Благодаря обновлению ошибка исправлена.",
        "**Проверьте сообщение «Здравствуйте» в журнале.**",
    ])("keeps an instructional first paragraph: %s", first => {
        const text = `${first}\n\nПерезапустите игру.`;
        expect(splitGreeting(text)).toEqual({ greeting: "", body: text });
    });
    it.each(["Здравствуйте!", "__Добрый день!__", "Привет!", "Благодарим Вас за обращение!"])("recognizes an opening salutation: %s", greeting => {
        expect(splitGreeting(`${greeting}\n\nИнструкция.`)).toEqual({ greeting, body: "Инструкция." });
    });
    it("stripMarker removes marker line like panel", () => {
        expect(stripMarker("A\n[[greeting:end]]\nB")).toBe("A\nB");
    });
    it.each(["\n", "\r\n"])("keeps inline boundary separation with %j", newline => {
        expect(stripMarker(`Здравствуйте![[greeting:end]]${newline}**Инструкция.**`))
            .toBe(`Здравствуйте!${newline}**Инструкция.**`);
        expect(stripMarker(`A${newline}  [[greeting:end]]  ${newline}B`)).toBe(`A${newline}B`);
    });
    it("separates an inline boundary without a newline", () => {
        expect(stripMarker("Здравствуйте! [[greeting:end]] Инструкция.")).toBe("Здравствуйте! Инструкция.");
        expect(stripMarker("Здравствуйте![[greeting:end]]Инструкция.")).toBe("Здравствуйте! Инструкция.");
    });
    it("does not add whitespace at an empty boundary or change explicit greeting splitting", () => {
        expect(stripMarker("[[greeting:end]]\nТело")).toBe("Тело");
        expect(stripMarker("Привет![[greeting:end]]")).toBe("Привет!");
        expect(splitGreeting("Вступление.[[greeting:end]]\nТело")).toEqual({ greeting: "Вступление.", body: "Тело" });
    });
});
