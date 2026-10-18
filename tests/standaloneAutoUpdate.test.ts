import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createStandaloneController } = require('../standalone/runtime/update-controller.cjs');
const { launchUpdateHelper } = require('../standalone/runtime/update-launcher.cjs');
const { createUpdater } = require('../distribution/updater/index.cjs');
const roots: string[] = [];
const config = { schema: 1, version: '0.1.0-canary.14', channel: 'canary', releaseRepository: 'owner/releases',
    manifestAsset: 'support-templates-update.json', checkIntervalHours: 6 };
function fixture() { const root = mkdtempSync(path.join(os.tmpdir(), 'standalone-update-test-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function harness(options: Record<string, unknown> = {}) {
    const engine = { applyPending: vi.fn().mockResolvedValue({ status: 'idle' }), getPending: vi.fn().mockResolvedValue(null),
        check: vi.fn().mockResolvedValue({ status: 'unavailable' }), stop: vi.fn().mockResolvedValue(undefined) };
    const create = vi.fn((_options: any) => engine), launch = vi.fn().mockResolvedValue(undefined), notify = vi.fn(), onError = vi.fn();
    const setTimer = vi.fn((_callback: () => void, _delay: number) => ({ unref: vi.fn() })), clearTimer = vi.fn();
    const controller = createStandaloneController({ createUpdater: create, config, stagingDir: fixture(),
        launch, notify, onError, setTimer, clearTimer, random: () => 0.5, ...options });
    return { engine, create, launch, notify, onError, setTimer, clearTimer, controller };
}

describe('standalone automatic update controller', () => {
    it('automatically checks, stages and hands off one verified full package without applying native code in the host', async () => {
        const h = harness(), pending = { version: '0.1.0-canary.15' };
        h.engine.getPending.mockResolvedValueOnce(null).mockResolvedValueOnce(pending);
        await h.controller.start(); await h.controller.start();
        expect(h.engine.check).toHaveBeenCalledTimes(1);
        expect(h.launch).toHaveBeenCalledExactlyOnceWith(pending);
        expect(h.notify).toHaveBeenCalledExactlyOnceWith(pending.version);
        expect(h.setTimer).not.toHaveBeenCalled();
        const adapter = h.create.mock.calls[0][0].adapter;
        expect(await adapter.canApplyNative()).toBe(false);
        expect(await adapter.apply()).toMatchObject({ applied: false });
        await h.controller.stop();
    });
    it('recovers an existing verified stage before making a network request', async () => {
        const h = harness(); h.engine.getPending.mockResolvedValue({ version: '0.1.0-canary.15' });
        await h.controller.start();
        expect(h.engine.check).not.toHaveBeenCalled(); expect(h.launch).toHaveBeenCalledTimes(1);
        expect(h.engine.applyPending).toHaveBeenCalledWith({ phase: 'startup' });
    });
    it.each(['0.1.0-canary.13', '0.1.0-canary.14', '0.1.0-canary.14+build'])('never hands off stale pending %s', async version => {
        const h = harness(); h.engine.getPending.mockResolvedValue({ version });
        await h.controller.start();
        expect(h.launch).not.toHaveBeenCalled(); expect(h.engine.check).toHaveBeenCalledTimes(1);
        expect(h.setTimer).toHaveBeenCalledWith(expect.any(Function), 6 * 3600000);
    });
    it('retries a failed helper launch without claiming installation or losing the pending package', async () => {
        const h = harness(); h.engine.getPending.mockResolvedValue({ version: '0.1.0-canary.15' });
        h.launch.mockRejectedValue(new Error('spawn failed'));
        await h.controller.start();
        expect(h.notify).not.toHaveBeenCalled(); expect(h.onError).toHaveBeenCalledTimes(2);
        h.launch.mockResolvedValue(undefined);
        await h.setTimer.mock.calls[0][0]();
        await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(3));
        await h.controller.stop();
        expect(h.launch).toHaveBeenCalledTimes(3);
    });
    it('treats unavailable/private feeds as a periodic retry, without authentication', async () => {
        const h = harness(); await h.controller.start();
        expect(h.launch).not.toHaveBeenCalled(); expect(h.setTimer).toHaveBeenCalledTimes(1);
        await h.controller.stop(); expect(h.clearTimer).toHaveBeenCalled();
    });
    it('stops during discovery without launching a helper or rescheduling', async () => {
        const h = harness(); let release!: () => void;
        h.engine.check.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
        const started = h.controller.start();
        await vi.waitFor(() => expect(h.engine.check).toHaveBeenCalled());
        const stopped = h.controller.stop();
        h.engine.getPending.mockResolvedValue({ version: '0.1.0-canary.15' }); release();
        await Promise.all([started, stopped]);
        expect(h.launch).not.toHaveBeenCalled(); expect(h.setTimer).not.toHaveBeenCalled();
    });
});

function feed(version = '0.1.0-canary.15') {
    const bytes = Buffer.from('verified ZIP fixture bytes');
    const asset = { variant: 'standalone', platform: 'win32', kind: 'native', name: `SupportTemplates-standalone-${version}.zip`,
        size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const manifest = { schema: 1, product: 'SupportTemplates', repository: config.releaseRepository, version, channel: 'canary', assets: [asset] };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const download = (name: string) => `https://github.com/owner/releases/releases/download/v${version}/${name}`;
    const release = { draft: false, tag_name: `v${version}`, prerelease: true, assets: [
        { name: config.manifestAsset, size: manifestBytes.length, state: 'uploaded', browser_download_url: download(config.manifestAsset) },
        { name: asset.name, size: bytes.length, state: 'uploaded', browser_download_url: download(asset.name) }
    ] };
    const transport = vi.fn(async (url: string) => {
        const body = url.includes('api.github.com') ? Buffer.from(JSON.stringify([release])) : url.endsWith('.json') ? manifestBytes : bytes;
        return { status: 200, headers: {}, body: (async function* () { yield body; })() };
    });
    return { transport, bytes, asset, manifest };
}

describe('standalone integration with real shared engine', () => {
    it('downloads via the shared engine and launches the verified stage, then clears obsolete pending on the next version', async () => {
        const root = fixture(), f = feed(), launch = vi.fn();
        const controller = createStandaloneController({ createUpdater: (opts: any) => createUpdater({ ...opts, transport: f.transport }),
            config, stagingDir: root, launch, setTimer: vi.fn() });
        await controller.start(); await controller.stop();
        expect(launch).toHaveBeenCalledTimes(1);
        const pending = launch.mock.calls[0][0];
        expect(readFileSync(pending.assetPath)).toEqual(f.bytes);
        expect(existsSync(path.join(root, 'pending.json'))).toBe(true); // staging is not a false success receipt
        const nextLaunch = vi.fn();
        const newer = createStandaloneController({ createUpdater: (opts: any) => createUpdater({ ...opts, transport: f.transport }),
            config: { ...config, version: '0.1.0-canary.16' }, stagingDir: root, launch: nextLaunch, setTimer: vi.fn() });
        await newer.start(); await newer.stop();
        expect(nextLaunch).not.toHaveBeenCalled(); expect(existsSync(path.join(root, 'pending.json'))).toBe(false);
    });
    it('performs no network calls when the shared repository is null', async () => {
        const f = feed(), h = harness({ config: { ...config, releaseRepository: null },
            createUpdater: (opts: any) => createUpdater({ ...opts, transport: f.transport }) });
        await h.controller.start(); await h.controller.stop();
        expect(f.transport).not.toHaveBeenCalled(); expect(h.launch).not.toHaveBeenCalled();
    });
    it('handles anonymous 404 without a prompt or failed host startup', async () => {
        const transport = vi.fn(async () => ({ status: 404, headers: {}, body: (async function* () {})() }));
        const h = harness({ createUpdater: (opts: any) => createUpdater({ ...opts, transport }) });
        await h.controller.start(); await h.controller.stop();
        expect(h.onError).not.toHaveBeenCalled(); expect(h.launch).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(1);
    });
    it('recovers a corrupted stage through fresh discovery and only launches the newly verified download', async () => {
        const root = fixture(), f = feed();
        const engine = createUpdater({ config, variant: 'standalone', stagingDir: root, transport: f.transport, adapter: { apply: vi.fn() } });
        await engine.check(); const pending = await engine.getPending(); writeFileSync(pending.assetPath, 'tampered');
        const launch = vi.fn(), onError = vi.fn();
        const controller = createStandaloneController({ createUpdater: (opts: any) => createUpdater({ ...opts, transport: f.transport }),
            config, stagingDir: root, launch, onError, setTimer: vi.fn() });
        await controller.start(); await controller.stop();
        expect(onError).toHaveBeenCalledTimes(1);
        expect(launch).toHaveBeenCalledTimes(1);
        const recovered = launch.mock.calls[0][0];
        expect(recovered.assetPath).not.toBe(pending.assetPath);
        expect(readFileSync(recovered.assetPath)).toEqual(f.bytes);
    });
});

describe('hidden standalone helper handoff', () => {
    function input() {
        const root = fixture(), f = feed();
        const assetPath = path.join(root, 'auto-updates', 'stage', f.asset.name);
        mkdirSync(path.dirname(assetPath), { recursive: true }); writeFileSync(assetPath, f.bytes);
        const helperPath = path.join(root, 'update-helper.ps1'); writeFileSync(helperPath, '# fixture');
        return { pending: { variant: 'standalone', asset: f.asset, manifest: f.manifest, version: f.manifest.version, assetPath, channel: 'canary' },
            channel: 'canary', channelRoot: root, helperPath, parentPid: 1234, currentVersion: config.version };
    }
    it('spawns detached and hidden with structured arguments and a durable immutable request', async () => {
        const value = input(), child = Object.assign(new EventEmitter(), { unref: vi.fn() });
        const spawn = vi.fn((_command: string, _args: string[], _options: any) => { queueMicrotask(() => child.emit('spawn')); return child; });
        await launchUpdateHelper(value, spawn);
        const [command, args, opts] = spawn.mock.calls[0];
        expect(command).toMatch(/powershell\.exe$/); expect(args).toContain('Hidden'); expect(args).toContain('-NonInteractive');
        expect(opts).toMatchObject({ detached: true, windowsHide: true, stdio: 'ignore' });
        const request = JSON.parse(readFileSync(args.at(-1)!, 'utf8'));
        expect(request).toMatchObject({ sha256: value.pending.asset.sha256, repository: config.releaseRepository, releaseChannel: 'canary' });
        expect(child.unref).toHaveBeenCalledOnce();
    });
    it('rejects a package outside its own cache before spawning', async () => {
        const value = input(), spawn = vi.fn(); value.pending.assetPath = path.join(value.channelRoot, 'elsewhere.zip');
        await expect(launchUpdateHelper(value, spawn)).rejects.toThrow(/escapes/); expect(spawn).not.toHaveBeenCalled();
    });
    it('propagates spawn failure for periodic retry', async () => {
        const child = new EventEmitter();
        await expect(launchUpdateHelper(input(), () => { queueMicrotask(() => child.emit('error', new Error('denied'))); return child; })).rejects.toThrow('denied');
    });
});
