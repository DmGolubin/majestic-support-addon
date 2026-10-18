import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
export const bdRequire = createRequire(new URL("../betterdiscord/package.json", import.meta.url));
export const root = fileURLToPath(new URL("../", import.meta.url));
export function loadAdapter(relative: string, mocks: Record<string, any> = {}, globals: Record<string, any> = {}) {
    const esbuild = bdRequire("esbuild");
    const code = esbuild.buildSync({ entryPoints: [fileURLToPath(new URL("../betterdiscord/" + relative, import.meta.url))],
        bundle: true, write: false, platform: "node", format: "cjs", target: "es2022",
        external: ["electron", "@electron/remote"], jsxFactory: "React.createElement", jsxFragment: "React.Fragment" }).outputFiles[0].text;
    return evaluate(code, mocks, globals);
}
export function evaluate(code: string, mocks: Record<string, any> = {}, globals: Record<string, any> = {}) {
    const module = { exports: {} as any };
    runInNewContext(code, { module, exports: module.exports, require: (name: string) => name in mocks ? mocks[name] : bdRequire(name),
        process, Buffer, Object, JSON, URL, Headers, Response, TextDecoder, TextEncoder, AbortController, structuredClone,
        setTimeout, clearTimeout, setInterval, clearInterval, console, ...globals });
    return module.exports;
}
export const source = (relative: string) => readFileSync(new URL("../" + relative, import.meta.url), "utf8");
