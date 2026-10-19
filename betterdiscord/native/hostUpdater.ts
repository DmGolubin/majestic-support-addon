// SPDX-License-Identifier: GPL-3.0-or-later
// Standard BD exposes synchronous filesystem and Net bridges, not native Node.
import * as fs from "fs";
import { createHash, randomBytes } from "crypto";
import { join, dirname, resolve } from "path";
import config from "../../distribution/config.json";
import { assert, compareVersions, inChannel, repository, assetName, validateManifest } from "../../distribution/updater/validation.cjs";
import { receive, validateUrl } from "../../distribution/updater/transport.cjs";
import { installationPaths } from "./paths";
import { api } from "../shims/host";

const MAX_PLUGIN = 32 * 1024 * 1024;
const MAX_JSON = 1024 * 1024;
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const normalized = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);

/** Adapt BD's WHATWG stream to the shared bounded, redirect-validated receiver. */
export function hostTransport(netFetch: (url: string, init: any) => Promise<Response>) {
    return async (url: string, { signal }: { signal: AbortSignal }) => {
        const response = await netFetch(url, { method: "GET", signal, credentials: "omit", redirect: "manual", maxRedirects: 0,
            rejectUnauthorized: true, timeout: null,
            headers: { "User-Agent": "SupportTemplates-Updater/1", Accept: "application/json, application/octet-stream", "Accept-Encoding": "identity" } });
        if (response.redirected || response.url && response.url !== url) {
            await response.body?.cancel().catch(() => {});
            throw new Error("UNEXPECTED_REDIRECT");
        }
        const reader = response.body?.getReader();
        const body = reader && {
            [Symbol.asyncIterator]() { return { next: async () => {
                const result = await reader.read();
                return result.done ? result : { done: false, value: Buffer.from(result.value) };
            } }; },
            destroy() { void reader.cancel().catch(() => {}); }
        };
        return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
    };
}

export function createHostUpdater(options: {
    root: string; config: typeof config; netFetch: (url: string, init: any) => Promise<Response>;
    locks: Pick<LockManager, "request">; onEvent?: (event: any) => void; timeoutMs?: number;
}) {
    const cfg = options.config;
    assert(cfg.schema === 1 && inChannel(cfg.version, cfg.channel), "INVALID_CONFIG");
    const repo = cfg.releaseRepository === null ? null : repository(cfg.releaseRepository);
    const manifestName = assetName(cfg.manifestAsset);
    assert(Number.isFinite(cfg.checkIntervalHours) && cfg.checkIntervalHours >= 1 && cfg.checkIntervalHours <= 168, "INVALID_INTERVAL");
    const root = resolve(options.root), receipt = join(root, "runtime.json");
    const policy = { repo, channel: cfg.channel, variant: "betterdiscord", baseVersion: cfg.version, maxAssetBytes: MAX_PLUGIN, releaseVersion: undefined };
    const transport = hostTransport(options.netFetch);
    const lockName = `SupportTemplates:update:${digest(normalized(root))}`;
    let closed = false, started = false, currentVersion = cfg.version;
    let timer: ReturnType<typeof setInterval> | undefined, active: AbortController | undefined, flight: Promise<any> | undefined;
    const emit = (type: string, extra: any = {}) => {
        const result = { status: type, ...extra };
        try { options.onEvent?.({ type, ...extra }); } catch { /* Observers cannot break storage. */ }
        return result;
    };
    // BD's lstat is actually stat: compare every existing ancestor's canonical path
    // instead. Never use its isSymbolicLink() as evidence that a path is safe.
    function safe(path: string) {
        assert(normalized(path) === normalized(root) || normalized(path).startsWith(normalized(root) + (process.platform === "win32" ? "\\" : "/")), "UNSAFE_PATH");
        for (let current = path;; current = dirname(current)) {
            if (fs.existsSync(current)) assert(normalized(fs.realpathSync(current)) === normalized(current), "UNSAFE_PATH");
            if (dirname(current) === current) break;
        }
    }
    function read(path: string, max: number) {
        safe(path);
        const stat = fs.statSync(path);
        assert(stat.isFile() && stat.size <= max, "INVALID_CACHE_SIZE");
        const bytes = Buffer.from(fs.readFileSync(path));
        assert(bytes.length <= max, "INVALID_CACHE_SIZE");
        return bytes;
    }
    function verify(manifest: any) {
        const asset = validateManifest(manifest, policy);
        assert(asset && asset.kind === "renderer" && asset.name === "SupportTemplates.plugin.js", "INVALID_PLUGIN_ASSET");
        return asset;
    }
    function cached() {
        try {
            const record = JSON.parse(read(receipt, MAX_JSON).toString("utf8"));
            assert(record.schema === 1, "INVALID_RECEIPT");
            const asset = verify(record.manifest);
            if (compareVersions(record.manifest.version, cfg.version) <= 0) return null;
            const path = join(root, `${asset.sha256}.plugin.js`), bytes = read(path, MAX_PLUGIN);
            assert(bytes.length === asset.size && digest(bytes) === asset.sha256, "HASH_MISMATCH");
            return { path, version: record.manifest.version };
        } catch { return null; } // Corruption never prevents loading the bundled runtime.
    }
    function atomic(path: string, bytes: Uint8Array | string) {
        safe(root); fs.mkdirSync(root, { recursive: true, mode: 0o700 }); safe(path);
        const temporary = join(root, `.tmp-${randomBytes(16).toString("hex")}`);
        let created = false;
        try {
            fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 }); created = true;
            safe(temporary); safe(path);
            fs.renameSync(temporary, path); created = false;
        } finally { if (created) { try { fs.unlinkSync(temporary); } catch {} } }
        // No fsync in BD's bridge. A lost write after OS crash falls back to the
        // bundled plugin; every cached load rechecks both length and digest.
    }
    const request = (signal: AbortSignal) => ({ repo, transport, signal, timeoutMs: options.timeoutMs ?? 30000 });
    async function json(url: string, signal: AbortSignal, extra: any) {
        const chunks: Buffer[] = [];
        await receive(url, { ...request(signal), maxBytes: MAX_JSON, ...extra, onChunk: async (b: Buffer) => { chunks.push(b); } });
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    function releaseAsset(release: any, name: string) {
        const matches = release.assets.filter((a: any) => a?.name === name);
        assert(matches.length === 1, "MISSING_OR_DUPLICATE_RELEASE_ASSET");
        const a = matches[0];
        assert(a.state === "uploaded" && Number.isSafeInteger(a.size) && a.size > 0, "INVALID_RELEASE_ASSET");
        validateUrl(a.browser_download_url, { repo, role: "asset", tag: release.tag_name, name });
        return a;
    }
    async function perform(signal: AbortSignal) {
        if (!repo) return emit("disabled");
        const releases: any[] = [];
        for (let page = 1; page <= 3; page++) {
            const list = await json(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, signal, { role: "api", maxBytes: 8 * MAX_JSON });
            assert(Array.isArray(list) && list.length <= 100, "INVALID_RELEASE_LIST"); releases.push(...list);
            if (list.length < 100) break;
        }
        const candidates = releases.filter(r => {
            try { return r.draft === false && r.tag_name.startsWith("v") && inChannel(r.tag_name.slice(1), cfg.channel)
                && r.prerelease === (cfg.channel === "canary") && Array.isArray(r.assets) && r.assets.some((a: any) => a.name === manifestName); }
            catch { return false; }
        }).sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
        const release = candidates[0], previous = cached();
        const effective = previous && compareVersions(previous.version, currentVersion) > 0 ? previous.version : currentVersion;
        if (!release || compareVersions(release.tag_name.slice(1), effective) <= 0)
            return previous && compareVersions(previous.version, currentVersion) > 0 ? emit("pending", { version: previous.version }) : emit("up-to-date", { version: currentVersion });
        const manifestAsset = releaseAsset(release, manifestName);
        const manifest = await json(manifestAsset.browser_download_url, signal, { role: "asset", tag: release.tag_name, name: manifestName, expectedSize: manifestAsset.size });
        const asset = validateManifest(manifest, { ...policy, releaseVersion: release.tag_name.slice(1) });
        if (!asset) return emit("up-to-date", { version: currentVersion });
        verify(manifest);
        const downloadable = releaseAsset(release, asset.name);
        assert(downloadable.size === asset.size, "SIZE_MISMATCH");
        const chunks: Buffer[] = [];
        await receive(downloadable.browser_download_url, { ...request(signal), role: "asset", tag: release.tag_name, name: asset.name,
            maxBytes: MAX_PLUGIN, expectedSize: asset.size, onChunk: async (b: Buffer) => { chunks.push(b); } });
        const bytes = Buffer.concat(chunks);
        assert(digest(bytes) === asset.sha256, "HASH_MISMATCH");
        assert(!closed && !signal.aborted, "ABORTED");
        // Synchronous commit under the Web Lock; no yield between code and receipt.
        atomic(join(root, `${asset.sha256}.plugin.js`), bytes);
        atomic(receipt, JSON.stringify({ schema: 1, manifest }));
        return emit("pending", { version: manifest.version });
    }
    function check(): Promise<any> {
        if (closed) return Promise.reject(new Error("STOPPED"));
        if (flight) return flight;
        const controller = new AbortController(); active = controller;
        flight = options.locks.request(lockName, { mode: "exclusive", ifAvailable: true }, lock => {
            assert(!closed && !controller.signal.aborted, "ABORTED");
            return lock ? perform(controller.signal) : emit("busy");
        }).catch(error => { if (!closed) emit("error"); throw error; }).finally(() => { active = undefined; flight = undefined; });
        return flight;
    }
    return {
        cached, check,
        selected(version: string) { currentVersion = version; },
        start() {
            if (closed || started) return; started = true;
            void check().catch(() => {});
            timer = setInterval(() => { void check().catch(() => {}); }, cfg.checkIntervalHours * 3600000);
        },
        async stop() { closed = true; if (timer) clearInterval(timer); active?.abort(); await flight?.catch(() => {}); }
    };
}

export async function prepareHostUpdates(isStartup: () => boolean, onEvent: (event: any) => void) {
    if (process.platform !== "win32") return null;
    if (typeof api().Net?.fetch !== "function" || !globalThis.navigator?.locks?.request
        || !["readFileSync", "writeFileSync", "mkdirSync", "statSync", "realpathSync", "renameSync", "unlinkSync", "existsSync"].every(name => typeof (fs as any)[name] === "function")) {
        onEvent({ type: "unsupported-host" }); return null;
    }
    const installation = installationPaths();
    const root = join(installation.root, "host-updates", digest(JSON.stringify([config.releaseRepository, config.channel])));
    const updater = createHostUpdater({ root, config, locks: navigator.locks, netFetch: (url, init) => api().Net.fetch(url, init), onEvent });
    if (!isStartup()) { await updater.stop(); return null; }
    const cached = updater.cached();
    let Plugin = null;
    try {
        // BD supports loading an absolute .js path. Only verified bytes enter its
        // loader, before mounting any UI; downloads never evaluate code themselves.
        Plugin = cached ? require(cached.path) : null;
        if (Plugin && (typeof Plugin !== "function" || Plugin.prototype.getVersion?.() !== cached!.version
            || !["startBundledRuntime", "stopBundledRuntime", "getSettingsPanel", "getBundledSettings"].every(name => typeof Plugin.prototype[name] === "function"))) throw new Error("INCOMPATIBLE_RUNTIME");
        if (Plugin) updater.selected(cached!.version);
    } catch { Plugin = null; onEvent({ type: "error" }); }
    return { updater, Plugin };
}
