import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const fixtures: string[] = [];
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stx-release-check-')); fixtures.push(root);
    const dir = path.join(root, 'distribution'); fs.mkdirSync(path.join(dir, 'updater'), { recursive: true });
    for (const file of ['config.mjs', 'publish-release.mjs', 'updater/validation.cjs']) fs.copyFileSync(path.resolve('distribution', file), path.join(dir, file));
    const config = { schema: 1, version: '0.1.0-canary.14', channel: 'canary', releaseRepository: 'skyjacc/support-templates', manifestAsset: 'support-templates-update.json', checkIntervalHours: 6 };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
    const output = path.join(root, 'artifacts/distribution', config.version); fs.mkdirSync(output, { recursive: true });
    const assets = ['standalone', 'vencord', 'betterdiscord'].map(variant => {
        const name = variant === 'betterdiscord' ? 'SupportTemplates.plugin.js' : `${variant}.zip`;
        const bytes = Buffer.from(`fixture-${variant}`); fs.writeFileSync(path.join(output, name), bytes);
        return { variant, name, size: bytes.length, sha256: hash(bytes), platform: 'win32', kind: variant === 'betterdiscord' ? 'renderer' : 'native' };
    });
    const manifest = { schema: 1, product: 'SupportTemplates', repository: config.releaseRepository, version: config.version, channel: config.channel, assets };
    const saveManifest = () => fs.writeFileSync(path.join(output, config.manifestAsset), JSON.stringify(manifest));
    saveManifest();
    fs.writeFileSync(path.join(output, 'SupportTemplates-source.zip'), 'source-fixture');
    const checksums = () => fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), fs.readdirSync(output).filter(name => name !== 'SHA256SUMS.txt').map(name => `${hash(fs.readFileSync(path.join(output, name)))}  ${name}`).join('\n') + '\n');
    checksums();
    const check = () => spawnSync(process.execPath, [path.join(dir, 'publish-release.mjs'), '--check'], { encoding: 'utf8', timeout: 10000 });
    return { output, manifest, saveManifest, checksums, check };
}
afterEach(() => {
    for (const root of fixtures.splice(0)) {
        if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('stx-release-check-')) throw new Error('Invalid fixture cleanup');
        fs.rmSync(root, { recursive: true, force: true });
    }
});
describe('release verification without publishing', () => {
    it('validates all three assets offline without GitHub authentication', () => {
        const result = fixture().check(); expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('no publication performed');
    });
    it('refuses damaged plugin bytes even if the size is unchanged', () => {
        const f = fixture(); const file = path.join(f.output, 'SupportTemplates.plugin.js');
        const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes);
        expect(f.check().stderr).toContain('Damaged release asset');
    });
    it('refuses unexpected files added to the publish directory', () => {
        const f = fixture(); fs.writeFileSync(path.join(f.output, 'accidental-private-note.txt'), 'not a release asset');
        expect(f.check().stderr).toContain('Unverified file');
    });
    it('refuses mismatched repository and incomplete variant sets', () => {
        const f = fixture(); f.manifest.repository = 'elsewhere/repo'; f.saveManifest(); f.checksums();
        expect(f.check().stderr).toContain('differs');
        f.manifest.repository = 'skyjacc/support-templates'; f.manifest.assets.pop(); f.saveManifest(); f.checksums();
        expect(f.check().stderr).toContain('Missing variant betterdiscord');
    });
    it('also verifies the corresponding source archive', () => {
        const f = fixture(); fs.writeFileSync(path.join(f.output, 'SupportTemplates-source.zip'), 'damaged');
        expect(f.check().stderr).toContain('Damaged release file');
    });
});
