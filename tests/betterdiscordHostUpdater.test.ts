import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { loadAdapter, source } from "./betterdiscordHarness";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function futureVersion(config: { version: string; channel: string }, offset = 1n) {
    return `${BigInt(config.version.split(".")[0]) + offset}.0.0${config.channel === "canary" ? "-canary.1" : ""}`;
}
function fixture() {
    const root = fs.mkdtempSync(join(tmpdir(), "stx-bd-host-")); dirs.push(root);
    const config = JSON.parse(source("distribution/config.json"));
    const version = futureVersion(config);
    const bytes = Buffer.from("module.exports = class VerifiedRuntime {};");
    const asset = { variant: "betterdiscord", platform: "win32", kind: "renderer", name: "SupportTemplates.plugin.js", size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") };
    const manifest = { schema: 1, product: "SupportTemplates", repository: config.releaseRepository, channel: config.channel, version, assets: [asset] };
    const url = (name: string) => `https://github.com/${config.releaseRepository}/releases/download/v${version}/${name}`;
    const release = { draft: false, prerelease: config.channel === "canary", tag_name: `v${version}`, assets: [
        { name: config.manifestAsset, state: "uploaded", size: Buffer.byteLength(JSON.stringify(manifest)), browser_download_url: url(config.manifestAsset) },
        { name: asset.name, state: "uploaded", size: asset.size, browser_download_url: url(asset.name) }
    ] };
    const net = vi.fn(async (input: string, _init: any): Promise<Response> => {
        if (input.startsWith("https://api.github.com/")) return new Response(JSON.stringify([release]));
        if (input === url(config.manifestAsset)) return new Response(JSON.stringify(manifest));
        if (input === url(asset.name)) return new Response(bytes);
        throw new Error("Unexpected request");
    });
    const events: any[] = [];
    let locked = false;
    const locks = { request: async (_name: string, _options: any, fn: any) => {
        if (locked) return fn(null);
        locked = true; try { return await fn({}); } finally { locked = false; }
    } };
    // This is the actual surface of the BD filesystem bridge, with no fs.promises,
    // descriptors, hard links, or true lstat. Never quietly delegate to native Node.
    const bridge = Object.fromEntries(["readFileSync", "writeFileSync", "mkdirSync", "statSync", "realpathSync", "renameSync", "unlinkSync", "existsSync"].map(k => [k, (...args: any[]) => {
        try { return (fs as any)[k](...args); } catch (error) { throw new Error((error as Error).message); } // contextBridge drops custom Error.code
    }]));
    const exports = loadAdapter("native/hostUpdater.ts", { fs: bridge, crypto: { createHash, randomBytes: (n: number) => Buffer.alloc(n, 7) } });
    const make = () => exports.createHostUpdater({ root, config, netFetch: net, locks, onEvent: (e: any) => events.push(e) });
    return { root, config, version, bytes, asset, manifest, release, net, events, make, exports, url };
}
describe("standard BetterDiscord updater", () => {
    it("stages verified bytes outside plugins, restores after restart, and never evaluates during download", async () => {
        const f = fixture(); const updater = f.make();
        expect(updater.cached()).toBeNull();
        expect(await updater.check()).toMatchObject({ status: "pending", version: f.version });
        const restored = f.make().cached();
        expect(restored.version).toBe(f.version);
        expect(fs.readFileSync(restored.path)).toEqual(f.bytes);
        expect(fs.readdirSync(f.root).sort()).toEqual([`${f.asset.sha256}.plugin.js`, "runtime.json"].sort());
        expect(await updater.check()).toMatchObject({ status: "pending" });
        expect(f.net).toHaveBeenCalledTimes(4); // list again; existing verified cache skips both downloads
        for (const [, init] of f.net.mock.calls) expect(init).toMatchObject({ redirect: "manual", maxRedirects: 0, credentials: "omit", rejectUnauthorized: true });
        await updater.stop();
    });
    it("refuses hash corruption and foreign manifests, preserving the last good runtime", async () => {
        const f = fixture(); const updater = f.make(); await updater.check();
        const saved = fs.readFileSync(join(f.root, "runtime.json"), "utf8");
        const nextVersion = futureVersion(f.config, 2n);
        f.manifest.version = nextVersion; f.release.tag_name = `v${nextVersion}`;
        f.release.assets.forEach(a => { a.browser_download_url = a.browser_download_url.replace(`/v${f.version}/`, `/v${nextVersion}/`); });
        // Mismatched manifest must fail before any code can be committed.
        f.manifest.repository = "attacker/repo";
        f.release.assets[0].size = Buffer.byteLength(JSON.stringify(f.manifest));
        f.net.mockImplementation(async input => new Response(JSON.stringify(input.startsWith("https://api.github.com/") ? [f.release] : f.manifest)));
        await expect(updater.check()).rejects.toThrow("INVALID_MANIFEST");
        expect(fs.readFileSync(join(f.root, "runtime.json"), "utf8")).toBe(saved);
        fs.writeFileSync(updater.cached().path, "tampered");
        expect(updater.cached()).toBeNull();
        await updater.stop();
    });
    it("rejects wrong bytes before publishing any receipt", async () => {
        const f = fixture(); const initial = f.net.getMockImplementation()!;
        f.net.mockImplementation((url, init) => url === f.url(f.asset.name) ? Promise.resolve(new Response(Buffer.alloc(f.bytes.length))) : initial(url, init));
        await expect(f.make().check()).rejects.toThrow();
        expect(fs.existsSync(join(f.root, "runtime.json"))).toBe(false);
    });
    it("allows only GitHub release redirects, with bounded responses and anonymous private-repo failure", async () => {
        const f = fixture();
        f.net.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://attacker.test/code" } }));
        await expect(f.make().check()).rejects.toThrow(); expect(f.net).toHaveBeenCalledTimes(1);
        f.net.mockClear(); f.net.mockResolvedValue(new Response("private", { status: 404 }));
        await expect(f.make().check()).rejects.toThrow();
        expect(fs.readdirSync(f.root)).toEqual([]);
    });
    it("follows a permitted release CDN redirect and rejects oversized bodies and redirected cache directories", async () => {
        const f = fixture(); const initial = f.net.getMockImplementation()!;
        const cdn = "https://release-assets.githubusercontent.com/github-production-release-asset/fixture?signature=test";
        f.net.mockImplementation((url, init) => url === f.url(f.asset.name)
            ? Promise.resolve(new Response(null, { status: 302, headers: { location: cdn } }))
            : url === cdn ? Promise.resolve(new Response(f.bytes)) : initial(url, init));
        await f.make().check(); expect(f.net.mock.calls.some(([url]) => url === cdn)).toBe(true);
        const other = fixture(); const original = other.net.getMockImplementation()!;
        other.net.mockImplementation((url, init) => url === other.url(other.asset.name)
            ? Promise.resolve(new Response(Buffer.alloc(other.asset.size + 1))) : original(url, init));
        await expect(other.make().check()).rejects.toThrow("SIZE_MISMATCH");
        expect(fs.readdirSync(other.root)).toEqual([]);
        const outside = fs.mkdtempSync(join(tmpdir(), "stx-bd-outside-")); dirs.push(outside);
        fs.symlinkSync(outside, join(other.root, "redirected"), process.platform === "win32" ? "junction" : "dir");
        other.net.mockImplementation(original);
        const redirected = other.exports.createHostUpdater({ root: join(other.root, "redirected"), config: other.config,
            netFetch: other.net, locks: { request: async (_name: any, _options: any, callback: any) => callback({}) } });
        await expect(redirected.check()).rejects.toThrow("UNSAFE_PATH");
        expect(fs.readdirSync(outside)).toEqual([]);
    });
    it("stop cancels an in-flight request and prevents a late commit", async () => {
        const f = fixture(); let complete!: (value: Response) => void;
        f.net.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
        const updater = f.make(); const checking = updater.check();
        await vi.waitFor(() => expect(f.net).toHaveBeenCalledOnce());
        await updater.stop(); await expect(checking).rejects.toThrow();
        complete(new Response(JSON.stringify([f.release])));
        expect(fs.readdirSync(f.root)).toEqual([]);
    });
    it("uses one check at a time and retries on a timer without reloading the running plugin", async () => {
        vi.useFakeTimers(); const f = fixture(); const updater = f.make();
        updater.start(); updater.start();
        await vi.advanceTimersByTimeAsync(1);
        expect(f.events.some(e => e.type === "pending")).toBe(true);
        const calls = f.net.mock.calls.length;
        await vi.advanceTimersByTimeAsync(f.config.checkIntervalHours * 3600000);
        expect(f.net.mock.calls.length).toBe(calls + 1);
        await updater.stop(); await vi.advanceTimersByTimeAsync(f.config.checkIntervalHours * 3600000);
        expect(f.net.mock.calls.length).toBe(calls + 1);
    });
});
