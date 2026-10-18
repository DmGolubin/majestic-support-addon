import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parseProfile, parseSnapshot } from "../src/core/panelCatalog";
import { search } from "../src/core/search";
import { hard, soft } from "../src/core/text";
import { fieldsOf, fill, templateTokens } from "../src/core/tokens";
import { Template } from "../src/core/types";
import { htmlToDiscordText } from "../src/vencord/panelHtml";

// Regression acceptance for defects reproduced against baseline 65a78b7.
// VM deadlines bound synchronous bad-input work;
// these are not renderer latency benchmarks. No Discord, storage, clipboard or network access.
const bounded = <T>(run: () => T, timeout = 1000): T => runInNewContext("run()", { run }, { timeout });
const env = { now: new Date(2026, 9, 18, 12), clipboard: "", selection: "", url: "", title: "" };
const stamp = "2026-10-18T10:00:00.000Z";
const profile = parseProfile({
    schemaVersion: 1, accountId: "1", connectionId: "12345678-1234-1234-1234-123456789abc",
    name: "Synthetic audit", projects: ["majestic"],
    scopes: ["profile:read", "faq:read", "personal:read", "folders:read"],
    permissionsRevision: "1", minimumPluginVersion: "1.0.0", serverTime: stamp,
});
const snapshot = (text: string, format: "text" | "html") => ({
    schemaVersion: 1, accountId: "1", revision: "1", permissionsRevision: "1", serverTime: stamp,
    projects: ["majestic"], limits: { colors: [] }, colorLabels: {}, folders: [], personal: [], trash: [],
    faq: [{ id: "majestic:1", version: "1", title: "Synthetic FAQ", text, format,
        projects: ["majestic"], tags: [], category: null, status: "actual", updatedAt: stamp }],
});

type VNode = { type: string; children: (VNode | string | (VNode | string)[])[]; };
const markdownCode = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/markdown.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const markdown: { Markdown?: (props: { text: string; }) => VNode; } = {};
runInNewContext(markdownCode, {
    exports: markdown,
    require: (name: string) => {
        if (name !== "@webpack/common") throw Error("Unexpected import: " + name);
        return { useMemo: (fn: () => unknown) => fn() };
    },
    React: { Fragment: "fragment", createElement: (type: string, _props: unknown, ...children: VNode["children"]) => ({ type, children }) },
});
const renderMarkdown = (input: string) => markdown.Markdown!({ text: input });
const flatten = (node: unknown): string => typeof node === "string" ? node : Array.isArray(node)
    ? node.map(flatten).join("") : node && typeof node === "object" ? flatten((node as VNode).children) : "";
const tags = (node: unknown): string[] => Array.isArray(node) ? node.flatMap(tags)
    : node && typeof node === "object" ? [(node as VNode).type, ...tags((node as VNode).children)] : [];

describe("Master QA role 04: parser regression acceptance", () => {
    const malformed = "{{" + " ".repeat(20000);
    it("M04-01: fieldsOf must finish on an unterminated whitespace token", () => {
        expect(bounded(() => fieldsOf(malformed))).toEqual([]);
    });
    it("M04-01: fill must preserve an unterminated token without blocking", () => {
        expect(bounded(() => fill(malformed, {}, env)).text).toBe(malformed);
    });
    it("M04-01: legacy HTML conversion must finish on an unterminated token", () => {
        expect(bounded(() => htmlToDiscordText(malformed))).toBe("{{");
    });
    it.each(["text", "html"] as const)("M04-01: snapshot %s parser must finish below its input cap", format => {
        const result = bounded(() => parseSnapshot(snapshot(malformed, format), profile, htmlToDiscordText));
        expect(result.templates[0].text).toBe(format === "text" ? malformed : "{{");
    });
    it("control: the synthetic snapshot is valid in both formats", () => {
        for (const format of ["text", "html"] as const)
            expect(parseSnapshot(snapshot("Answer", format), profile, htmlToDiscordText).templates[0].text).toBe("Answer");
    });
    it("M04-02: hard must preserve unmatched braces without quadratic rescanning", () => {
        const malformed = "{".repeat(100000);
        expect(bounded(() => hard(malformed))).toBe(malformed);
    });
    it("M04-02: searching a catalog-accepted FAQ must finish", () => {
        // Separate braces avoid entering the double-brace token grammar from M04-01.
        const catalog = bounded(() => parseSnapshot(snapshot("{x".repeat(50000), "text"), profile, htmlToDiscordText));
        expect(catalog.templates[0].text.length).toBe(100000);
        expect(bounded(() => search(catalog.templates, "answer")).hits).toEqual([]);
    });
    it("M04-03: recognized date/time tokens must not expand to NaN", () => {
        const input = "{{date+999999999999999999999d}} {{time+999999999999999999999h}}";
        expect(fieldsOf(input)).toEqual([]);
        expect(fill(input, {}, env).text).toBe(input);
    });
    it("M04-04: highlight offsets must map normalized text back to the source", () => {
        const code = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/highlight.tsx", import.meta.url), "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
        }).outputText;
        type Node = { type: string; children: string[]; };
        const exports: { nqHighlight?: (text: string, tokens: string[]) => Node[]; } = {};
        runInNewContext(code, {
            exports,
            require: (name: string) => {
                if (name !== "../core/text") throw Error("Unexpected import: " + name);
                return { soft };
            },
            React: { createElement: (type: string, _props: unknown, ...children: string[]) => ({ type, children }) },
        });
        const t: Template = { id: "audit", title: "İx", text: "Answer", project: "mj", source: "faq",
            category: null, status: "actual", statusNote: null, command: null, color: null, teamUses: 0, updatedAt: null };
        const result = search([t], "x");
        expect(result.hits).toHaveLength(1);
        const nodes = exports.nqHighlight!(t.title, result.tokens);
        expect(nodes.filter(n => n.type === "mark").flatMap(n => n.children).join("")).toBe("x");
        for (const [source, query, marked] of [["İabc", "ab", "ab"], ["İabc", "i", "İ"],
            ["😀İx", "x", "x"], ["AİBİC", "i\u0307bi", "İBİ"], ["Ёж", "еж", "Ёж"]]) {
            const nodes = exports.nqHighlight!(source, [query]);
            expect(nodes.flatMap(n => n.children).join("")).toBe(source);
            expect(nodes.filter(n => n.type === "mark").flatMap(n => n.children).join("")).toBe(marked);
        }
        expect(bounded(() => exports.nqHighlight!("İx", [""])).every(n => n.type !== "mark")).toBe(true);
    });
    it("M04-05: Markdown preview must finish on repeated unclosed emphasis", () => {
        const input = "*x ".repeat(20000);
        const catalog = bounded(() => parseSnapshot(snapshot(input, "text"), profile, htmlToDiscordText));
        expect(catalog.templates[0].text).toBe(input);
        expect(flatten(bounded(() => renderMarkdown(input)))).toBe(input);
    });
    it("M04-01: malformed and overlapping openers retain legacy token/caret semantics", () => {
        expect(fill("{{|}}", {}, env)).toEqual({ text: "{}", caret: 1 });
        expect(fill("{{=bad {{ok= yes }}", {}, env).text).toBe("{{=bad yes");
        expect(fieldsOf("{{outer{{inner}} {{ x = first\n  second | A | B }}")).toEqual([
            { name: "outer{{inner", def: "", options: [] },
            { name: "x", def: "first\n  second", options: ["A", "B"] },
        ]);
        expect(fill("{{n=  |one|two}} {{x=first=last}}", {}, env).text).toBe("one first=last");
        expect(fill("{{broken} {{ok=yes}} {{unterminated {|}", {}, env))
            .toEqual({ text: "{{broken} yes {{unterminated ", caret: 29 });
        expect(fill("{{__proto__}} {{toString}}", {}, env).text).toBe(" ");
        expect(fill("{{x}}{|}", { x: "{{literal}}{|}" }, env))
            .toEqual({ text: "{{literal}}{|}", caret: 14 });
    });
    it.each(["text", "html"] as const)("M04-01: %s preserves token defaults and protects surrounding mentions", format => {
        const input = "@here {{user= @here }} {{choice= |@here|other}} {{|}} [[greeting:end]] {|} @everyone";
        const text = parseSnapshot(snapshot(input, format), profile, htmlToDiscordText).templates[0].text;
        expect(text).toBe("@\u200bhere {{user= @here }} {{choice= |@here|other}} {{|}} [[greeting:end]] {|} @\u200beveryone");
    });
    it.each(["{{" + " ".repeat(999998), "{".repeat(1000000), "{{=x".repeat(249999) + "}}"])(
        "M04-01: one-million-character malformed inputs finish", input => {
            expect(bounded(() => [...templateTokens(input)])).toEqual([]);
            expect(bounded(() => fill(input, {}, env)).text).toBe(input);
            expect(bounded(() => htmlToDiscordText(input))).toBe(input.trim());
        },
    );
    it("M04-01: many distinct fields and a long valid field finish without truncation", () => {
        const input = Array.from({ length: 12000 }, (_, i) => `{{field${i}=value}}`).join(" ");
        const fields = bounded(() => fieldsOf(input));
        expect(fields).toHaveLength(12000);
        expect(fields.at(-1)?.name).toBe("field11999");
        expect(bounded(() => fill("{{x=" + "a".repeat(999994) + "}}", {}, env)).text).toBe("a".repeat(999994));
    });
    it("M04-02: normalization keeps its existing complete-placeholder behavior", () => {
        expect(hard(" A {user} B {broken")).toBe("a b {broken");
        expect(hard("A {{user}} B")).toBe("a } b"); // Preserve legacy matching; do not broaden this fix.
        expect(hard("{{{}}")).toBe("}");
    });
    it.each(["date+999999999999999999999d", "time-999999999999999999999h", "date+" + "9".repeat(400) + "w"])(
        "M04-03: invalid offset %s stays literal without rejecting insertion", name => {
            const raw = `{{ ${name} }}`;
            expect(fill(raw + "{|}", {}, env)).toEqual({ text: raw, caret: raw.length });
        },
    );
    it.each([
        ["**bold** _em_ __under__ ~~gone~~", "bold em under gone", ["fragment", "strong", "em", "u", "s"]],
        ["***nested***", "nested", ["fragment", "strong", "em"]],
        ["snake_case \\*literal\\* `*code*`", "snake_case *literal* *code*", ["fragment", "code"]],
        ["*unclosed **bold**", "*unclosed bold", ["fragment", "strong"]],
        ["https://example.org/a.", "https://example.org/a.", ["fragment", "span"]],
    ])("M04-05: retains preview formatting for %s", (input, expected, expectedTags) => {
        const tree = renderMarkdown(input as string);
        expect(flatten(tree)).toBe(expected);
        expect(tags(tree)).toEqual(expectedTags);
    });
    it("M04-05: a near-limit unclosed preview remains literal within the deadline", () => {
        const input = "*x ".repeat(333333);
        // Allow worker contention at the input cap; the 60k quadratic guard above stays at 1s.
        expect(flatten(bounded(() => renderMarkdown(input), 5000))).toBe(input);
    });
});
