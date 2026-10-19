// SPDX-License-Identifier: GPL-3.0-or-later
import { join } from "node:path";
import { createHash } from "node:crypto";
import config from "../../distribution/config.json";
import { createUpdater } from "../../distribution/updater/index.cjs";
import { createFileAdapter } from "../../distribution/updater/adapters.cjs";
import { compareVersions, validateManifest } from "../../distribution/updater/validation.cjs";
import * as disk from "../../distribution/updater/storage.cjs";
import { installationPaths } from "./paths";

const MAX_PLUGIN = 32 * 1024 * 1024;
/** Runtime always refuses apply, including a check finishing while UI is active.
 * Install into a private cache OUTSIDE BdApi.Plugins.folder. Its watcher can reload
 * on any .plugin.js replacement; writing the user's plugin file is never safe.
 */
export function cacheAdapter(root: string, isStartup: () => boolean) {
    return {
        canApplyNative: async () => false,
        async apply(context: any) {
            if (context.phase !== "startup" || !isStartup()) return { applied: false, reason: "Waiting for next plugin startup" };
            if (context.variant !== "betterdiscord" || context.asset.kind !== "renderer") throw new Error("Unsupported BetterDiscord update");
            const asset = validateManifest(context.manifest, { repo: config.releaseRepository, channel: config.channel,
                variant: "betterdiscord", baseVersion: config.version, maxAssetBytes: MAX_PLUGIN });
            if (!asset || asset.name !== "SupportTemplates.plugin.js") throw new Error("Invalid plugin asset");
            await disk.prepare(root);
            const targetPath = join(root, `${asset.sha256}.plugin.js`);
            await createFileAdapter({ targetPath }).apply({ ...context, asset });
            if (!isStartup()) return { applied: false, reason: "Startup cancelled" };
            await disk.atomicJson(join(root, "runtime.json"), { schema: 1, manifest: context.manifest });
            return { applied: true };
        }
    };
}

export async function cachedRuntime(root: string) {
    const record = await disk.readJson(join(root, "runtime.json"));
    if (!record) return null;
    if (record.schema !== 1) throw new Error("Invalid runtime receipt");
    const asset = validateManifest(record.manifest, { repo: config.releaseRepository, channel: config.channel,
        variant: "betterdiscord", baseVersion: config.version, maxAssetBytes: MAX_PLUGIN });
    if (!asset || asset.kind !== "renderer" || asset.name !== "SupportTemplates.plugin.js") throw new Error("Invalid runtime asset");
    if (compareVersions(record.manifest.version, config.version) <= 0) return null;
    const path = join(root, `${asset.sha256}.plugin.js`);
    await disk.verify(path, asset);
    return { path, version: record.manifest.version };
}

export async function prepareUpdates(isStartup: () => boolean, onEvent: (event: any) => void) {
    if (process.platform !== "win32") return null; // parent manifest currently targets Windows
    const installation = installationPaths();
    const binding = createHash("sha256").update(JSON.stringify([config.releaseRepository, config.channel])).digest("hex");
    const root = join(installation.root, "updates", binding);
    const runtimeRoot = join(root, "runtime");
    const adapter = cacheAdapter(runtimeRoot, isStartup);
    const previous = await cachedRuntime(runtimeRoot).catch(() => null);
    const makeUpdater = (currentVersion: string) => createUpdater({ config, variant: "betterdiscord", currentVersion,
        baseVersion: config.version, stagingDir: join(root, "staging"), maxAssetBytes: MAX_PLUGIN, adapter, onEvent });
    const updater = makeUpdater(previous?.version ?? config.version);
    try {
        try { await updater.applyPending({ phase: "startup" }); }
        catch {
            // A corrupt pending receipt must not permanently disable checks. The
            // engine's next check quarantines it and can download a fresh asset.
            try { onEvent({ type: "error" }); } catch { /* Observers cannot break recovery. */ }
        }
        if (!isStartup()) { await updater.stop(); return null; }
        const cached = await cachedRuntime(runtimeRoot).catch(() => null);
        // No network code is evaluated before manifest, size, hash and repository checks.
        const Plugin = cached ? require(cached.path) : null;
        if (Plugin && (typeof Plugin !== "function" || Plugin.prototype.getVersion?.() !== cached!.version
            || !["startBundledRuntime", "stopBundledRuntime", "getSettingsPanel", "getBundledSettings"].every(name => typeof Plugin.prototype[name] === "function"))) throw new Error("Incompatible cached runtime");
        return { updater, Plugin };
    } catch {
        await updater.stop();
        if (!isStartup()) return null;
        try { onEvent({ type: "error" }); } catch { /* Observers cannot break recovery. */ }
        // Verified bytes can still have an incompatible runtime contract. Keep
        // repair checks alive, using the bundled runtime that will actually run.
        return { updater: makeUpdater(config.version), Plugin: null };
    }
}
