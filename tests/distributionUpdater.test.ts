import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createUpdater, compareVersions } = require('../distribution/updater/index.cjs');
const { createFileAdapter } = require('../distribution/updater/adapters.cjs');
const disk = require('../distribution/updater/storage.cjs');
const { receive, validateUrl } = require('../distribution/updater/transport.cjs');
const repo = 'skyjacc/support-templates';
const baseline = '0.1.0-canary.14';
const next = '0.1.0-canary.15';
const roots: string[] = [];
const updaters: any[] = [];
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const response = (body: Buffer | string, status = 200, headers = {}) => ({ status, headers, body: Readable.from([Buffer.from(body)]) });
const jsonResponse = (value: unknown) => response(JSON.stringify(value));
const url = (version: string, name: string) => `https://github.com/${repo}/releases/download/v${version}/${name}`;
const api = `https://api.github.com/repos/${repo}/releases?per_page=100&page=1`;
async function root() { const dir = await mkdtemp(path.join(tmpdir(), 'distribution-updater-')); roots.push(dir); return dir; }
async function lockFile(dir: string, name = '.lock', pid = 123456) {
    const owner = { schema: 1, pid, nonce: randomUUID() };
    await writeFile(path.join(dir, name), JSON.stringify(owner)); return owner;
}
afterEach(async () => {
    for (const u of updaters.splice(0)) await u.stop();
    vi.useRealTimers();
    for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture({ variant = 'standalone', kind = 'native', version = next, channel = 'canary' } = {}) {
    const dir = await root();
    const bytes = Buffer.from('verified fixture payload');
    const name = variant === 'betterdiscord' ? 'SupportTemplates.plugin.js' : 'SupportTemplates.zip';
    const asset: any = { variant, platform: 'win32', kind, name, size: bytes.length, sha256: hash(bytes) };
    if (kind === 'renderer' && variant !== 'betterdiscord') asset.baseVersion = baseline;
    const manifest: any = { schema: 1, product: 'SupportTemplates', repository: repo, version, channel, assets: [asset] };
    const release: any = { tag_name: `v${version}`, draft: false, prerelease: channel === 'canary', assets: [] };
    const routes = new Map<string, () => any>();
    const config = { schema: 1, version: baseline, channel, releaseRepository: repo, manifestAsset: 'support-templates-update.json', checkIntervalHours: 6 };
    function refresh() {
        const json = Buffer.from(JSON.stringify(manifest));
        release.assets = [
            { name: config.manifestAsset, size: json.length, state: 'uploaded', browser_download_url: url(version, config.manifestAsset) },
            { name, size: bytes.length, state: 'uploaded', digest: `sha256:${hash(bytes)}`, browser_download_url: url(version, name) }
        ];
        routes.set(api, () => jsonResponse([release]));
        routes.set(url(version, config.manifestAsset), () => response(json));
        routes.set(url(version, name), () => response(bytes));
    }
    refresh();
    const transport = vi.fn(async (request: string) => {
        const route = routes.get(request);
        if (!route) throw new Error(`Unexpected fixture URL: ${request}`);
        return route();
    });
    const adapter = { canApplyNative: vi.fn(async () => false), apply: vi.fn(async () => ({ applied: true })) };
    function make(extra: any = {}) {
        const u = createUpdater({ config, variant, stagingDir: dir, adapter, transport, ...extra });
        updaters.push(u); return u;
    }
    return { dir, bytes, asset, manifest, release, routes, config, transport, adapter, refresh, make, name };
}

describe('release discovery and staged installation', () => {
    it.each(['standalone', 'vencord', 'betterdiscord'])('stages verified native %s and applies only after a positive startup gate', async variant => {
        const f = await fixture({ variant }); const u = f.make();
        expect(await u.check()).toMatchObject({ status: 'staged', version: next });
        expect(f.adapter.apply).not.toHaveBeenCalled();
        const pending = await u.getPending();
        expect(await readFile(pending.assetPath)).toEqual(f.bytes);
        expect(await u.applyPending()).toMatchObject({ status: 'pending-restart' });
        expect(f.adapter.canApplyNative).not.toHaveBeenCalled();
        expect(await u.applyPending({ phase: 'startup' })).toMatchObject({ status: 'pending-restart' });
        f.adapter.canApplyNative.mockResolvedValue(true);
        const restarted = f.make();
        expect(await restarted.applyPending({ phase: 'app-closed' })).toMatchObject({ status: 'applied', kind: 'native' });
        expect(f.adapter.apply).toHaveBeenCalledTimes(1);
        expect(await restarted.getPending()).toBeNull();
        expect(await f.make({ currentVersion: next, baseVersion: next }).check()).toMatchObject({ status: 'up-to-date', version: next });
    });
    it('stages the BetterDiscord plugin at runtime and atomically replaces it at restart without a forced reload', async () => {
        const f = await fixture({ variant: 'betterdiscord', kind: 'renderer' });
        const targetPath = path.join(f.dir, 'SupportTemplates.plugin.js');
        await writeFile(targetPath, 'old plugin');
        const u = f.make({ adapter: createFileAdapter({ targetPath }) });
        expect(await u.check()).toMatchObject({ status: 'pending' });
        expect((await readFile(targetPath)).toString()).toBe('old plugin');
        expect(await u.applyPending({ phase: 'startup' })).toMatchObject({ status: 'applied', reloadRequired: true });
        expect(await readFile(targetPath)).toEqual(f.bytes);
        expect((await readdir(f.dir)).some(name => name.endsWith('.tmp'))).toBe(false);
    });
    it('requires an apply adapter, but absence of native gate safely retains staged files', async () => {
        const f = await fixture();
        expect(() => f.make({ adapter: {} })).toThrow('APPLY_ADAPTER_REQUIRED');
        const apply = vi.fn(); const u = f.make({ adapter: { apply } });
        await u.check();
        expect(await u.applyPending({ phase: 'startup' })).toMatchObject({ status: 'pending-restart' });
        expect(apply).not.toHaveBeenCalled();
    });
    it('retains the pending update after a deferred or failing adapter and retries idempotently', async () => {
        const f = await fixture({ variant: 'betterdiscord', kind: 'renderer' });
        f.adapter.apply.mockResolvedValueOnce({ applied: false }); const u = f.make();
        expect(await u.check()).toMatchObject({ status: 'pending' });
        f.adapter.apply.mockRejectedValueOnce(new Error('fixture failure'));
        await expect(u.applyPending()).rejects.toThrow('fixture failure');
        expect(await u.getPending()).not.toBeNull();
        expect(await u.applyPending()).toMatchObject({ status: 'applied' });
    });
    it('rejects staged tampering on restart, including a mutation during the native safety gate', async () => {
        const f = await fixture(); const u = f.make(); await u.check();
        const pending = await u.getPending();
        f.adapter.canApplyNative.mockImplementation(async () => {
            await writeFile(pending.assetPath, Buffer.alloc(f.bytes.length)); return true;
        });
        await expect(u.applyPending({ phase: 'startup' })).rejects.toThrow('HASH_MISMATCH');
        await expect(f.make().getPending()).rejects.toThrow('HASH_MISMATCH');
        expect(f.adapter.apply).not.toHaveBeenCalled();
    });
    it('a failed newer download preserves the previous atomic pending record', async () => {
        const f = await fixture(); const u = f.make(); await u.check();
        const before = await readFile(path.join(f.dir, 'pending.json'));
        const version = '0.1.0-canary.16'; const manifest = { ...f.manifest, version };
        const metadata = JSON.stringify(manifest);
        const release = { ...f.release, tag_name: `v${version}`, assets: f.release.assets.map((a: any) => ({ ...a,
            size: a.name === f.config.manifestAsset ? Buffer.byteLength(metadata) : a.size,
            browser_download_url: url(version, a.name) })) };
        f.routes.set(api, () => jsonResponse([release]));
        f.routes.set(url(version, f.config.manifestAsset), () => response(metadata));
        f.routes.set(url(version, f.name), () => response(Buffer.alloc(f.bytes.length)));
        await expect(u.check()).rejects.toThrow('HASH_MISMATCH');
        expect(await readFile(path.join(f.dir, 'pending.json'))).toEqual(before);
        expect((await readdir(f.dir)).some(n => n.startsWith('.work-'))).toBe(false);
        expect((await u.getPending()).version).toBe(next);
    });
    it('uses the list API, semver ordering and channel filtering, including prereleases on a second page', async () => {
        const f = await fixture();
        const unrelated = { ...f.release, tag_name: 'v99.0.0', prerelease: false };
        f.routes.set(api, () => jsonResponse(Array.from({ length: 100 }, () => unrelated)));
        f.routes.set(api.replace('&page=1', '&page=2'), () => jsonResponse([
            { ...f.release, tag_name: 'v0.1.0-canary.100', draft: true },
            f.release, { ...f.release, tag_name: 'v0.1.0-canary.9' }
        ]));
        expect(await f.make().check()).toMatchObject({ status: 'staged', version: next });
        expect(f.transport.mock.calls.some(([u]) => u.includes('/latest'))).toBe(false);
    });
    it('stable clients accept only final releases and never downgrade', async () => {
        const f = await fixture({ channel: 'stable', version: '1.0.0' });
        f.config.version = '0.9.0';
        expect(await f.make().check()).toMatchObject({ status: 'staged', version: '1.0.0' });
        const second = f.make({ currentVersion: '2.0.0', baseVersion: '2.0.0' });
        expect(await second.check()).toMatchObject({ status: 'up-to-date', version: '2.0.0' });
        expect(await second.applyPending({ phase: 'startup' })).toMatchObject({ status: 'up-to-date' });
        expect(f.adapter.apply).not.toHaveBeenCalled();
    });
    it('null repository does no network or disk work', async () => {
        const f = await fixture(); const stagingDir = path.join(f.dir, 'unused');
        const u = f.make({ stagingDir, config: { ...f.config, releaseRepository: null } });
        u.start(); expect(await u.check()).toEqual({ status: 'disabled' });
        expect(await u.getPending()).toBeNull();
        expect(await u.applyPending()).toEqual({ status: 'disabled' });
        expect(f.transport).not.toHaveBeenCalled();
        expect(await readdir(f.dir)).toEqual([]);
    });
    it.each([403, 404, 429])('treats anonymous HTTP %s as harmless unavailability', async status => {
        const f = await fixture(); f.routes.set(api, () => response('', status));
        expect(await f.make().check()).toMatchObject({ status: 'unavailable', httpStatus: status });
    });
    it('binds persisted state to the selected repository and variant', async () => {
        const f = await fixture(); await f.make().check();
        await expect(f.make({ variant: 'vencord' }).getPending()).rejects.toThrow('INVALID_RECORD');
        await expect(f.make({ config: { ...f.config, releaseRepository: 'other/repo' } }).getPending()).rejects.toThrow('INVALID_MANIFEST');
    });
    it.each(['corrupt-archive', 'missing-archive', 'directory-archive', 'invalid-json'])('quarantines %s and downloads a fresh verified asset', async corruption => {
        const f = await fixture(); const u = f.make(); await u.check();
        const pending = await u.getPending();
        if (corruption === 'corrupt-archive') await writeFile(pending.assetPath, Buffer.alloc(f.bytes.length));
        if (corruption === 'missing-archive') await rm(pending.assetPath);
        if (corruption === 'directory-archive') { await rm(pending.assetPath); await mkdir(pending.assetPath); }
        if (corruption === 'invalid-json') await writeFile(path.join(f.dir, 'pending.json'), '{broken');
        f.transport.mockClear(); const events: any[] = [];
        const restarted = f.make({ onEvent: (event: any) => events.push(event) });
        expect(await restarted.check()).toMatchObject({ status: 'staged', version: next });
        expect(f.transport).toHaveBeenCalledWith(api, expect.anything());
        expect(await readFile((await restarted.getPending()).assetPath)).toEqual(f.bytes);
        expect((await readdir(f.dir)).filter(n => n.startsWith('.invalid-pending-'))).toHaveLength(1);
        expect(events.some(e => e.type === 'cache-invalid')).toBe(true);
    });
    it('repairs a fallback runtime even when a newer applied receipt survived the failed startup', async () => {
        const f = await fixture({ version: '0.1.0-canary.16' });
        await writeFile(path.join(f.dir, 'applied.json'), JSON.stringify({ schema: 1, repository: repo, variant: 'standalone', channel: 'canary', version: '0.1.0-canary.16' }));
        f.adapter.canApplyNative.mockResolvedValue(true);
        const u = f.make({ currentVersion: '0.1.0-canary.15', baseVersion: '0.1.0-canary.15' });
        expect(await u.check()).toMatchObject({ status: 'staged', version: '0.1.0-canary.16' });
        expect(await u.applyPending({ phase: 'startup' })).toMatchObject({ status: 'applied', version: '0.1.0-canary.16' });
        expect(await u.check()).toMatchObject({ status: 'up-to-date', version: '0.1.0-canary.16' });
        expect(f.adapter.apply).toHaveBeenCalledTimes(1);
    });
    it('does not let a corrupt older pending archive block a newer valid release', async () => {
        const old = await fixture(); const oldUpdater = old.make(); await oldUpdater.check();
        await rm((await oldUpdater.getPending()).assetPath);
        const fresh = await fixture({ version: '0.1.0-canary.16' });
        const u = fresh.make({ stagingDir: old.dir });
        expect(await u.check()).toMatchObject({ status: 'staged', version: '0.1.0-canary.16' });
        expect((await u.getPending()).version).toBe('0.1.0-canary.16');
    });
    it('uses actual installed version to finish the pending-delete crash window without reapplying', async () => {
        const f = await fixture(); const u = f.make(); await u.check();
        await writeFile(path.join(f.dir, 'applied.json'), JSON.stringify({ schema: 1, repository: repo, variant: 'standalone', channel: 'canary', version: next }));
        const restarted = f.make({ currentVersion: next, baseVersion: next });
        expect(await restarted.applyPending({ phase: 'startup' })).toMatchObject({ status: 'up-to-date', version: next });
        expect(await restarted.getPending()).toBeNull(); expect(f.adapter.apply).not.toHaveBeenCalled();
    });
});

describe('manifest and release verification', () => {
    it.each([
        ['hash', (f: any) => { f.asset.sha256 = 'a'.repeat(64); }, 'HASH_MISMATCH'],
        ['size', (f: any) => { f.asset.size++; }, 'SIZE_MISMATCH'],
        ['channel', (f: any) => { f.manifest.channel = 'stable'; }, 'CHANNEL_MISMATCH'],
        ['version', (f: any) => { f.manifest.version = '0.1.0-canary.16'; }, 'RELEASE_VERSION_MISMATCH'],
        ['repository', (f: any) => { f.manifest.repository = 'other/repo'; }, 'INVALID_MANIFEST'],
        ['duplicates', (f: any) => { f.manifest.assets.push({ ...f.asset }); }, 'DUPLICATE_VARIANT'],
        ['traversal', (f: any) => { f.asset.name = '../escape'; }, 'INVALID_ASSET_NAME'],
        ['device name', (f: any) => { f.asset.name = 'CON.zip'; }, 'INVALID_ASSET_NAME'],
        ['oversized', (f: any) => { f.asset.size = 300 * 1024 * 1024; }, 'INVALID_ASSET_SIZE'],
        ['wrong platform', (f: any) => { f.asset.platform = 'darwin'; }, 'INVALID_ASSET'],
        ['renderer base', (f: any) => { f.asset.kind = 'renderer'; f.asset.baseVersion = '0.1.0-canary.1'; }, 'BASE_VERSION_MISMATCH']
    ])('rejects %s before staging', async (_label, mutate, error) => {
        const f = await fixture(); (mutate as (f: any) => void)(f); f.refresh();
        await expect(f.make().check()).rejects.toThrow(error as string);
        expect(await readdir(f.dir)).toEqual([]);
    });
    it('checks actual SHA256 even without optional GitHub digest', async () => {
        const f = await fixture(); delete f.release.assets[1].digest;
        f.routes.set(url(next, f.name), () => response(Buffer.alloc(f.bytes.length)));
        await expect(f.make().check()).rejects.toThrow('HASH_MISMATCH');
    });
    it('rejects stream overflow and truncation independent of headers', async () => {
        const f = await fixture(); const u = f.make();
        f.routes.set(url(next, f.name), () => response(Buffer.alloc(f.bytes.length + 1)));
        await expect(u.check()).rejects.toThrow('SIZE_MISMATCH');
        f.routes.set(url(next, f.name), () => response(f.bytes.subarray(1)));
        await expect(u.check()).rejects.toThrow('SIZE_MISMATCH');
    });
    it('reports a missing variant without invoking an adapter', async () => {
        const f = await fixture(); f.asset.variant = 'vencord'; f.refresh();
        expect(await f.make().check()).toEqual({ status: 'variant-unavailable' });
        expect(f.adapter.apply).not.toHaveBeenCalled();
    });
    it('rejects cross-repository GitHub URLs even when the host is allowed', async () => {
        const f = await fixture(); f.release.assets[1].browser_download_url = url(next, f.name).replace(repo, 'attacker/repo');
        await expect(f.make().check()).rejects.toThrow('UNSAFE_URL');
    });
});

describe('HTTPS bounds and allowlist', () => {
    const policy = { repo, role: 'asset', tag: `v${next}`, name: 'payload.zip' };
    it.each([
        'http://github.com/x', 'https://github.com.evil.test/x', 'https://user:password@github.com/x',
        'https://github.com:444/x', 'https://raw.githubusercontent.com/x', 'https://release-assets.githubusercontent.com/x'
    ])('rejects unsafe initial URL %s', value => {
        expect(() => validateUrl(value, policy)).toThrow('UNSAFE_URL');
    });
    it('allows a GitHub release CDN redirect but refuses arbitrary hosts and redirect loops', async () => {
        const start = url(next, 'payload.zip'); const cdn = 'https://release-assets.githubusercontent.com/fixture?signature=opaque';
        let mode = 'ok'; const output: Buffer[] = [];
        const transport = vi.fn(async (u: string) => u === start
            ? response('', 302, { location: mode === 'evil' ? 'https://evil.test/payload' : mode === 'loop' ? start : cdn })
            : response('ok'));
        const options = { ...policy, transport, timeoutMs: 1000, maxBytes: 2, onChunk: async (b: Buffer) => { output.push(b); } };
        expect(await receive(start, options)).toBe(2); expect(Buffer.concat(output).toString()).toBe('ok');
        mode = 'evil'; await expect(receive(start, options)).rejects.toThrow('UNSAFE_URL');
        mode = 'loop'; await expect(receive(start, options)).rejects.toThrow('REDIRECT_LIMIT');
    });
    it.each([{ 'content-length': '9999' }, { 'content-length': 'garbage' }, { 'content-encoding': 'gzip' }])('rejects invalid headers %j', async headers => {
        await expect(receive(url(next, 'payload.zip'), { ...policy, timeoutMs: 1000, maxBytes: 2,
            transport: async () => response('ok', 200, headers), onChunk: async () => {} })).rejects.toThrow();
    });
    it('bounds a transport that never returns or a body that never finishes', async () => {
        const options = { ...policy, timeoutMs: 10, maxBytes: 10, onChunk: async () => {} };
        await expect(receive(url(next, 'payload.zip'), { ...options, transport: () => new Promise(() => {}) })).rejects.toThrow('ABORTED');
        const body = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
        await expect(receive(url(next, 'payload.zip'), { ...options, transport: async () => ({ status: 200, headers: {}, body }) })).rejects.toThrow('ABORTED');
    });
});

describe('scheduling, concurrency and crash recovery', () => {
    it('polls on startup and six-hour intervals; stop cancels future checks', async () => {
        const f = await fixture(); f.routes.set(api, () => jsonResponse([]));
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const u = f.make(); u.start(); u.start();
        await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(1));
        await u.getPending(); // drain the initial operation before advancing timer
        await vi.advanceTimersByTimeAsync(7 * 3600000);
        await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(2));
        await u.stop(); await vi.advanceTimersByTimeAsync(24 * 3600000);
        expect(f.transport).toHaveBeenCalledTimes(2);
    });
    it('stop cancels an in-flight HTTP request and queued checks before they start', async () => {
        const f = await fixture(); let signal: AbortSignal | undefined;
        const transport = vi.fn((_url: string, options: any) => { signal = options.signal; return new Promise(() => {}); });
        const u = f.make({ transport }); u.start();
        await vi.waitFor(() => expect(signal).toBeDefined());
        await u.stop(); expect(signal!.aborted).toBe(true);
        const queued = u.check(); const caught = expect(queued).rejects.toThrow('ABORTED');
        await u.stop(); await caught;
    });
    it('serializes same-instance checks and refuses a simultaneous live owner', async () => {
        const f = await fixture(); const u = f.make();
        const results = await Promise.all([u.check(), u.check()]);
        expect(results.map(r => r.status)).toEqual(['staged', 'pending-restart']);
        let release!: () => void;
        const held = disk.locked(f.dir, () => new Promise(resolve => { release = () => resolve(null); }));
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        try { await expect(f.make().check()).rejects.toThrow('UPDATER_BUSY'); }
        finally { release(); await held; }
    });
    it('recovers a provably dead owner with at most one acquisition retry', async () => {
        const dir = await root(); await lockFile(dir);
        const probeProcess = vi.fn(() => { throw Object.assign(new Error(), { code: 'ESRCH' }); });
        expect(await disk.locked(dir, async () => 'acquired', { probeProcess })).toBe('acquired');
        expect(probeProcess).toHaveBeenCalledTimes(1); expect(await readdir(dir)).toEqual([]);
    });
    it.each(['live', 'EPERM', 'malformed', 'recovery-in-progress'])('fails closed for %s lock state', async state => {
        const dir = await root(); const owner = await lockFile(dir);
        if (state === 'malformed') await writeFile(path.join(dir, '.lock'), '{');
        if (state === 'recovery-in-progress') await lockFile(dir, `.recover-${owner.nonce}`, process.pid);
        const probeProcess = vi.fn((pid: number) => { if (state !== 'live' && pid !== process.pid) throw Object.assign(new Error(), { code: state === 'EPERM' ? 'EPERM' : 'ESRCH' }); });
        await expect(disk.locked(dir, async () => {}, { probeProcess })).rejects.toThrow('UPDATER_BUSY');
        expect(await readdir(dir)).toContain('.lock');
    });
    it('does not steal the new live owner during concurrent stale-lock recovery', async () => {
        const dir = await root(); await lockFile(dir);
        const probeProcess = (pid: number) => { if (pid !== process.pid) throw Object.assign(new Error(), { code: 'ESRCH' }); };
        let release!: () => void;
        const first = disk.locked(dir, () => new Promise(resolve => { release = () => resolve(null); }), { probeProcess });
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        try { await expect(disk.locked(dir, async () => {}, { probeProcess })).rejects.toThrow('UPDATER_BUSY'); }
        finally { release(); await first; }
    });
    it('atomically publishes complete ownership and ignores orphan pre-publication files', async () => {
        const dir = await root(); await writeFile(path.join(dir, '.owner-crashed.tmp'), '{partial');
        await disk.locked(dir, async () => {
            const owner = JSON.parse(await readFile(path.join(dir, '.lock'), 'utf8'));
            expect(owner).toMatchObject({ schema: 1, pid: process.pid });
            expect(owner.nonce).toMatch(/^[a-f0-9-]{36}$/);
        });
        expect(await readdir(dir)).toEqual(['.owner-crashed.tmp']);
    });
    it('recovers crashes inside recovery itself without stranding a recovery mutex', async () => {
        const dir = await root(); let owner = await lockFile(dir);
        for (let i = 0; i < 3; i++) owner = await lockFile(dir, `.recover-${owner.nonce}`, 123457 + i);
        const probeProcess = vi.fn((pid: number) => { if (pid !== process.pid) throw Object.assign(new Error(), { code: 'ESRCH' }); });
        expect(await disk.locked(dir, async () => 'recovered', { probeProcess })).toBe('recovered');
        expect(probeProcess).toHaveBeenCalledTimes(4); expect(await readdir(dir)).toEqual([]);
    });
    it('allows exactly one of two simultaneous dead-owner recovery contenders to enter', async () => {
        const dir = await root(); await lockFile(dir);
        const probeProcess = (pid: number) => { if (pid !== process.pid) throw Object.assign(new Error(), { code: 'ESRCH' }); };
        const releases: Array<() => void> = []; let busy = 0;
        const enter = () => new Promise<void>(resolve => { releases.push(resolve); });
        const attempts = [0, 1].map(() => disk.locked(dir, enter, { probeProcess }).then(
            () => 'acquired', (error: any) => { if (error.code === 'UPDATER_BUSY') busy++; return error.code; }));
        try {
            await vi.waitFor(() => { expect(releases).toHaveLength(1); expect(busy).toBe(1); });
        } finally { for (const release of releases) release(); }
        expect((await Promise.all(attempts)).sort()).toEqual(['UPDATER_BUSY', 'acquired']);
        expect(await readdir(dir)).toEqual([]);
    });
    it('refuses staging through a junction/symlink', async () => {
        const f = await fixture(); const real = path.join(f.dir, 'real'); const linked = path.join(f.dir, 'linked');
        await mkdir(real); await symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
        await expect(f.make({ stagingDir: linked }).check()).rejects.toThrow('SYMLINK_REFUSED');
        expect(f.transport).not.toHaveBeenCalled();
    });
});

describe('semver', () => {
    it.each([
        ['0.1.0-canary.9', '0.1.0-canary.14', -1], ['1.0.0', '1.0.0-canary.99', 1],
        ['1.0.0+one', '1.0.0+two', 0], ['1.0.0-canary.999999999999999999999', '1.0.0-canary.1000000000000000000000', -1],
        ['2.0.0', '1.99.99', 1], ['1.0.0-canary.1', '1.0.0-canary.a', -1]
    ])('compares %s to %s', (a, b, result) => expect(compareVersions(a, b)).toBe(result));
    it.each(['v1.0.0', '01.0.0', '1.0.0-canary.01', '1.2', '1.0.0-', '../1.0.0'])('rejects %s', value => {
        expect(() => compareVersions(value, baseline)).toThrow('INVALID_VERSION');
    });
});
