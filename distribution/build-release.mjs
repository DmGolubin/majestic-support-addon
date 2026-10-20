// Produce the two public variants: SupportTemplates Lite, then BetterDiscord.
// The owner's full Vencord build has a separate entry point.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readConfig } from './config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = readConfig();
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', 'src', 'standalone', 'betterdiscord', 'distribution'], { cwd: root, encoding: 'utf8' });
if (dirty.trim()) throw new Error('Commit release build inputs before building');
const destination = path.join(root, 'artifacts/distribution', config.version);
if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite an existing release: ${destination}`);
fs.mkdirSync(destination, { recursive: true });
const buildOutput = fs.mkdtempSync(path.join(os.tmpdir(), 'support-templates-public-packages-'));

function build(script, args = []) {
    const result = execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(result);
    // Builders emit one final JSON object after diagnostic lines.
    for (let offset = result.lastIndexOf('{'); offset >= 0; offset = result.lastIndexOf('{', offset - 1)) {
        try { const metadata = JSON.parse(result.slice(offset)); if (metadata.package || metadata.plugin) return metadata; } catch { /* Nested or diagnostic JSON. */ }
    }
    throw new Error(`No package metadata emitted by ${script}`);
}

const standalone = build('standalone/build.mjs');
const betterdiscord = build('betterdiscord/build.mjs', ['--out', path.join(buildOutput, 'betterdiscord')]);
const assets = [];
function copyAsset(file, name, variant, kind) {
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(path.join(destination, name), bytes, { flag: 'wx' });
    assets.push({ variant, platform: 'win32', kind, name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
copyAsset(standalone.zip, `SupportTemplates-standalone-${config.version}.zip`, 'standalone', 'native');
copyAsset(betterdiscord.plugin ?? path.join(betterdiscord.package, 'SupportTemplates.plugin.js'), 'SupportTemplates.plugin.js', 'betterdiscord', 'renderer');
if (betterdiscord.zip) fs.copyFileSync(betterdiscord.zip, path.join(destination, `SupportTemplates-betterdiscord-${config.version}.zip`));

// Corresponding sources accompany the distribution, even when the source repo is private.
execFileSync('git', ['archive', '--format=zip', `--output=${path.join(destination, 'SupportTemplates-source.zip')}`, commit, '--',
    'src', 'standalone', 'betterdiscord', 'distribution', 'scripts', 'tests', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'LICENSE'], { cwd: root });
const upstream = path.resolve(process.env.VENCORD_DIR ?? path.join(root, '../Vencord'));
const dependencyFile = path.join(upstream, 'support-templates-dependency-evidence.json');
const dependencyEvidence = fs.existsSync(dependencyFile) ? JSON.parse(fs.readFileSync(dependencyFile)) : null;
if (!dependencyEvidence) throw new Error('Run distribution/prepare-upstream.mjs and set VENCORD_DIR to its clean checkout');
const { checkout: _privatePath, ...publicDependencyEvidence } = dependencyEvidence;
fs.writeFileSync(path.join(destination, 'build-evidence.json'), JSON.stringify({ schema: 1, commit, version: config.version, dependencies: publicDependencyEvidence, assets }, null, 2));
fs.writeFileSync(path.join(destination, config.manifestAsset), JSON.stringify({ schema: 1, product: 'SupportTemplates', repository: config.releaseRepository, version: config.version, channel: config.channel, assets }, null, 2));
fs.copyFileSync(path.join(root, 'distribution/INSTALL-RU.md'), path.join(destination, 'INSTALL-RU.md'));
const checksums = fs.readdirSync(destination).filter(name => fs.statSync(path.join(destination, name)).isFile()).sort()
    .map(name => `${createHash('sha256').update(fs.readFileSync(path.join(destination, name))).digest('hex')}  ${name}`).join('\n') + '\n';
fs.writeFileSync(path.join(destination, 'SHA256SUMS.txt'), checksums);
console.log(JSON.stringify({ release: destination, commit, version: config.version, published: false }, null, 2));
