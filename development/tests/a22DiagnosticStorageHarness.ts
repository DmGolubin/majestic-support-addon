import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as buffer from "node:buffer";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { diagnosticData } from "../src/core/diagnosticJournal";
import * as interactionIdle from "../src/core/interactionIdle";

export const ERROR = "Diagnostic storage operation failed.";
export function sourceModule(relative: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    const source = fs.readFileSync(new URL("../" + relative, import.meta.url), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
    } }).outputText;
    const exports: Record<string, any> = {};
    runInNewContext(code, { exports, Buffer, process, URL, crypto: crypto.webcrypto, ...globals, require: (id: string) => {
        if (!(id in modules) && id === "../../src/core/interactionIdle") return interactionIdle;
        if (!(id in modules)) throw new Error("Unexpected dependency: " + id);
        return modules[id];
    } });
    return exports;
}
export const storageModule = sourceModule("src/vencord/diagnosticFileNative.ts", {
    crypto, path, buffer, "./core/diagnosticJournal": { diagnosticData }
});
export const NOW = 1_800_000_000_000;
export function payload(patch: Record<string, unknown> = {}) {
    return {
        product: "SupportTemplates", version: "1.0.1-canary.21", build: "BetterDiscord a1234567",
        distribution: "betterdiscord", exportedAt: new Date(NOW).toISOString(), recording: true, storageFailed: false,
        journal: { schema: 1, campaign: "mvp-file-2026-10", campaignUntil: NOW + 4 * 86400000,
            savedAt: NOW, until: NOW + 4 * 86400000, dropped: 0,
            events: [{ seq: 1, time: NOW, event: "request.start", data: { method: "GET", route: "/me", status: 200 } }] },
        snapshot: {
            connection: { phase: "ready", persistent: true },
            ui: { windowOpen: true, composeCount: 2 }, settings: { previewOpen: true },
            environment: { online: true, width: 1200, height: 900 },
            debug: {
                options: { debug: true, debugVerbose: true }, window: { queryLength: 12, width: 400 },
                load: { total: 120, storeLoad: 90, mount: 30 },
                performance: { measured: true, totalMs: 15, windowMs: 60000,
                    categories: { keys: { ms: 5, n: 3 }, render: { ms: 10, n: 2 }, inline: 4 },
                    longTasksMeasured: true, longTasks: { count: 2, maxMs: 150, pluginMs: 12 } }
            }
        },
        ...patch
    };
}
export const report = () => JSON.stringify(payload());
/** Standard BD bridge: no descriptors/promises/lstat, errors lose Error.code. */
export function bridgeFS(overrides: Record<string, unknown> = {}) {
    return { ...Object.fromEntries(["existsSync", "statSync", "realpathSync", "mkdirSync",
        "readFileSync", "writeFileSync", "renameSync", "unlinkSync"].map(name => [name, (...args: unknown[]) => {
        try { return (fs as any)[name](...args); }
        catch { throw new Error("Bridged filesystem private-path error"); }
    }])), ...overrides };
}
