import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bdRequire, evaluate, root } from "./betterdiscordHarness";
import { bridgeFS, ERROR, report, sourceModule, storageModule } from "./a22DiagnosticStorageHarness";
import { createInteractionIdle } from "../src/core/interactionIdle";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        if (!resolve(dir).startsWith(fs.realpathSync(tmpdir()) + sep) || !dir.includes("stx-a22-host-")) throw Error("Unsafe cleanup");
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
function temporary() {
    const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "stx-a22-host-")));
    dirs.push(dir); return dir;
}
function sender(url = "https://canary.discord.com/channels/@me") {
    const frame = { url, parent: null as unknown, detached: false };
    return { senderFrame: frame as typeof frame | null,
        sender: { mainFrame: frame, getURL: () => url, isDestroyed: () => false } };
}
function native() {
    const base = temporary(), profile = join(base, "profile"); fs.mkdirSync(profile);
    const app = { isReady: () => true, getPath: () => profile };
    const create = vi.fn(storageModule.createDiagnosticFileStorage);
    const shell = { openPath: vi.fn(async (_path: string) => "") };
    const modules = {
        "node:crypto": { randomUUID }, "node:fs": fs, "node:fs/promises": {},
        "@main/utils/constants": { DATA_DIR: join(base, "data") }, electron: { app, shell },
        "./panelVaultLock": {}, "./panelVaultNative": {},
        "./diagnosticFileNative": { ...storageModule, createDiagnosticFileStorage: create }
    };
    const api = sourceModule("src/vencord/native.ts", modules, {
        process: { platform: process.platform, once: () => {} }
    });
    return { api, base, app, create, shell };
}

describe("A22 native IPC trust and profile boundary", () => {
    it("opens only the fixed profile directory, creates it before first save, and surfaces shell failure", async () => {
        const h = native(), event = sender();
        await h.api.diagnosticsOpenFolder(event, join(h.base, "arbitrary"));
        const directory = h.shell.openPath.mock.calls[0][0];
        expect(directory).toMatch(/diagnostics[\\/][a-f0-9]{64}$/);
        expect(fs.statSync(directory).isDirectory()).toBe(true);
        expect(fs.readdirSync(directory)).toEqual([]);
        expect(fs.existsSync(join(h.base, "arbitrary"))).toBe(false);
        h.shell.openPath.mockResolvedValue("private path error");
        await expect(h.api.diagnosticsOpenFolder(event)).rejects.toThrow(ERROR);
        const pending = h.api.diagnosticsOpenFolder(event);
        event.sender.mainFrame.url = "https://evil.test";
        await expect(pending).rejects.toThrow(ERROR);
        expect(h.shell.openPath).toHaveBeenCalledTimes(2);
    });
    it("is lazy, derives the real path from main-process userData, never a caller path", async () => {
        const h = native(), event = sender();
        expect(h.create).not.toHaveBeenCalled();
        const saved = await h.api.diagnosticsSave(event, report(), join(h.base, "arbitrary"));
        expect(saved.path).toMatch(/diagnostics[\\/][a-f0-9]{64}[\\/]main\.log$/);
        const loaded = await h.api.diagnosticsLoad(event);
        expect(loaded.path).toBe(saved.path);
        expect(JSON.parse(loaded.state).campaign).toBe("mvp-file-2026-10");
        expect(fs.existsSync(join(h.base, "arbitrary"))).toBe(false);
        expect(h.create).toHaveBeenCalledOnce();
    });
    it.each(["https://discord.com", "https://ptb.discord.com", "https://canary.discord.com"])(
        "allows trusted origin %s", async origin => {
            const h = native();
            await expect(h.api.diagnosticsLoad(sender(origin))).resolves.toMatchObject({ state: null });
        });
    it.each(["https://evil.test", "http://discord.com", "https://discord.com.evil.test", "https://discord.com:8443",
        "https://user:pass@discord.com", "data:text/html,secret", "vesktop://app"])(
        "denies foreign origin %s without creating storage", async origin => {
            const h = native(), event = sender(origin);
            await expect(h.api.diagnosticsLoad(event)).rejects.toThrow(ERROR);
            await expect(h.api.diagnosticsSave(event, report())).rejects.toThrow(ERROR);
            await expect(h.api.diagnosticsOpenFolder(event)).rejects.toThrow(ERROR);
            expect(h.shell.openPath).not.toHaveBeenCalled();
            expect(h.create).not.toHaveBeenCalled();
        });
    it.each(["subframe", "parent", "detached", "destroyed", "no-frame", "different-url"])(
        "denies %s sender", async kind => {
            const h = native(), event = sender();
            if (kind === "subframe") event.senderFrame = { ...event.sender.mainFrame };
            if (kind === "parent") event.sender.mainFrame.parent = {};
            if (kind === "detached") event.sender.mainFrame.detached = true;
            if (kind === "destroyed") event.sender.isDestroyed = () => true;
            if (kind === "no-frame") event.senderFrame = null;
            if (kind === "different-url") event.sender.getURL = () => "https://evil.test";
            await expect(h.api.diagnosticsLoad(event)).rejects.toThrow(ERROR);
            await expect(h.api.diagnosticsSave(event, report())).rejects.toThrow(ERROR);
            await expect(h.api.diagnosticsOpenFolder(event)).rejects.toThrow(ERROR);
            expect(h.shell.openPath).not.toHaveBeenCalled();
            expect(h.create).not.toHaveBeenCalled();
        });
    it("rejects navigation while a lazy module is loading before any disk access", async () => {
        const h = native(), event = sender();
        const pending = h.api.diagnosticsSave(event, report());
        event.sender.mainFrame.url = "https://evil.test";
        await expect(pending).rejects.toThrow(ERROR);
        expect(h.create).not.toHaveBeenCalled();
    });
    it("rejects navigation while load is pending without exposing the path/state", async () => {
        const h = native(), event = sender();
        let complete!: (value: unknown) => void;
        const loaded = new Promise(resolve => { complete = resolve; });
        h.create.mockImplementation(() => ({ load: () => loaded }));
        const pending = h.api.diagnosticsLoad(event);
        for (let i = 0; i < 8; i++) await Promise.resolve();
        event.sender.mainFrame.url = "https://evil.test";
        complete({ path: "private-path", state: "private-state" });
        await expect(pending).rejects.toThrow(ERROR);
    });
    it("isolates two app userData profiles under shared DATA_DIR", async () => {
        const h = native(), event = sender();
        const first = await h.api.diagnosticsSave(event, report());
        const other = join(h.base, "other-profile"); fs.mkdirSync(other);
        h.app.getPath = () => other;
        const second = await h.api.diagnosticsLoad(event);
        expect(first.path).not.toBe(second.path); expect(second.state).toBeNull();
    });
    it("fails generically before app readiness and on private filesystem errors", async () => {
        const h = native(); h.app.isReady = () => false;
        await expect(h.api.diagnosticsLoad(sender())).rejects.toThrow(ERROR);
        h.app.isReady = () => true; h.app.getPath = () => { throw Error("secret path"); };
        await expect(h.api.diagnosticsSave(sender(), report())).rejects.toThrow(ERROR);
    });
});

describe("A22 lazy renderer and BD host bridges", () => {
    it("imports in a plain fixture and rejects unsupported calls generically", async () => {
        const bridge = sourceModule("src/vencord/diagnosticStorage.ts", {});
        await expect(bridge.loadDiagnosticStorage()).rejects.toThrow(ERROR);
        await expect(bridge.saveDiagnosticStorage(report())).rejects.toThrow(ERROR);
        await expect(bridge.openDiagnosticStorageFolder()).rejects.toThrow(ERROR);
    });
    it("dispatches exact method names and hides native exception details", async () => {
        const calls: unknown[] = [];
        const native = { diagnosticsOpenFolder: vi.fn(async () => {}), diagnosticsLoad: async () => ({ path: "actual", state: null }),
            diagnosticsSave: async (r: string) => { calls.push(r); return { path: "actual" }; } };
        const bridge = sourceModule("src/vencord/diagnosticStorage.ts", {}, {
            VencordNative: { pluginHelpers: { SupportTemplates: native } }
        });
        expect(await bridge.loadDiagnosticStorage()).toEqual({ path: "actual", state: null });
        expect(await bridge.saveDiagnosticStorage(report())).toEqual({ path: "actual" });
        expect(calls).toEqual([report()]);
        await bridge.openDiagnosticStorageFolder("ignored caller path");
        expect(native.diagnosticsOpenFolder).toHaveBeenCalledExactlyOnceWith();
        native.diagnosticsOpenFolder.mockRejectedValue(Error("secret token"));
        await expect(bridge.openDiagnosticStorageFolder()).rejects.toThrow(ERROR);
        native.diagnosticsLoad = async () => { throw Error("secret token"); };
        await expect(bridge.loadDiagnosticStorage()).rejects.toThrow(ERROR);
    });
    it("BD wrapper works with only hostUpdater sync filesystem surface", async () => {
        const base = temporary();
        const bridge = sourceModule("betterdiscord/native/diagnosticStorage.ts", {
            fs: bridgeFS(), path: { join }, "./paths": { installationPaths: () => ({ root: base }) },
            "../../src/vencord/diagnosticFileNative": storageModule
        });
        const saved = await bridge.saveDiagnosticStorage(report());
        expect(saved.path).toBe(join(base, "diagnostics", "main.log"));
        expect(JSON.parse((await bridge.loadDiagnosticStorage()).state).schema).toBe(1);
    });
    it("BD leaves native files untouched during a pointer gesture and writes the report afterwards", async () => {
        vi.useFakeTimers();
        try {
            const base = temporary(), gate = createInteractionIdle();
            const bridge = sourceModule("betterdiscord/native/diagnosticStorage.ts", {
                fs: bridgeFS(), path: { join }, "./paths": { installationPaths: () => ({ root: base }) },
                "../../src/vencord/diagnosticFileNative": storageModule,
                "../../src/core/interactionIdle": gate,
            });
            const end = gate.beginInteraction();
            const saved = bridge.saveDiagnosticStorage(report());
            await vi.advanceTimersByTimeAsync(30_000);
            expect(fs.existsSync(join(base, "diagnostics", "main.log"))).toBe(false);
            end();
            await vi.advanceTimersByTimeAsync(150);
            await saved;
            expect(fs.readFileSync(join(base, "diagnostics", "main.log"), "utf8")).toContain("request.start");
        } finally { vi.useRealTimers(); }
    });
    it("BD unsupported imports stay lazy and failed initialization can retry", async () => {
        const modules: Record<string, unknown> = {};
        const bridge = sourceModule("betterdiscord/native/diagnosticStorage.ts", modules);
        await expect(bridge.loadDiagnosticStorage()).rejects.toThrow(ERROR);
        Object.assign(modules, { fs: bridgeFS(), path: { join }, "./paths": { installationPaths: () => ({ root: temporary() }) },
            "../../src/vencord/diagnosticFileNative": storageModule });
        await expect(bridge.saveDiagnosticStorage(report())).resolves.toHaveProperty("path");
    });
    it.each(["node-object", "bd-constructor"] as const)(
        "actual BD build alias bundles lazily with bare supported modules and no fs/promises (%s)", async bufferShape => {
        // In-memory build only: do not write distributions or plugin artifacts.
        const { adapterPlugin } = await import(pathToFileURL(join(root, "betterdiscord/build.mjs")).href);
        const { build } = bdRequire("esbuild");
        const virtual = join(root, "src/vencord/a22-fixture.ts");
        const result = await build({ entryPoints: [virtual], bundle: true, write: false, platform: "node", format: "cjs",
            metafile: true, plugins: [
                { name: "a22-virtual", setup(b: any) {
                    b.onLoad({ filter: /a22-fixture\.ts$/ }, () => ({
                        contents: "export * from './diagnosticStorage';", loader: "ts", resolveDir: join(root, "src/vencord")
                    }));
                    b.onResolve({ filter: /a22-fixture\.ts$/ }, () => ({ path: virtual }));
                } }, adapterPlugin()
            ] });
        const external = Object.values(result.metafile.outputs).flatMap((o: any) => o.imports.filter((i: any) => i.external).map((i: any) => i.path));
        expect(external.every((name: string) => ["fs", "path", "crypto", "buffer", "electron"].includes(name))).toBe(true);
        expect(Object.keys(result.metafile.inputs).some(p => p.endsWith("betterdiscord/native/diagnosticStorage.ts"))).toBe(true);
        const unavailable = new Proxy({}, { get: () => { throw Error("unsupported fs"); } });
        // A real plugin has CommonJS function scope. Evaluating bundle `var
        // crypto = require("crypto")` at global scope would overwrite browser
        // Web Crypto and create a fixture-only getRandomValues failure.
        const code = `(function () {\n${result.outputFiles[0].text}\n})();`;
        const imported = evaluate(code, { fs: unavailable, crypto: unavailable, path: unavailable });
        // Import itself is safe. Invoking either operation fails without leaking host errors.
        await expect(imported.loadDiagnosticStorage()).rejects.toThrow(ERROR);
        await expect(imported.saveDiagnosticStorage(report())).rejects.toThrow(ERROR);
        // Actual installationPaths + the standard bridge's stat-backed lstat.
        const base = temporary(), plugins = join(base, "plugins"); fs.mkdirSync(plugins);
        const supported = evaluate(code, {
            fs: { ...bridgeFS(), lstatSync: fs.statSync },
            buffer: bufferShape === "node-object" ? { Buffer } : Buffer,
            crypto: { createHash: crypto.createHash, randomBytes: crypto.randomBytes }, path
        }, { Buffer: undefined, crypto: crypto.webcrypto, BdApi: { Plugins: { folder: plugins } }, location: { origin: "https://canary.discord.com" } });
        const saved = await supported.saveDiagnosticStorage(report());
        expect(saved.path).toMatch(/SupportTemplates[\\/][a-f0-9]{64}[\\/]diagnostics[\\/]main\.log$/);
        expect(JSON.parse((await supported.loadDiagnosticStorage()).state).campaign).toBe("mvp-file-2026-10");
    });
});
