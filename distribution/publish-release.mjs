// Explicit maintainer command; never called by a user's updater.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readConfig } from './config.mjs';
import validation from './updater/validation.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = readConfig(true);
const args = process.argv.slice(2);
if (args.some(arg => !['--publish', '--check'].includes(arg))) throw new Error('Usage: node distribution/publish-release.mjs [--check | --publish]');
const directory = path.join(root, 'artifacts/distribution', config.version);
const manifest = JSON.parse(fs.readFileSync(path.join(directory, config.manifestAsset)));
if (manifest.repository !== config.releaseRepository || manifest.version !== config.version || manifest.channel !== config.channel) throw new Error('Build configuration differs from release configuration; rebuild first');
for (const variant of ['standalone', 'vencord', 'betterdiscord']) {
    if (!validation.validateManifest(manifest, { repo: config.releaseRepository, channel: config.channel, variant, baseVersion: config.version, releaseVersion: config.version, maxAssetBytes: 256 * 1024 * 1024 })) throw new Error(`Missing variant ${variant}`);
}
if (manifest.assets.length !== 3 || new Set(manifest.assets.map(asset => asset.variant)).size !== 3) throw new Error('All three variants are required');
for (const asset of manifest.assets) {
    if (!/^[A-Za-z0-9_.-]+$/.test(asset.name)) throw new Error('Invalid release filename');
    const bytes = fs.readFileSync(path.join(directory, asset.name));
    if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`Damaged release asset: ${asset.name}`);
}
const checksumLines = fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
const covered = new Set();
for (const line of checksumLines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line.trim());
    if (!match || covered.has(match[2])) throw new Error('Invalid checksum list');
    covered.add(match[2]);
    if (createHash('sha256').update(fs.readFileSync(path.join(directory, match[2]))).digest('hex') !== match[1]) throw new Error(`Damaged release file: ${match[2]}`);
}
const names = fs.readdirSync(directory);
if (names.some(name => !fs.statSync(path.join(directory, name)).isFile() || (name !== 'SHA256SUMS.txt' && !covered.has(name)))) throw new Error('Unverified file in release directory');
if (args.includes('--check')) { console.log(`Verified ${names.length} release files; no publication performed.`); process.exit(0); }
const metadata = JSON.parse(execFileSync('gh', ['repo', 'view', config.releaseRepository, '--json', 'visibility'], { encoding: 'utf8' }));
if (args.includes('--publish') && metadata.visibility !== 'PUBLIC') throw new Error('Automatic updates require a PUBLIC repository; use a draft until then');
const evidence = JSON.parse(fs.readFileSync(path.join(directory, 'build-evidence.json')));
if (!/^[a-f0-9]{40}$/.test(evidence.commit)) throw new Error('Missing source commit');
const ghArgs = ['release', 'create', `v${config.version}`, '--repo', config.releaseRepository, '--title', `SupportTemplates ${config.version}`,
    '--target', evidence.commit, '--notes-file', path.join(directory, 'INSTALL-RU.md')];
if (config.channel === 'canary') ghArgs.push('--prerelease');
if (!args.includes('--publish')) ghArgs.push('--draft');
ghArgs.push(...names.map(name => path.join(directory, name)));
execFileSync('gh', ghArgs, { stdio: 'inherit' });
