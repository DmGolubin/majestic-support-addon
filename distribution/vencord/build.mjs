// GPL-3.0-or-later. Only stages sources and artifacts; never installs into Discord.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createLoaderAsar } from './asar.mjs';
import { writeTar, writeZip } from './archive.mjs';
import { PIN, sha, files, readPackage, version } from './runtime/package.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const base = path.resolve(process.env.VENCORD_DIR ?? path.join(root, '../Vencord'));
const outputRoot = path.resolve(process.env.DISTRIBUTION_OUTPUT_DIR ?? path.join(root, 'artifacts/distribution'));
const config = JSON.parse(fs.readFileSync(path.join(root, 'distribution/config.json'), 'utf8'));
version(config.version);
if (config.schema !== 1 || !['stable', 'canary'].includes(config.channel)) throw Error('Invalid shared configuration');
if (config.releaseRepository !== null && !/^[\w.-]+\/[\w.-]+$/.test(config.releaseRepository)) throw Error('Invalid release repository');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
if (run('git', ['rev-parse', 'HEAD'], base).toString().trim() !== PIN) throw Error('VENCORD_DIR must be at the exact pinned commit');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'support-templates-vencord-build-'));
const source = path.join(work, 'source'); fs.mkdirSync(source);
const upstreamArchive = path.join(work, 'upstream.tar');
run('git', ['archive', PIN, '--format=tar', '--output=' + upstreamArchive], base);
run('tar', ['-xf', upstreamArchive, '-C', source], work);
const lockHash = sha(fs.readFileSync(path.join(source, 'pnpm-lock.yaml')));
if (sha(fs.readFileSync(path.join(base, 'pnpm-lock.yaml'))) !== lockHash) throw Error('Dependency lock differs from pinned source');
const dependencyEvidence = path.join(base, 'support-templates-dependency-evidence.json');
if (!fs.existsSync(dependencyEvidence)) throw Error('Use a clean frozen dependency checkout with support-templates-dependency-evidence.json');
const evidence = JSON.parse(fs.readFileSync(dependencyEvidence, 'utf8'));
if (evidence.upstreamCommit !== PIN || evidence.lockSha256 !== lockHash || evidence.packageManager !== 'pnpm@11.9.0' || evidence.method !== 'isolated-checkout-frozen-lockfile') throw Error('Invalid dependency evidence');
const copyTree = (from, to) => {
    for (const file of files(from)) {
        const target = path.join(to, path.relative(from, file)); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(file, target);
    }
};
const edit = (file, needle, replacement) => {
    const absolute = path.join(source, file), text = fs.readFileSync(absolute, 'utf8');
    const next = text.replace(needle, replacement); if (next === text) throw Error('Pinned transformation failed: ' + file); fs.writeFileSync(absolute, next);
};
const upstreamPlugins = files(path.join(source, 'src/plugins')).map(file => ({ path: path.relative(source, file).replaceAll('\\','/'), sha256: sha(fs.readFileSync(file)) }));
// Freeze current plugin bytes, including uncommitted changes; record content identity explicitly.
const plugin = path.join(source, 'src/userplugins/supportTemplates');
copyTree(path.join(root, 'src/vencord'), plugin); copyTree(path.join(root, 'src/core'), path.join(plugin, 'core'));
const pluginInputs = files(plugin).map(file => ({ path: path.relative(plugin, file).replaceAll('\\','/'), sha256: sha(fs.readFileSync(file)) }));
const pluginSourceHash = sha(JSON.stringify(pluginInputs));
const pluginCommit = run('git',['rev-parse','HEAD'],root).toString().trim();
edit('src/userplugins/supportTemplates/buildInfo.ts', 'export const PLUGIN_VERSION = "1.0.0";', `export const PLUGIN_VERSION = ${JSON.stringify(config.version)};`);
edit('src/userplugins/supportTemplates/buildInfo.ts', '"source"', JSON.stringify(`${config.version}+${pluginCommit.slice(0, 12)} · source ${pluginSourceHash.slice(0, 12)}`));
edit('src/userplugins/supportTemplates/index.tsx', 'name: "SupportTemplates",', 'name: "SupportTemplates",\n    enabledByDefault: true,');
edit('src/api/Settings.ts', 'autoUpdate: true,', 'autoUpdate: false,');
edit('src/main/patcher.ts', /    \/\/ Repatch after host updates[\s\S]*?\r?\n    }\r?\n/, '    // Full Vencord host repair is explicit via repair.bat.\n');
const buildTimestamp = Number(run('git', ['show','-s','--format=%ct',PIN], base).toString().trim()) * 1000;
const recipe = { schema: 1, variant: 'vencord-full', version: config.version, upstreamCommit: PIN, pluginCommit, pluginSourceHash, pluginInputs, buildTimestamp, node: process.version, packageManager: evidence.packageManager, lockSha256: lockHash, upstreamPlugins };
fs.writeFileSync(path.join(source, 'vencord-full-build.json'), JSON.stringify(recipe, null, 2));
copyTree(here, path.join(source, 'distribution/vencord'));
copyTree(path.join(root, 'distribution/updater'), path.join(source, 'distribution/updater'));
fs.copyFileSync(path.join(root, 'distribution/config.json'), path.join(source, 'distribution/config.json'));
fs.copyFileSync(path.join(here, 'rebuild.mjs'), path.join(source, 'rebuild.mjs'));
if (!fs.existsSync(path.join(source, 'distribution/updater/index.cjs'))) throw Error('Shared updater implementation is not ready');
fs.symlinkSync(path.join(base, 'node_modules'), path.join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
console.log('Staged pinned full Vencord sources: ' + source);
try { console.log(run(process.execPath, ['rebuild.mjs'], source).toString()); }
catch (error) { process.stderr.write(error.stderr ?? ''); throw error; }
for (const entry of upstreamPlugins) if (sha(fs.readFileSync(path.join(source, entry.path))) !== entry.sha256) throw Error('Ordinary upstream plugin changed');
const renderer = fs.readFileSync(path.join(source, 'dist/renderer.js'), 'utf8');
const patcher = fs.readFileSync(path.join(source, 'dist/patcher.js'), 'utf8');
if (!renderer.includes('SupportTemplates') || !patcher.includes('panelVaultSave') || !patcher.includes('Updater Disabled: true') || !renderer.includes('Updater Disabled: true')) throw Error('Runtime verification failed');
const packageName = `SupportTemplates-vencord-${config.version}`;
const output = path.join(work, packageName); fs.mkdirSync(output);
const runtime = path.join(output, 'payload/runtime');
copyTree(path.join(source, 'dist'), runtime);
copyTree(path.join(source, 'distribution/vencord/runtime'), runtime);
copyTree(path.join(source, 'distribution/updater'), path.join(runtime, 'updater'));
fs.copyFileSync(path.join(source, 'distribution/config.json'), path.join(runtime, 'release-config.json'));
fs.writeFileSync(path.join(output, 'payload/loader.asar'), createLoaderAsar({ 'index.js': fs.readFileSync(path.join(runtime, 'loader.cjs')), 'package.json': JSON.stringify({ name: 'support-templates-vencord-loader', version: config.version, main: 'index.js' }) }));
const payload = files(path.join(output, 'payload')).map(file => ({ path: path.relative(output, file).replaceAll('\\','/'), size: fs.statSync(file).size, sha256: sha(fs.readFileSync(file)) }));
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ schema: 1, product: 'SupportTemplatesVencord', variant: 'vencord-full', releaseVariant: 'vencord', version: config.version, upstreamCommit: PIN, pluginCommit: recipe.pluginCommit, pluginSourceHash, updater: { upstreamDisabled: true, apply: 'startup', repository: config.releaseRepository }, files: payload }, null, 2));
copyTree(path.join(source, 'distribution/vencord/installer'), output);
fs.copyFileSync(path.join(here, 'README.md'), path.join(output, 'README.md'));
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(output, 'LICENSE-Vencord'));
fs.copyFileSync(path.join(source, 'vencord-full-build.json'), path.join(output, 'build-evidence.json'));
writeTar(source, path.join(output, 'source.tar'), { epoch: Math.floor(buildTimestamp / 1000) });
readPackage(output);
const zip = path.join(work, packageName + '.zip'); writeZip(output, zip);
fs.mkdirSync(outputRoot, { recursive: true });
const finalPackage = path.join(outputRoot, packageName), finalZip = finalPackage + '.zip';
// Never mix stale and new outputs under one version name.
if (fs.existsSync(finalPackage) || fs.existsSync(finalZip)) throw Error('Output already exists; choose a fresh DISTRIBUTION_OUTPUT_DIR');
fs.cpSync(output, finalPackage, { recursive: true, errorOnExist: true, force: false });
fs.copyFileSync(zip, finalZip, fs.constants.COPYFILE_EXCL);
console.log(JSON.stringify({ package: finalPackage, zip: finalZip, source }));
