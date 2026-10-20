import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createUpdater } = require('../distribution/updater/index.cjs');
const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) {
        if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('q18Delivery-')) throw Error('Unsafe fixture cleanup');
        await rm(root, { recursive: true, force: true });
    }
});

async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'q18Delivery-')); roots.push(root);
    const id = randomUUID(), version = '1.0.0-canary.2';
    const bytes = Buffer.from('synthetic package; never executed');
    const asset = { variant: 'standalone', platform: 'win32', kind: 'native', name: 'fixture.zip',
        size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const config = { schema: 1, version: '1.0.0-canary.1', channel: 'canary', releaseRepository: 'owner/releases',
        manifestAsset: 'support-templates-update.json', checkIntervalHours: 6 };
    const manifest = { schema: 1, product: 'SupportTemplates', repository: config.releaseRepository, version, channel: 'canary', assets: [asset] };
    const pending = { schema: 1, id, variant: 'standalone', manifest };
    await mkdir(path.join(root, id)); await writeFile(path.join(root, id, asset.name), bytes);
    await writeFile(path.join(root, 'pending.json'), JSON.stringify(pending));
    const adapter = { canApplyNative: vi.fn(async () => true), apply: vi.fn(async () => ({ applied: true })) };
    const transport = vi.fn(async () => ({ status: 200, headers: {}, body: (async function* () { yield Buffer.from('[]'); })() }));
    const updater = createUpdater({ config, variant: 'standalone', stagingDir: root, adapter, transport });
    return { root, pending, adapter, updater, transport };
}

describe('q18Delivery updater cancellation and corrupt metadata recovery', () => {
    it('cancels a queued native apply when stopped before it acquires the disk lock', async () => {
        const f = await fixture();
        const operation = f.updater.applyPending({ phase: 'startup' });
        const outcome = operation.then(() => 'applied', (e: any) => e.code);
        await f.updater.stop();
        expect(await outcome).toBe('ABORTED');
        expect(f.adapter.apply).not.toHaveBeenCalled();
        expect(JSON.parse(await readFile(path.join(f.root, 'pending.json'), 'utf8'))).toEqual(f.pending);
    });

    it('cancels native application while its asynchronous process gate is waiting', async () => {
        const f = await fixture(); let release!: (value: boolean) => void;
        f.adapter.canApplyNative.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        const operation = f.updater.applyPending({ phase: 'startup' });
        const outcome = operation.then(() => 'applied', (e: any) => e.code);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        const stopped = f.updater.stop(); release(true);
        await stopped;
        expect(await outcome).toBe('ABORTED');
        expect(f.adapter.apply).not.toHaveBeenCalled();
        expect(JSON.parse(await readFile(path.join(f.root, 'pending.json'), 'utf8'))).toEqual(f.pending);
    });

    it('quarantines a JSON array masquerading as a UUID instead of permanently blocking discovery', async () => {
        const f = await fixture();
        await writeFile(path.join(f.root, 'pending.json'), JSON.stringify({ ...f.pending, id: [f.pending.id] }));
        await expect(f.updater.check()).resolves.toMatchObject({ status: 'up-to-date' });
        expect(f.transport).toHaveBeenCalledOnce();
        await expect(f.updater.getPending()).resolves.toBeNull();
    });
});
