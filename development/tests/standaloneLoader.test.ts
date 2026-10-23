import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../standalone/runtime/loader.cjs", import.meta.url), "utf8");
function run(config: unknown, args: string[] = [], missingRuntime = false, redirected = "", patcherThrows = false,
    host = "DiscordCanary\\app-1.0.1", missingOriginal = false, originalIsDirectory = false) {
    const root = "C:\\Users\\Test\\AppData\\Local";
    const env: Record<string, string> = { LOCALAPPDATA: root };
    const loaded: string[] = [], app = { setAppPath: vi.fn() };
    const virtualFs = vi.fn(() => { throw new Error("Physical checks reached Electron ASAR-aware fs"); });
    const req = Object.assign((name: string) => {
        if (name === "fs" || name === "node:fs") return new Proxy({}, { get: virtualFs });
        if (name === "original-fs") return { readFileSync: () => JSON.stringify(config), existsSync: (p: string) =>
            !(missingRuntime && /runtime\\(patcher|preload)\.js$/.test(p)) && !(missingOriginal && p.endsWith("\\_app.asar")),
            lstatSync: (p: string) => ({ isSymbolicLink: () => p === redirected,
                isFile: () => !(originalIsDirectory && p.endsWith("\\_app.asar")) }), realpathSync: (p: string) => p };
        if (name === "path") return path.win32;
        if (name === "electron") return { app };
        if (name.endsWith("_app.asar\\package.json")) return { main: "bundle.js" };
        loaded.push(name);
        if (patcherThrows && name.endsWith("patcher.js")) throw new Error("Partial runtime initialization");
    }, { main: { filename: "app.asar\\index.js" } });
    runInNewContext(source, { require: req, __dirname: root + "\\" + host + "\\resources\\app.asar",
        process: { env, argv: args }, console: { error: vi.fn() } });
    return { env, loaded, app, virtualFs };
}
const config = () => ({ schema: 1, product: "SupportTemplates", channel: "canary",
    runtime: "C:\\Users\\Test\\AppData\\Local\\SupportTemplates\\channels\\canary\\versions\\0.1.0-canary.1\\runtime",
    dataDir: "C:\\Users\\Test\\AppData\\Local\\SupportTemplates\\channels\\canary\\data" });

describe("standalone loader", () => {
    it("checks physical ASAR paths without Electron's virtual fs, retaining ASAR-aware require", () => {
        const c = config(), runtime = run(c), vanilla = run(c, ["--vanilla"]);
        expect(runtime.loaded).toEqual([c.runtime + "\\patcher.js"]);
        expect(vanilla.loaded).toEqual([expect.stringMatching(/_app\.asar\\bundle\.js$/)]);
        expect(runtime.virtualFs).not.toHaveBeenCalled();
        expect(vanilla.virtualFs).not.toHaveBeenCalled();
    });
    it.each([{ args: [] }, { args: ["--vanilla"] }])("rejects a physical directory posing as the original archive ($args)", ({ args }) => {
        expect(() => run(config(), args, false, "", false, "DiscordCanary\\app-1.0.1", false, true))
            .toThrow("Invalid original Discord archive");
    });
    it.each([{ args: [] }, { args: ["--vanilla"] }])("starts original Discord on a prerelease host with invalid config (args: $args)", ({ args }) => {
        const r = run(null, args, false, "", false, "DiscordCanary\\app-1.0.1251-beta.1");
        expect(r.loaded).toEqual(["C:\\Users\\Test\\AppData\\Local\\DiscordCanary\\app-1.0.1251-beta.1\\resources\\_app.asar\\bundle.js"]);
    });
    describe.each(["canary", "stable", "ptb"])("%s host identity", channel => {
        const hostName = channel === "ptb" ? "DiscordPTB" : channel === "canary" ? "DiscordCanary" : "Discord";
        const hostConfig = () => {
            const c = config();
            return { ...c, channel, runtime: c.runtime.replace("channels\\canary", "channels\\" + channel),
                dataDir: c.dataDir.replace("channels\\canary", "channels\\" + channel) };
        };
        it.each(["1.0.1251", "1.0.1251-beta.1", "1.0.1251-RC-2.alpha3", "1.0.1251-0"])(
            "loads runtime and preserves fallback for installer-supported version %s", version => {
                const host = hostName + "\\app-" + version;
                const c = hostConfig();
                const original = "C:\\Users\\Test\\AppData\\Local\\" + host + "\\resources\\_app.asar";
                const r = run(c, [], false, "", false, host);
                expect(r.loaded).toEqual([c.runtime + "\\patcher.js"]);
                expect(r.env.SUPPORT_TEMPLATES_DATA_DIR).toBe(c.dataDir);
                expect(r.env.SUPPORT_TEMPLATES_CHANNEL).toBe(channel);
                for (const fallback of [run(c, ["--vanilla"], false, "", false, host),
                    run(null, [], false, "", false, host), run(c, [], true, "", false, host)]) {
                    expect(fallback.loaded).toEqual([original + "\\bundle.js"]);
                    expect(fallback.app.setAppPath).toHaveBeenCalledExactlyOnceWith(original);
                    expect(fallback.env.SUPPORT_TEMPLATES_DATA_DIR).toBeUndefined();
                }
            });
        it("falls back when a prerelease host is configured for the other channel", () => {
            const c = hostConfig(), other = channel === "canary" ? "stable" : "canary";
            const r = run({ ...c, channel: other,
                runtime: c.runtime.replace("channels\\" + channel, "channels\\" + other),
                dataDir: c.dataDir.replace("channels\\" + channel, "channels\\" + other) },
            [], false, "", false, hostName + "\\app-1.0.1251-beta.1");
            expect(r.loaded).toEqual([expect.stringContaining(hostName + "\\app-1.0.1251-beta.1\\resources\\_app.asar\\bundle.js")]);
            expect(r.env.SUPPORT_TEMPLATES_DATA_DIR).toBeUndefined();
        });
    });
    it.each(["DiscordDevelopment\\app-1.0.1251-beta.1", "Other\\DiscordCanary\\app-1.0.1251-beta.1",
        "..\\DiscordCanary\\app-1.0.1251-beta.1", "DiscordCanary\\app-1.0.1251-beta.1\\extra",
        ...["1.0", "1.0.1251.2", "1.0.1251-", "1.0.1251-beta.", "1.0.1251-beta..1",
            "1.0.1251-beta--1", "1.0.1251-beta_1", "1.0.1251+build.1"].map(version => "DiscordCanary\\app-" + version)])(
        "rejects unsupported host before runtime or vanilla fallback: %s", host => {
            for (const args of [[], ["--vanilla"]]) {
                expect(() => run(config(), args, false, "", false, host)).toThrow("Invalid original Discord location");
            }
        });
    it("requires the original backup on prerelease hosts even for runtime startup", () => {
        for (const args of [[], ["--vanilla"]]) {
            expect(() => run(config(), args, false, "", false, "DiscordCanary\\app-1.0.1251-beta.1", true))
                .toThrow("Invalid original Discord location");
        }
    });
    it.each(["", "\\resources", "\\resources\\_app.asar"])("rejects redirected prerelease host locations: %s", tail => {
        const host = "DiscordCanary\\app-1.0.1251-beta.1";
        const redirected = "C:\\Users\\Test\\AppData\\Local\\" + host + tail;
        for (const args of [[], ["--vanilla"]]) {
            expect(() => run(config(), args, false, redirected, false, host)).toThrow("Redirected location");
        }
    });
    it("loads the isolated runtime and data path", () => {
        const c = config(), r = run(c);
        expect(r.loaded).toEqual([c.runtime + "\\patcher.js"]);
        expect(r.env.SUPPORT_TEMPLATES_DATA_DIR).toBe(c.dataDir);
        expect(r.env.DISABLE_UPDATER_AUTO_PATCHING).toBe("1");
    });
    it.each([null, { ...config(), channel: "unknown" }, { ...config(), runtime: "C:\\arbitrary\\runtime" },
        { ...config(), runtime: config().runtime + "\\..\\..\\..\\evil\\runtime" },
        { ...config(), dataDir: "C:\\shared\\Vencord" }])("falls back before initialization for invalid config", c => {
        const r = run(c);
        expect(r.loaded).toHaveLength(1);
        expect(r.loaded[0]).toMatch(/_app\.asar\\bundle\.js$/);
        expect(r.env.SUPPORT_TEMPLATES_DATA_DIR).toBeUndefined();
    });
    it("keeps vanilla mode available and uses original app path", () => {
        const r = run(config(), ["--vanilla"]);
        expect(r.app.setAppPath).toHaveBeenCalledWith(expect.stringMatching(/_app\.asar$/));
        expect(r.loaded[0]).toMatch(/_app\.asar\\bundle\.js$/);
    });
    it("starts original Discord if the installed runtime disappeared", () => {
        expect(run(config(), [], true).loaded[0]).toMatch(/_app\.asar\\bundle\.js$/);
    });
    it("rejects a self-consistent Stable config in a Canary installation", () => {
        const c = config();
        const r = run({ ...c, channel: "stable", runtime: c.runtime.replace("channels\\canary", "channels\\stable"),
            dataDir: c.dataDir.replace("channels\\canary", "channels\\stable") });
        expect(r.loaded).toEqual([expect.stringMatching(/_app\.asar\\bundle\.js$/)]);
        expect(r.env.SUPPORT_TEMPLATES_DATA_DIR).toBeUndefined();
    });
    it.each([config().dataDir, config().runtime, path.win32.dirname(config().runtime), config().runtime + "\\patcher.js"])(
        "rejects junctions and symbolic links at launch: %s", location => {
            expect(run(config(), [], false, location).loaded).toEqual([expect.stringMatching(/_app\.asar\\bundle\.js$/)]);
        });
    it("does not start a second Discord bootstrap after partial runtime initialization", () => {
        expect(() => run(config(), [], false, "", true)).toThrow("Partial runtime initialization");
    });
    it.each(["resources", "resources\\_app.asar"])("aborts instead of falling back through redirected %s", tail => {
        const redirected = "C:\\Users\\Test\\AppData\\Local\\DiscordCanary\\app-1.0.1\\" + tail;
        expect(() => run(config(), [], false, redirected)).toThrow("Redirected location");
        expect(() => run(config(), ["--vanilla"], false, redirected)).toThrow("Redirected location");
    });
});
