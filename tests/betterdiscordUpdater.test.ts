import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { loadAdapter, source, bdRequire } from "./betterdiscordHarness";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "stx-bd-update-")); dirs.push(root);
    const bytes = Buffer.from('/** @name SupportTemplates @version 1.0.1-canary.99 */\nmodule.exports = class {};');
    const config = JSON.parse(source("distribution/config.json"));
    const asset = { variant: "betterdiscord", platform: "win32", kind: "renderer", name: "SupportTemplates.plugin.js", size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") };
    const manifest = { schema: 1, product: "SupportTemplates", repository: config.releaseRepository, version: "1.0.1-canary.99", channel: "canary", assets: [asset] };
    const assetPath = join(root, "download.plugin.js"); writeFileSync(assetPath, bytes);
    const cache = join(root, "runtime");
    return { root, bytes, manifest, asset, assetPath, cache, context: { assetPath, manifest, asset, version: manifest.version, variant: "betterdiscord", channel: "canary", phase: "runtime" } };
}

describe("BetterDiscord updater integration", () => {
    it("refuses runtime apply while active, then installs verified code outside the watched plugin file at startup", async () => {
        const f = fixture();
        const { cacheAdapter, cachedRuntime } = loadAdapter("native/updater.ts");
        let startup = true;
        const adapter = cacheAdapter(f.cache, () => startup);
        // Even a runtime request before mount is refused; phase matters independently.
        expect(await adapter.apply(f.context)).toMatchObject({ applied: false });
        expect(readdirSync(f.root)).toEqual(["download.plugin.js"]);
        startup = false;
        expect(await adapter.apply({ ...f.context, phase: "startup" })).toMatchObject({ applied: false });
        startup = true;
        expect(await adapter.apply({ ...f.context, phase: "startup" })).toEqual({ applied: true });
        const selected = await cachedRuntime(f.cache);
        expect(selected.version).toBe("1.0.1-canary.99");
        expect(readFileSync(selected.path)).toEqual(f.bytes);
        expect(selected.path).toContain(f.asset.sha256);
        expect(readFileSync(f.assetPath)).toEqual(f.bytes);
        // No watcher write or reload is possible in the current-runtime branch.
        startup = false;
        expect(await adapter.apply(f.context)).toMatchObject({ applied: false });
    });
    it("cancellation during install cannot publish the runtime receipt", async () => {
        const f = fixture();
        const { cacheAdapter, cachedRuntime } = loadAdapter("native/updater.ts");
        let probes = 0;
        const adapter = cacheAdapter(f.cache, () => ++probes === 1);
        expect(await adapter.apply({ ...f.context, phase: "startup" })).toMatchObject({ applied: false });
        expect(await cachedRuntime(f.cache)).toBeNull();
    });
    it("revalidates size/hash/repository before loading and does not downgrade", async () => {
        const f = fixture();
        const { cacheAdapter, cachedRuntime } = loadAdapter("native/updater.ts");
        const adapter = cacheAdapter(f.cache, () => true);
        writeFileSync(f.assetPath, "tampered");
        await expect(adapter.apply({ ...f.context, phase: "startup" })).rejects.toThrow();
        writeFileSync(f.assetPath, f.bytes);
        await adapter.apply({ ...f.context, phase: "startup" });
        const selected = await cachedRuntime(f.cache);
        writeFileSync(selected.path, "tampered");
        await expect(cachedRuntime(f.cache)).rejects.toThrow();
        writeFileSync(selected.path, f.bytes);
        writeFileSync(join(f.cache, "runtime.json"), JSON.stringify({ schema: 1, manifest: { ...f.manifest, repository: "other/repo" } }));
        await expect(cachedRuntime(f.cache)).rejects.toThrow();
        writeFileSync(join(f.cache, "runtime.json"), JSON.stringify({ schema: 1, manifest: { ...f.manifest, version: "0.1.0-canary.13" } }));
        expect(await cachedRuntime(f.cache)).toBeNull();
    });
    it("shared null-repository checks make no request, and anonymous 404 errors contain no authentication flow", async () => {
        const f = fixture();
        const { createUpdater } = bdRequire("../distribution/updater/index.cjs");
        const transport = vi.fn(async () => { throw Object.assign(new Error("HTTP_404"), { code: "HTTP_404" }); });
        const adapter = { apply: vi.fn(async () => ({ applied: false })) };
        const config = JSON.parse(source("distribution/config.json"));
        const disabled = createUpdater({ config: { ...config, releaseRepository: null }, variant: "betterdiscord", stagingDir: join(f.root, "disabled"), adapter, transport });
        expect(await disabled.check()).toMatchObject({ status: "disabled" });
        expect(transport).not.toHaveBeenCalled();
        await disabled.stop();
        const privateRepo = createUpdater({ config, variant: "betterdiscord", stagingDir: join(f.root, "private"), adapter, transport });
        await expect(privateRepo.check()).rejects.toThrow("HTTP_404");
        expect(transport).toHaveBeenCalledOnce();
        expect(adapter.apply).not.toHaveBeenCalled();
        await privateRepo.stop();
    });
});
