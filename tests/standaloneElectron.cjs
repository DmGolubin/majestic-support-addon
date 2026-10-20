// Optional real-Electron startup regression. Usage:
// node tests/standaloneElectron.cjs <path-to-standalone-electron.exe>
// Never downloads Electron or loads Discord. All profiles/archives are TEMP fixtures.
"use strict";
const path = require("node:path");
const assert = require("node:assert/strict");

if (process.versions.electron) {
    const fs = require("original-fs");
    const { app } = require("electron");
    const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    app.setPath("userData", path.join(config.root, "userData"));
    const events = global.__liteEvents = [];
    const report = { channel: config.channel, mode: config.mode, electron: process.versions.electron };
    const finish = (error) => {
        fs.writeFileSync(config.report, JSON.stringify({ ...report, events, passed: !error, error: error?.stack }, null, 2));
        app.exit(error ? 1 : 0);
    };
    try {
        const archive = path.join(config.resources, "_app.asar");
        assert.equal(require("node:fs").statSync(archive).isDirectory(), true);
        assert.equal(fs.lstatSync(archive).isFile(), true);
        assert.equal(app.isReady(), false);
        const originalEmit = app.emit;
        if (config.mode === "vanilla") process.argv.push("--vanilla");
        require(path.join(config.resources, "app.asar"));
        const normal = config.mode === "runtime";
        assert.deepEqual(events, normal ? ["ipc", "native"] : ["original"]);
        assert.equal(app.isReady(), false, "bootstrap must finish before Electron ready");
        assert.equal(app.emit, originalEmit, "never intercept Electron readiness");
        app.whenReady().then(() => {
            try {
                assert.deepEqual(events, normal
                    ? ["ipc", "native", "will-finish-launching", "ready", "csp", "update"]
                    : ["original"]);
                assert.equal(app.emit, originalEmit);
                finish();
            } catch (error) { finish(error); }
        }, finish);
    } catch (error) { finish(error); }
} else {
    const fs = require("node:fs");
    const os = require("node:os");
    const { spawnSync } = require("node:child_process");
    const { pathToFileURL } = require("node:url");
    (async () => {
        assert.equal(process.platform, "win32", "Windows host path validation is intentional");
        assert.equal(process.argv.length, 3, "Provide a standalone Electron executable");
        const electron = path.resolve(process.argv[2]);
        assert.equal(path.basename(electron).toLowerCase(), "electron.exe", "Never launch a Discord executable");
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "SupportTemplates-lite-electron-"));
        const repo = path.resolve(__dirname, "..");
        const { createLoaderAsar } = await import(pathToFileURL(path.join(repo, "standalone/asar.mjs")));
        const ts = require("typescript");
        const main = ts.transpileModule(fs.readFileSync(path.join(repo, "standalone/runtime/main.ts"), "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText;
        const loader = fs.readFileSync(path.join(repo, "standalone/runtime/loader.cjs"), "utf8");
        const entry = path.join(root, "main.cjs");
        fs.copyFileSync(__filename, entry);
        const put = (file, content) => {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, content);
        };
        const results = [];
        for (const channel of ["stable", "canary"]) for (const mode of ["runtime", "vanilla", "missing-runtime"]) {
            const caseRoot = path.join(root, `${channel}-${mode}`);
            const local = path.join(caseRoot, "localappdata");
            const resources = path.join(local, channel === "stable" ? "Discord" : "DiscordCanary", "app-1.0.1", "resources");
            const owned = path.join(local, "SupportTemplates", "channels", channel);
            const runtime = path.join(owned, "versions", "1.0.0", "runtime");
            put(path.join(resources, "_app.asar"), createLoaderAsar({
                "package.json": JSON.stringify({ name: "fixture-only", main: "index.js" }),
                "index.js": 'require("node:assert/strict").equal(require("electron").app.isReady(), false); global.__liteEvents.push("original");'
            }));
            put(path.join(resources, "app.asar"), createLoaderAsar({
                "package.json": JSON.stringify({ name: "support-templates-loader", main: "index.js" }),
                "index.js": loader
            }));
            put(path.join(resources, "support-templates.json"), JSON.stringify({
                schema: 1, product: "SupportTemplates", channel, runtime, dataDir: path.join(owned, "data")
            }));
            if (mode !== "missing-runtime") {
                put(path.join(runtime, "preload.js"), "// fixture; never loaded");
                put(path.join(runtime, "patcher.js"), `
const app = require("electron").app, events = global.__liteEvents;
const resolveFixture = name => {
    if (name === "./ipc") { events.push("ipc"); return {}; }
    if (name === "electron") return { app };
    if (name === "@main/csp") return { initCsp() { events.push("csp"); } };
    if (name === "@main/utils/constants") return { IS_VANILLA: false };
    if (name === "./update") return { startAutoUpdate() { events.push("update"); return new Promise(() => {}); } };
    if (name === "../main/patcher") {
        require("node:assert/strict").equal(app.isReady(), false);
        events.push("native");
        app.on("will-finish-launching", () => events.push("will-finish-launching"));
        app.on("ready", () => events.push("ready"));
        return {};
    }
    throw Error("Unexpected fixture module: " + name);
};
new Function("require", "exports", ${JSON.stringify(main)})(resolveFixture, {});
`);
            }
            const report = path.join(caseRoot, "result.json");
            const configFile = path.join(caseRoot, "config.json");
            put(configFile, JSON.stringify({ root: caseRoot, resources, channel, mode, report }));
            const env = { ...process.env, APPDATA: path.join(caseRoot, "appdata"), LOCALAPPDATA: local };
            for (const key of Object.keys(env)) if (/^ELECTRON_|^NODE_OPTIONS$/i.test(key)) delete env[key];
            const child = spawnSync(electron, [entry, configFile], { cwd: caseRoot, env, windowsHide: true, timeout: 20000, stdio: "pipe" });
            const result = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, "utf8")) : { passed: false, error: child.error?.message };
            results.push(result);
            fs.writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 2));
            assert.equal(child.status, 0, JSON.stringify(result));
            assert.equal(result.passed, true, JSON.stringify(result));
            console.log(`PASS ${channel} ${mode}: physical ASAR and synchronous startup (Electron ${result.electron})`);
        }
        console.log(`Evidence retained in ${root}`);
    })().catch(error => { console.error(error); process.exitCode = 1; });
}
