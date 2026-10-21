import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';

const fixtures: string[] = [];
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
// Execute the real orchestration code with subprocesses intercepted. No builder or gh runs.
function runScript(file: string, root: string, config: object, execFileSync: (...args: any[]) => string, args: string[] = []) {
    const source = fs.readFileSync(path.resolve('distribution', file), 'utf8')
        .replace(/^import .+ from .+;\r?\n/gm, '')
        .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(root, 'distribution', file)).href));
    return runInNewContext(source, {
        fs, path, os: { ...os, tmpdir: () => root }, fileURLToPath, createHash, execFileSync,
        readConfig: () => config,
        validation: createRequire(import.meta.url)('../distribution/updater/validation.cjs'),
        process: { execPath: process.execPath, argv: ['node', file, ...args], env: {},
            stdout: { write() {} }, exit: () => { throw new Error('Unexpected process exit'); } },
        console: { log() {}, warn() {} }
    }, { filename: file, timeout: 10000 });
}
function fixture(version = '0.1.0-canary.14') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stx-release-check-')); fixtures.push(root);
    const dir = path.join(root, 'distribution'); fs.mkdirSync(path.join(dir, 'updater'), { recursive: true });
    for (const file of ['config.mjs', 'publish-release.mjs', 'updater/validation.cjs']) fs.copyFileSync(path.resolve('distribution', file), path.join(dir, file));
    const config = { schema: 1, version, channel: version.includes('-') ? 'canary' : 'stable', releaseRepository: 'skyjacc/support-templates', manifestAsset: 'support-templates-update.json', checkIntervalHours: 6 };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
    const output = path.join(root, 'artifacts/distribution', config.version); fs.mkdirSync(output, { recursive: true });
    const assets = ['standalone', 'betterdiscord'].map(variant => {
        const name = variant === 'betterdiscord' ? 'SupportTemplates.plugin.js' : `SupportTemplates-standalone-${config.version}.zip`;
        const bytes = Buffer.from(`fixture-${variant}`); fs.writeFileSync(path.join(output, name), bytes);
        return { variant, name, size: bytes.length, sha256: hash(bytes), platform: 'win32', kind: variant === 'betterdiscord' ? 'renderer' : 'native' };
    });
    const manifest = { schema: 1, product: 'SupportTemplates', repository: config.releaseRepository, version: config.version, channel: config.channel, assets };
    const evidence = { schema: 1, commit: 'a'.repeat(40), version: config.version, assets };
    const saveManifest = () => {
        fs.writeFileSync(path.join(output, config.manifestAsset), JSON.stringify(manifest));
        fs.writeFileSync(path.join(output, 'build-evidence.json'), JSON.stringify({ ...evidence, assets: manifest.assets }));
    };
    saveManifest();
    fs.writeFileSync(path.join(output, 'SupportTemplates-source.zip'), 'source-fixture');
    fs.writeFileSync(path.join(output, 'INSTALL-RU.md'), 'Public employee instructions');
    const publishedNames = [...assets.map(asset => asset.name), config.manifestAsset, 'SupportTemplates-source.zip', 'SHA256SUMS.txt'];
    const checksums = () => fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), fs.readdirSync(output)
        .filter(name => !['SHA256SUMS.txt', 'build-evidence.json', 'INSTALL-RU.md'].includes(name))
        .map(name => `${hash(fs.readFileSync(path.join(output, name)))}  ${name}`).join('\n') + '\n');
    checksums();
    const check = () => spawnSync(process.execPath, [path.join(dir, 'publish-release.mjs'), '--check'], { encoding: 'utf8', timeout: 10000 });
    return { root, config, output, manifest, evidence, publishedNames, saveManifest, checksums, check };
}
afterEach(() => {
    for (const root of fixtures.splice(0)) {
        if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('stx-release-check-')) throw new Error('Invalid fixture cleanup');
        fs.rmSync(root, { recursive: true, force: true });
    }
});
describe('release verification without publishing', () => {
    it('publishes a verified private release for repository members without making the repository public', () => {
        const f = fixture(); const calls: string[][] = [];
        runScript('publish-release.mjs', f.root, f.config, (_command, args) => {
            calls.push(args); return JSON.stringify({ visibility: 'PRIVATE' });
        }, ['--publish']);
        expect(calls).toHaveLength(2);
        expect(calls[0].slice(0, 2)).toEqual(['repo', 'view']);
        expect(calls[1].slice(0, 2)).toEqual(['release', 'create']);
        expect(calls[1]).not.toContain('--draft');
        expect(calls[1]).toContain('--target');
        expect(calls[1]).toContain(f.evidence.commit);
    });
    it.each(['0.1.0-canary.14', '1.0.5'])('validates only SupportTemplates and BetterDiscord offline for %s', version => {
        const f = fixture(version);
        expect(f.manifest.assets.map(asset => asset.name)).toEqual([`SupportTemplates-standalone-${version}.zip`, 'SupportTemplates.plugin.js']);
        const result = f.check(); expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('no publication performed');
    });
    it('preserves the canonical standalone ZIP required by released updaters', () => {
        const f = fixture('1.0.5');
        f.manifest.assets[0].name = 'SupportTemplates-1.0.5.zip';
        f.saveManifest(); f.checksums();
        expect(f.check().stderr).toContain('Unexpected public asset contract');
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
        expect(f.check().stderr).toContain('exactly standalone + betterdiscord');
    });
    it('also verifies the corresponding source archive', () => {
        const f = fixture(); fs.writeFileSync(path.join(f.output, 'SupportTemplates-source.zip'), 'damaged');
        expect(f.check().stderr).toContain('Damaged release file');
    });
    it('rejects the old optional BetterDiscord archive even when checksummed', () => {
        const f = fixture();
        fs.writeFileSync(path.join(f.output, `SupportTemplates-betterdiscord-${f.config.version}.zip`), 'bd-source-package');
        f.checksums();
        expect(f.check().stderr).toContain('Unverified file');
    });
    it.each(['standalone', 'betterdiscord'])('rejects a missing %s variant', variant => {
        const f = fixture(); f.manifest.assets = f.manifest.assets.filter(asset => asset.variant !== variant);
        f.saveManifest(); f.checksums();
        expect(f.check().stderr).toContain('exactly standalone + betterdiscord');
    });
    it.each(['vencord', 'standalone', 'betterdiscord', 'unknown'])('rejects extra or duplicate variant %s', variant => {
        const f = fixture(); f.manifest.assets.push({ ...f.manifest.assets[0], variant });
        f.saveManifest(); f.checksums();
        expect(f.check().stderr).toContain('exactly standalone + betterdiscord');
    });
    it.each(['vencord', 'standalone', 'unknown'])('rejects replacing BetterDiscord with %s in a two-entry manifest', variant => {
        const f = fixture(); f.manifest.assets[1].variant = variant;
        f.saveManifest(); f.checksums();
        expect(f.check().stderr).toContain('exactly standalone + betterdiscord');
    });
    it.each([null, {}, []])('rejects malformed assets %j', assets => {
        const f = fixture(); Object.assign(f.manifest, { assets });
        f.saveManifest(); f.checksums();
        expect(f.check().stderr).toContain('exactly standalone + betterdiscord');
    });
    it.each([
        'SupportTemplates-vencord-0.1.0-canary.14.zip',
        'SupportTemplates-vencord-0.1.0-canary.99.zip',
        'private-build.zip',
        'accidental-private-note.txt'
    ])('rejects checksummed extra file %s', name => {
        const f = fixture(); fs.writeFileSync(path.join(f.output, name), 'private'); f.checksums();
        expect(f.check().stderr).toContain('Unverified file');
    });
    it.each([0, 1])('preserves the public filename contract for asset %s', index => {
        const f = fixture(); f.manifest.assets[index].name = 'SupportTemplates-vencord.zip';
        f.saveManifest(); f.checksums();
        expect(f.check().stderr).toContain('Unexpected public asset contract');
    });
    it('rejects a native BetterDiscord asset', () => {
        const f = fixture(); f.manifest.assets[1].kind = 'native'; f.saveManifest(); f.checksums();
        expect(f.check().stderr).toContain('Unexpected public asset contract');
    });
    it.each(['SupportTemplates-source.zip', 'INSTALL-RU.md', 'build-evidence.json'])('requires %s', name => {
        const f = fixture(); fs.unlinkSync(path.join(f.output, name)); f.checksums();
        expect(f.check().stderr).toContain('Missing required public release file');
    });
    it('rejects stale evidence even with updated checksums', () => {
        const f = fixture();
        fs.writeFileSync(path.join(f.output, 'build-evidence.json'), JSON.stringify({
            ...f.evidence, assets: [...f.manifest.assets, { ...f.manifest.assets[0], variant: 'vencord' }]
        }));
        f.checksums();
        expect(f.check().stderr).toContain('Build evidence differs');
    });
    it.each(['SupportTemplates.plugin.js', 'SupportTemplates-standalone-0.1.0-canary.14.zip',
        'SupportTemplates-source.zip', 'support-templates-update.json'])('requires checksum coverage of published file %s', name => {
        const f = fixture(); const sums = path.join(f.output, 'SHA256SUMS.txt');
        fs.writeFileSync(sums, fs.readFileSync(sums, 'utf8').split('\n').filter(line => !line.endsWith(name)).join('\n'));
        expect(f.check().stderr).toContain('Unverified file');
    });
    it.each(['INSTALL-RU.md', 'build-evidence.json', 'SHA256SUMS.txt'])('rejects checksum entry for non-payload file %s', name => {
        const f = fixture();
        fs.appendFileSync(path.join(f.output, 'SHA256SUMS.txt'), `${hash(fs.readFileSync(path.join(f.output, name)))}  ${name}\n`);
        expect(f.check().stderr).toContain('Invalid checksum list');
    });
    it('keeps local notes editable without including them in published checksums', () => {
        const f = fixture();
        fs.writeFileSync(path.join(f.output, 'INSTALL-RU.md'), 'Updated release notes');
        const result = f.check();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('5 published assets and 2 local release files');
    });
    it.each([undefined, 'a'.repeat(7), 'z'.repeat(40)])('rejects invalid local source commit %s', commit => {
        const f = fixture();
        fs.writeFileSync(path.join(f.output, 'build-evidence.json'), JSON.stringify({ ...f.evidence, commit }));
        expect(f.check().stderr).toContain('Build evidence differs');
    });
    it('verifies updater JSON bytes as well as the manifest contract', () => {
        const f = fixture();
        fs.appendFileSync(path.join(f.output, f.config.manifestAsset), '\n');
        expect(f.check().stderr).toContain('Damaged release file');
    });
    it.each([{ args: [] }, { args: ['--publish'] }])('uses the same public-only gate in publication mode $args', ({ args }) => {
        const f = fixture(); const calls: string[] = [];
        fs.writeFileSync(path.join(f.output, `SupportTemplates-vencord-${f.config.version}.zip`), 'private');
        f.checksums();
        expect(() => runScript('publish-release.mjs', f.root, f.config, command => { calls.push(command); return ''; }, args))
            .toThrow('Unverified file');
        expect(calls).toEqual([]);
    });
    it.each([{ args: [] }, { args: ['--publish'] }])('prepares exactly five assets with local notes for gh in mode $args', ({ args }) => {
        const f = fixture(); const calls: { command: string; args: string[] }[] = [];
        runScript('publish-release.mjs', f.root, f.config, (command, argv) => {
            calls.push({ command, args: argv }); return JSON.stringify({ visibility: 'PUBLIC' });
        }, args);
        expect(calls.map(call => call.command)).toEqual(['gh', 'gh']);
        const release = calls[1].args;
        expect(release.slice(0, 2)).toEqual(['release', 'create']);
        expect(release.includes('--draft')).toBe(!args.includes('--publish'));
        expect(release).toContain(path.join(f.output, f.manifest.assets[0].name));
        expect(release).toContain(path.join(f.output, 'SupportTemplates.plugin.js'));
        expect(release.some(arg => arg.includes('vencord'))).toBe(false);
        expect(release[release.indexOf('--notes-file') + 1]).toBe(path.join(f.output, 'INSTALL-RU.md'));
        const uploads = release.filter((arg, index) => arg.startsWith(f.output + path.sep) && release[index - 1] !== '--notes-file');
        expect(uploads.sort()).toEqual(f.publishedNames.map(name => path.join(f.output, name)).sort());
        expect(uploads).not.toContain(path.join(f.output, 'INSTALL-RU.md'));
        expect(uploads).not.toContain(path.join(f.output, 'build-evidence.json'));
        expect(release).not.toContain(path.join(f.output, 'build-evidence.json'));
    });
});

describe('public release orchestration without running builds', () => {
    it('calls SupportTemplates then BetterDiscord, writes two matching assets, and passes offline release verification', () => {
        const f = fixture();
        const config = { ...f.config, version: '0.1.0-canary.15' };
        // Use an explicit fake upstream under the fixture rather than an installed checkout.
        const dependency = path.join(f.root, 'dependency');
        fs.mkdirSync(dependency);
        fs.writeFileSync(path.join(dependency, 'support-templates-dependency-evidence.json'), JSON.stringify({ checkout: 'private', commit: 'b'.repeat(40) }));
        const calls: string[] = [];
        let archiveArgs: string[] = [];
        const script = fs.readFileSync(path.resolve('distribution/build-release.mjs'), 'utf8');
        // All filesystem output and the fake upstream stay under the fixture.
        const source = script.replace(/^import .+ from .+;\r?\n/gm, '')
            .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(f.root, 'distribution/build-release.mjs')).href));
        runInNewContext(source, {
            fs, path, os: { ...os, tmpdir: () => f.root }, fileURLToPath, createHash,
            readConfig: () => config,
            process: { execPath: process.execPath, env: { VENCORD_DIR: dependency }, stdout: { write() {} } },
            console: { log() {} },
            execFileSync(command: string, args: string[]) {
                if (command === 'git') {
                    if (args[0] === 'rev-parse') return 'a'.repeat(40);
                    if (args[0] === 'status') return '';
                    if (args[0] === 'archive') {
                        archiveArgs = args;
                        fs.writeFileSync(args.find(arg => arg.startsWith('--output='))!.slice(9), 'source-fixture');
                        return '';
                    }
                }
                if (command === process.execPath && ['standalone/build.mjs', 'betterdiscord/build.mjs'].includes(args[0])) {
                    calls.push(args[0]);
                    if (args[0] === 'standalone/build.mjs') return JSON.stringify({ package: f.output, zip: path.join(f.output, f.manifest.assets[0].name) });
                    expect(args[1]).toBe('--out');
                    expect(args[2]).toContain('betterdiscord');
                    return JSON.stringify({ package: f.output, plugin: path.join(f.output, 'SupportTemplates.plugin.js') });
                }
                throw new Error(`Unexpected subprocess: ${command} ${args.join(' ')}`);
            }
        }, { timeout: 10000 });
        expect(calls).toEqual(['standalone/build.mjs', 'betterdiscord/build.mjs']);
        expect(archiveArgs).toEqual(expect.arrayContaining(['development', '.github', 'README.md', 'LICENSE']));
        const output = path.join(f.root, 'artifacts/distribution', config.version);
        const manifest = JSON.parse(fs.readFileSync(path.join(output, config.manifestAsset), 'utf8'));
        expect(manifest.assets.map((asset: any) => asset.variant)).toEqual(['standalone', 'betterdiscord']);
        expect(manifest.assets.map((asset: any) => asset.name)).toEqual([`SupportTemplates-standalone-${config.version}.zip`, 'SupportTemplates.plugin.js']);
        expect(fs.readdirSync(output).some(name => name.includes('vencord'))).toBe(false);
        expect(fs.readFileSync(path.join(output, 'build-evidence.json'), 'utf8')).not.toContain('private');
        const notes = fs.readFileSync(path.join(output, 'INSTALL-RU.md'), 'utf8');
        expect(notes).toContain('`install.bat`');
        expect(notes).toContain('`uninstall.bat`');
        expect(notes).not.toContain('SupportTemplates/payload/');
        expect(notes).not.toMatch(/Дмитри|Telegram|проверку кода|PR|Контракт/);
        expect(notes).not.toContain('GUI');
        expect(notes).not.toMatch(/\bLite\b/);
        expect([...notes.matchAll(/^\| \*\*([^*]+)\*\*/gm)].map(match => match[1]).sort()).toEqual(['BetterDiscord', 'SupportTemplates']);
        expect(notes).toContain(`](${`https://github.com/${config.releaseRepository}/releases/download/v${config.version}`}/SupportTemplates-standalone-${config.version}.zip)`);
        const expectedSums = [...manifest.assets.map((asset: any) => asset.name), config.manifestAsset, 'SupportTemplates-source.zip']
            .sort().map(name => `${hash(fs.readFileSync(path.join(output, name)))}  ${name}`).join('\n') + '\n';
        expect(fs.readFileSync(path.join(output, 'SHA256SUMS.txt'), 'utf8')).toBe(expectedSums);
        fs.writeFileSync(path.join(f.root, 'distribution/config.json'), JSON.stringify(config));
        const result = f.check();
        expect(result.status, result.stderr).toBe(0);
    });
});
