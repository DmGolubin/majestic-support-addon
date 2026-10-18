import { afterEach, describe, expect, it, vi } from "vitest";
import { fieldsOf, fill } from "../src/core/tokens";
import { htmlToDiscordText } from "../src/vencord/panelHtml";

afterEach(() => vi.unstubAllGlobals());

describe("inert FAQ HTML conversion", () => {
    it("preserves the reported FAQ paragraphs, numbered steps and literal Markdown", () => {
        const faq = '**Приветствую! Благодарим Вас за обращение в службу поддержки.**\n\nДля решения Вашей проблемы:\n\n1. Убедитесь, что GTA 5 не имеет модификаций.\nЕсли использовали редукс, reshade, ENB, "замененки", проверка файлов может не удалить их.\n2. Обновите драйвера.\n3. Используйте SSD накопитель.\n4. Запустите лаунчер от имени администратора.\n5. Возможное решение это сменить IP адрес у провайдера или при помощи VPN (используйте разные программы, не только одну)\n\nid#00048394';
        expect(htmlToDiscordText(faq)).toBe(faq);
        expect(htmlToDiscordText('<div><span style="white-space: pre-wrap">' + faq + '</span></div>')).toBe(faq);
    });
    it("preserves existing escapes, fenced code and autolinks without double escaping", () => {
        const faq = '**Title**\n\n\\*literal\\*\n\n```txt\n  indented_line\n```\n\n<https://example.com/help>';
        expect(htmlToDiscordText(faq)).toBe(faq);
    });
    it("keeps readable paragraphs, breaks, lists, tables, entities and safe links", () => {
        const text = htmlToDiscordText('<p>Hello &amp; welcome</p><p>Next<br>line</p><ul><li>One</li><li>Two</li></ul><ol><li>Step A</li><li>Step B</li></ol><table><tr><td>Key</td><td>Value</td></tr></table><a href="https://example.com/help?a=1&amp;b=2">Help</a>');
        expect(text).toContain("Hello & welcome\n\nNext\nline");
        expect(text).toContain("- One"); expect(text).toContain("- Two");
        expect(text).toContain("1. Step A"); expect(text).toContain("2. Step B");
        expect(text).toContain("Key | Value"); expect(text).toContain("Help <https://example.com/help?a=1&b=2>");
    });
    it("never uses DOM or network APIs, removes active subtrees and keeps image alt text", () => {
        const forbidden = vi.fn(() => { throw Error("DOM/network must not be used"); });
        for (const key of ["DOMParser", "fetch", "Image"]) vi.stubGlobal(key, forbidden);
        vi.stubGlobal("document", new Proxy({}, { get: forbidden }));
        const text = htmlToDiscordText('<p>Visible</p><script>alert("SECRET")</script><style>SECRET</style><iframe src="https://invalid.example">SECRET</iframe><svg onload="x">SECRET</svg><object>SECRET</object><template>SECRET</template><img src="https://invalid.example/pixel" onerror="x" alt="Screenshot"><p>End</p>');
        expect(text).toContain("Visible"); expect(text).toContain("Screenshot"); expect(text).toContain("End");
        expect(text).not.toMatch(/SECRET|alert|onerror|invalid\.example/);
        expect(forbidden).not.toHaveBeenCalled();
    });
    it.each(["javascript:alert(1)", "data:text/html,test", "file:///secret", "//example.com", "https://user:pass@example.com", "java&#115;cript:alert(1)"])("drops unsafe href %s while retaining its label", href => {
        expect(htmlToDiscordText(`<a href="${href}">Label</a>`)).toBe("Label");
    });
    it("preserves Markdown and neutralizes Discord mentions after entity decoding", () => {
        const text = htmlToDiscordText('<p>**Bold** @everyone &#64;here &lt;@123&gt; [Help](https://example.com)</p>');
        expect(text).toContain("**Bold**");
        expect(text).not.toContain("@everyone"); expect(text).not.toContain("@here"); expect(text).not.toContain("<@123>");
        expect(text).toContain("@\u200beveryone"); expect(text).toContain("[Help](https://example.com)");
    });
    it("handles quoted angle brackets, comments and unfinished dangerous tags conservatively", () => {
        expect(htmlToDiscordText('<p title="a > b">Visible</p><!-- hidden --><script>unfinished')).toBe("Visible");
        expect(htmlToDiscordText("<p>safe</p><img src='unfinished")).toBe("safe");
        expect(htmlToDiscordText("&lt;script&gt;literal&lt;/script&gt;")).toContain("literal");
    });
    it("preserves tokens and markers exactly, then parses and fills fields, lists and builtins", () => {
        const tokens = "{{user_name=First_Last}} {{choice|a_b|c*d}} {{date+1d}} {{time-1h}} {{clipboard}} {{selection}} {{url}} {{title}} [[greeting:end]] {|}";
        const text = htmlToDiscordText("<p>**Hello** " + tokens + "</p>");
        expect(text).toContain(tokens);
        expect(fieldsOf(text)).toEqual([
            { name: "user_name", def: "First_Last", options: [] },
            { name: "choice", def: "", options: ["a_b", "c*d"] },
        ]);
        const result = fill(text, { user_name: "User", choice: "c*d" }, {
            now: new Date(2026, 9, 18, 10, 30), clipboard: "Clip", selection: "Selected", url: "https://example.com", title: "Ticket",
        });
        expect(result.text).toContain("User c*d 19.10.2026 09:30 Clip Selected https://example.com Ticket [[greeting:end]]");
        expect(result.text).not.toContain("{{"); expect(result.caret).not.toBeNull();
    });
    it("decodes entity-encoded token operators without escaping the resulting syntax", () => {
        const text = htmlToDiscordText("<p>{{choice&#124;one_two&#124;three}} {{name= A &amp; B }}</p>");
        expect(text).toBe("{{choice|one_two|three}} {{name= A & B }}");
        expect(fieldsOf(text)[0].options).toEqual(["one_two", "three"]);
    });
    it("preserves tokens split by inline formatting and whitespace inside valid defaults", () => {
        const text = htmlToDiscordText("<p>{{choice<span>|a_b</span><strong>|c*d</strong>}} {{ name =first\n  second }}</p>");
        expect(text).toBe("{{choice|a_b|c*d}} {{ name =first\n  second }}");
        expect(fieldsOf(text)[0].options).toEqual(["a_b", "c*d"]);
        expect(fieldsOf(text)[1].def).toBe("first\n  second");
    });
});
