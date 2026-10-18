import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import { expect, it } from "vitest";
import { fieldsOf, fill } from "../src/core/tokens";
import { hard } from "../src/core/text";

// Synthetic, deterministic differential review of CURRENT parsers against the pinned baseline.
function load(source: string) {
    const exports: any = {};
    const code = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
    } }).outputText;
    runInNewContext(code, { exports, require: () => ({ useMemo: (fn: () => unknown) => fn() }),
        React: { Fragment: "fragment", createElement: (type: string, _props: unknown, ...children: unknown[]) => ({ type, children }) } });
    return exports;
}
const old = (path: string) => load(execFileSync("git", ["show", `65a78b7:${path}`], { encoding: "utf8" }));
const current = (path: string) => load(readFileSync(path, "utf8"));
const env = { now: new Date(2026, 9, 18, 12), clipboard: "{{literal}}{|}", selection: "😀", url: "https://example.org", title: "Title" };
function samples(alphabet: string[], count: number) {
    let seed = 19065;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    return Array.from({ length: count }, () => Array.from({ length: next() % 35 }, () => alphabet[next() % alphabet.length]).join(""));
}

it("Role19: 8000 generated token/text cases retain baseline semantics", () => {
    const tokens = old("src/core/tokens.ts"), text = old("src/core/text.ts");
    for (const input of samples(["{", "}", "{{", "}}", "=", "|", " ", "\n", "x", "a", "{|}", "{{x= d|a|b}}", "{{clipboard}}", "[[greeting:end]]"], 8000)) {
        expect(fieldsOf(input), input).toEqual(tokens.fieldsOf(input));
        expect(fill(input, { x: "VALUE" }, env), input).toEqual(tokens.fill(input, { x: "VALUE" }, env));
        expect(hard(input), input).toBe(text.hard(input));
    }
});

it("Role19: 8000 generated markdown trees retain baseline semantics", () => {
    const before = old("src/vencord/ui/markdown.tsx"), after = current("src/vencord/ui/markdown.tsx");
    for (const input of samples(["*", "_", "**", "__", "~", "~~", "`", "\\", " ", "\n", "a", "b", "1", "https://x.org/a_"], 8000))
        expect(after.Markdown({ text: input }), input).toEqual(before.Markdown({ text: input }));
});

it("Role19: markdown scales through 60k/120k/240k/near-million input; baseline 60k still exceeds 1s", () => {
    const before = old("src/vencord/ui/markdown.tsx"), after = current("src/vencord/ui/markdown.tsx");
    const measurements: { characters: number; ms: number[] }[] = [];
    for (const repeats of [20000, 40000, 80000, 333333]) {
        const input = "*x ".repeat(repeats), ms: number[] = [];
        for (let trial = 0; trial < 3; trial++) {
            const start = performance.now();
            const tree = runInNewContext("render({text: input})", { render: after.Markdown, input }, { timeout: 5000 });
            expect(tree.children[0]).toEqual([input]);
            ms.push(Math.round((performance.now() - start) * 100) / 100);
        }
        measurements.push({ characters: input.length, ms });
    }
    console.log("Role19 markdown isolated measurements", JSON.stringify(measurements));
    expect(() => runInNewContext("render({text: input})", { render: before.Markdown, input: "*x ".repeat(20000) }, { timeout: 1000 })).toThrow(/timed out/);
}, 15000);
