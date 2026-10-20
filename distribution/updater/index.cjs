'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const v = require('./validation.cjs');
const http = require('./transport.cjs');
const disk = require('./storage.cjs');

const DEFAULTS = Object.freeze({ intervalHours: 6, timeoutMs: 30000, maxAssetBytes: 256 * 1024 * 1024, maxPages: 3 });
function createUpdater(options) {
    const { variant, adapter, transport = http.defaultTransport, onEvent = () => {} } = options;
    const config = { ...options.config };
    v.assert(config.schema === 1 && ['stable', 'canary'].includes(config.channel), 'INVALID_CONFIG');
    v.assert(v.VARIANTS.includes(variant), 'INVALID_VARIANT');
    v.assert(config.releaseRepository === null || typeof config.releaseRepository === 'string', 'INVALID_REPOSITORY');
    const repo = config.releaseRepository === null ? null : v.repository(config.releaseRepository);
    const name = v.assetName(config.manifestAsset);
    const channel = config.channel;
    let currentVersion = options.currentVersion ?? config.version;
    const baseVersion = options.baseVersion ?? config.version;
    v.assert(v.inChannel(currentVersion, channel) && v.inChannel(baseVersion, channel), 'CHANNEL_MISMATCH');
    v.assert(adapter && typeof adapter.apply === 'function', 'APPLY_ADAPTER_REQUIRED');
    v.assert(typeof options.stagingDir === 'string' && path.isAbsolute(options.stagingDir), 'ABSOLUTE_PATH_REQUIRED');
    const root = path.resolve(options.stagingDir);
    const intervalHours = config.checkIntervalHours ?? DEFAULTS.intervalHours;
    v.assert(Number.isFinite(intervalHours) && intervalHours >= 1 && intervalHours <= 168, 'INVALID_INTERVAL');
    const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    const maxAssetBytes = options.maxAssetBytes ?? DEFAULTS.maxAssetBytes;
    v.assert(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 120000, 'INVALID_TIMEOUT');
    v.assert(Number.isSafeInteger(maxAssetBytes) && maxAssetBytes > 0 && maxAssetBytes <= DEFAULTS.maxAssetBytes, 'INVALID_ASSET_LIMIT');
    const pendingPath = path.join(root, 'pending.json');
    const appliedPath = path.join(root, 'applied.json');
    let queue = Promise.resolve(), timer = null, running = false, generation = 0, active = null;
    const emit = event => { try { onEvent(Object.freeze(event)); } catch { /* UI observers cannot break installation. */ } };
    const result = (status, extra = {}) => { const value = { status, ...extra }; emit({ type: status, ...extra }); return value; };
    const serialized = action => {
        const operation = queue.then(() => disk.locked(root, action));
        queue = operation.catch(() => {});
        return operation;
    };
    const policy = { repo, channel, variant, baseVersion, maxAssetBytes };
    const request = signal => ({ transport, signal, timeoutMs, repo });

    // The selected installed runtime is authoritative. A receipt may describe
    // a failed startup/rolled-back installation and must never suppress repair.
    const effectiveVersion = () => currentVersion;
    async function pending() {
        const record = await disk.readJson(pendingPath);
        if (!record) return null;
        v.assert(record.schema === 1 && record.variant === variant && typeof record.id === 'string' && /^[a-f0-9-]{36}$/.test(record.id), 'INVALID_RECORD');
        const asset = v.validateManifest(record.manifest, policy);
        v.assert(asset, 'VARIANT_MISMATCH');
        const assetPath = path.join(root, record.id, asset.name);
        await disk.verify(assetPath, asset);
        return { assetPath, manifest: record.manifest, asset, version: record.manifest.version, variant, channel };
    }
    async function apply(phase, token) {
        v.assert(token === generation, 'ABORTED');
        const context = await pending();
        v.assert(token === generation, 'ABORTED');
        if (!context) return result('idle');
        const effective = await effectiveVersion();
        v.assert(token === generation, 'ABORTED');
        if (v.compareVersions(context.version, effective) <= 0) {
            await fs.unlink(pendingPath);
            return result('up-to-date', { version: effective });
        }
        context.phase = phase;
        if (context.asset.kind === 'native') {
            if (phase === 'runtime' || typeof adapter.canApplyNative !== 'function' || await adapter.canApplyNative(context) !== true) {
                return result('pending-restart', { version: context.version });
            }
            // The gate may wait for other processes; do not rely on the earlier hash.
            await disk.verify(context.assetPath, context.asset);
        }
        // stop() invalidates queued applies and gates still waiting for a safe
        // native lifecycle point. Once apply starts, finish its receipt normally.
        v.assert(token === generation, 'ABORTED');
        const applied = await adapter.apply(context);
        if (applied?.applied !== true) return result('pending', { version: context.version });
        // Informational receipt only; actual selected runtime remains authoritative
        // on the next instance, including after a startup fallback or manual rollback.
        await disk.atomicJson(appliedPath, { schema: 1, repository: repo, variant, channel, version: context.version });
        currentVersion = context.version;
        await fs.unlink(pendingPath);
        return result('applied', { version: context.version, kind: context.asset.kind, reloadRequired: context.asset.kind === 'renderer' });
    }
    async function discover(signal) {
        const releases = [];
        for (let page = 1; page <= DEFAULTS.maxPages; page++) {
            const list = await http.json(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
                ...request(signal), role: 'api', maxBytes: 8 * 1024 * 1024
            });
            v.assert(Array.isArray(list) && list.length <= 100, 'INVALID_RELEASE_LIST');
            releases.push(...list);
            if (list.length < 100) break;
        }
        const candidates = releases.filter(release => {
            if (!release || release.draft !== false || typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) return false;
            try {
                const value = release.tag_name.slice(1);
                return v.inChannel(value, channel) && release.prerelease === (channel === 'canary') && Array.isArray(release.assets) && release.assets.some(a => a.name === name);
            } catch { return false; }
        });
        candidates.sort((a, b) => v.compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
        return candidates[0] ?? null;
    }
    function releaseAsset(release, assetName) {
        const matches = release.assets.filter(a => a && a.name === assetName);
        v.assert(matches.length === 1, 'MISSING_OR_DUPLICATE_RELEASE_ASSET');
        const asset = matches[0];
        v.assert(asset.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0, 'INVALID_RELEASE_ASSET');
        http.validateUrl(asset.browser_download_url, { repo, role: 'asset', tag: release.tag_name, name: assetName });
        return asset;
    }
    async function stage(manifest, asset, url, tag, signal) {
        const id = randomUUID(), work = path.join(root, `.work-${id}`), destination = path.join(root, id);
        await fs.mkdir(work, { mode: 0o700 });
        try {
            const target = path.join(work, asset.name);
            const file = await fs.open(target, 'wx', 0o600);
            const hash = createHash('sha256');
            try {
                await http.receive(url, {
                    ...request(signal), role: 'asset', tag, name: asset.name, maxBytes: maxAssetBytes, expectedSize: asset.size,
                    onChunk: async chunk => { hash.update(chunk); await file.writeFile(chunk); }
                });
                v.assert(hash.digest('hex') === asset.sha256, 'HASH_MISMATCH');
                await file.sync();
            } finally { await file.close(); }
            await disk.writeDurable(path.join(work, 'manifest.json'), JSON.stringify(manifest));
            await fs.rename(work, destination);
            await disk.atomicJson(pendingPath, { schema: 1, id, variant, manifest });
            return result('staged', { version: manifest.version, kind: asset.kind });
        } finally {
            // Only this operation's newly-created UUID directory may be removed.
            await disk.safePath(work);
            await fs.rm(work, { recursive: true, force: true });
        }
    }
    async function checkInternal(signal, token) {
        try {
            let old;
            try { old = await pending(); }
            catch (error) {
                const corrupt = error instanceof SyntaxError || [
                    'ENOENT', 'EISDIR', 'ENOTDIR', 'SYMLINK_REFUSED', 'INVALID_RECORD', 'SIZE_MISMATCH', 'HASH_MISMATCH',
                    'INVALID_MANIFEST', 'CHANNEL_MISMATCH', 'INVALID_VERSION',
                    'INVALID_ASSETS', 'INVALID_ASSET', 'INVALID_ASSET_NAME',
                    'INVALID_ASSET_SIZE', 'INVALID_HASH', 'DUPLICATE_VARIANT',
                    'BASE_VERSION_MISMATCH', 'VARIANT_MISMATCH'
                ].includes(error.code);
                if (!corrupt) throw error;
                // Quarantine only metadata, never follow or recursively delete
                // paths supplied by a corrupt record. Preserve bytes for diagnosis.
                // rename moves the directory entry itself, including a hostile
                // symlink; validate the trusted parent without following it.
                await disk.safePath(root);
                await fs.rename(pendingPath, path.join(root, `.invalid-pending-${randomUUID()}.json`)).catch(e => {
                    if (e.code !== 'ENOENT') throw e;
                });
                emit({ type: 'cache-invalid', code: error instanceof SyntaxError ? 'INVALID_RECORD' : error.code });
                old = null;
            }
            const effective = await effectiveVersion();
            const release = await discover(signal);
            if (!release || v.compareVersions(release.tag_name.slice(1), effective) <= 0) return result('up-to-date', { version: effective });
            if (old && v.compareVersions(old.version, release.tag_name.slice(1)) >= 0) {
                return old.asset.kind === 'renderer' ? apply('runtime', token) : result('pending-restart', { version: old.version });
            }
            const metadata = releaseAsset(release, name);
            v.assert(metadata.size <= 1024 * 1024, 'MANIFEST_TOO_LARGE');
            const manifest = await http.json(metadata.browser_download_url, {
                ...request(signal), role: 'asset', tag: release.tag_name, name, maxBytes: 1024 * 1024, expectedSize: metadata.size
            });
            const asset = v.validateManifest(manifest, { ...policy, releaseVersion: release.tag_name.slice(1) });
            if (!asset) return result('variant-unavailable');
            const released = releaseAsset(release, asset.name);
            v.assert(released.size === asset.size, 'SIZE_MISMATCH');
            if (released.digest != null) v.assert(released.digest === `sha256:${asset.sha256}`, 'HASH_MISMATCH');
            const staged = await stage(manifest, asset, released.browser_download_url, release.tag_name, signal);
            return asset.kind === 'renderer' ? apply('runtime', token) : staged;
        } catch (error) {
            if (error.code === 'HTTP_STATUS' && [403, 404, 429].includes(error.status)) return result('unavailable', { httpStatus: error.status });
            throw error;
        }
    }
    function check() {
        if (!repo) return Promise.resolve(result('disabled'));
        const token = generation;
        return serialized(async () => {
            v.assert(token === generation, 'ABORTED');
            const controller = new AbortController(); active = controller;
            try { return await checkInternal(controller.signal, token); }
            finally { if (active === controller) active = null; }
        });
    }
    async function tick(token) {
        if (!running || token !== generation) return;
        try { await check(); }
        catch (error) { emit({ type: 'error', code: /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'UPDATE_FAILED' }); }
        if (running && token === generation) {
            timer = setTimeout(() => { void tick(token); }, intervalHours * 3600000 * (0.9 + Math.random() * 0.2));
            timer.unref?.();
        }
    }
    return Object.freeze({
        check,
        start() { if (running || !repo) return; running = true; void tick(++generation); },
        async stop() { running = false; generation++; clearTimeout(timer); timer = null; active?.abort(); await queue; },
        applyPending({ phase = 'runtime' } = {}) {
            v.assert(['runtime', 'startup', 'app-closed'].includes(phase)
                || (variant === 'vencord' && phase === 'next-startup'), 'INVALID_PHASE');
            const token = generation;
            return repo ? serialized(() => apply(phase, token)) : Promise.resolve(result('disabled'));
        },
        getPending() { return repo ? serialized(pending) : Promise.resolve(null); }
    });
}
module.exports = { createUpdater, compareVersions: v.compareVersions, DEFAULTS };
