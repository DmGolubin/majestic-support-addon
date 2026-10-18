// Prepare an isolated build; never copy into the installed Vencord or Discord.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createLoaderAsar } from './asar.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.resolve(process.env.VENCORD_DIR ?? path.join(root, '../Vencord'));
const config = JSON.parse(fs.readFileSync(path.join(root, 'standalone/config.json'), 'utf8'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'support-templates-standalone-'));
const source = path.join(work, 'source'); fs.mkdirSync(source);
const output = path.join(work, `SupportTemplates-${config.version}`); fs.mkdirSync(output);
const exec = (command, args, cwd = source) => execFileSync(command, args, { cwd, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
const put = (file, value) => { const dest = path.join(source, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, value); };
const alter = (file, needle, replacement) => {
    const old = fs.readFileSync(path.join(source, file), 'utf8');
    const next = old.replace(needle, replacement);
    if (next === old) throw new Error(`Pinned-source transform no longer matches: ${file}`);
    put(file, next);
};
const archive = path.join(work, 'upstream.tar');
exec('git', ['archive', config.upstreamCommit, '--format=tar', `--output=${archive}`], base);
exec('tar', ['-xf', archive, '-C', source]);
// No local plugin/settings/history is taken from the installed checkout.
fs.cpSync(path.join(root, 'src/vencord'), path.join(source, 'src/userplugins/supportTemplates'), { recursive: true });
fs.cpSync(path.join(root, 'src/core'), path.join(source, 'src/userplugins/supportTemplates/core'), { recursive: true });
fs.cpSync(path.join(root, 'standalone/runtime'), path.join(source, 'src/standalone'), { recursive: true });
fs.copyFileSync(path.join(root, 'standalone/compile.mjs'), path.join(source, 'compile.mjs'));
config.timestamp = Number(exec('git', ['show', '-s', '--format=%ct', config.upstreamCommit], base).toString().trim()) * 1000;
put('standalone-config.json', JSON.stringify(config, null, 2));
alter('src/main/patcher.ts', /import \{ onceDefined \} from "@shared\/onceDefined";\r?\n/, '');
alter('src/main/patcher.ts', /    \/\/ Repatch after host updates[\s\S]*?\r?\n    }\r?\n/, '    // Host repair is explicit through repair.bat.\n');
alter('src/main/patcher.ts', /    \/\/ Patch appSettings[\s\S]*?process\.env\.DATA_DIR = .*?;\r?\n/, '');
alter('src/main/utils/constants.ts', /export const DATA_DIR = [\s\S]*?\r?\n\);/, 'export const DATA_DIR = process.env.SUPPORT_TEMPLATES_DATA_DIR!;\nif (!DATA_DIR) throw new Error("SupportTemplates must be started by its installed loader");');
alter('src/api/DataStore/index.ts', /createStore\(!IS_REPORTER \? "VencordData" : "VencordDataReporter", "VencordStore"\)/,
    'createStore("SupportTemplatesStandaloneData", "SupportTemplatesStandaloneStore")');
alter('src/shared/IpcEvents.ts', /"Vencord/g, '"SupportTemplatesStandalone');
alter('src/main/ipcPlugins.ts', /`VencordPluginNative_/g, '`SupportTemplatesStandaloneNative_');
alter('src/api/Settings.ts', /autoUpdate: true,/, 'autoUpdate: false,');
alter('src/api/Settings.ts', /useQuickCss: true,/, 'useQuickCss: false,');
// Badges imports its own plugin and the entire settings/cloud UI. This app exposes no badge API.
alter('src/api/PluginManager.ts', /import \{ addProfileBadge, removeProfileBadge \} from "@api\/Badges";/,
    'const addProfileBadge = (..._args: unknown[]): void => { throw new Error("Badges are not included in SupportTemplates"); };\nconst removeProfileBadge = addProfileBadge;');
alter('src/main/csp/index.ts', /export const CspPolicies: PolicyMap = \{[\s\S]*?\r?\n};/,
    'export const CspPolicies: PolicyMap = { "https://panel.majestic-rp.tech": ConnectSrc };');
// Ignore inherited overrides even if a settings file is manually copied into this isolated profile.
alter('src/main/csp/index.ts', /Object\.entries\(NativeSettings\.store\.customCspRules\)/, 'Object.entries({} as PolicyMap)');
fs.symlinkSync(path.join(base, 'node_modules'), path.join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
console.log(`Prepared source: ${source}`);
try { console.log(exec(process.execPath, ['compile.mjs']).toString()); }
catch (error) { process.stderr.write(error.stderr ?? ''); throw error; }
const payload = path.join(output, 'payload'); fs.mkdirSync(payload);
fs.cpSync(path.join(source, 'dist'), path.join(payload, 'runtime'), { recursive: true });
const loader = fs.readFileSync(path.join(root, 'standalone/runtime/loader.cjs'));
fs.writeFileSync(path.join(payload, 'loader.asar'), createLoaderAsar({ 'index.js': loader,
    'package.json': JSON.stringify({ name: 'support-templates-loader', version: config.version, main: 'index.js' }) }));
const files = [];
function manifestFiles(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, item.name);
        if (item.isDirectory()) manifestFiles(absolute);
        else { const bytes = fs.readFileSync(absolute); files.push({ path: path.relative(output, absolute).replaceAll('\\', '/'), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
    }
}
manifestFiles(payload);
const pluginCommit = exec('git', ['rev-parse', 'HEAD'], root).toString().trim();
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ schema: 1, product: config.product, version: config.version, upstreamCommit: config.upstreamCommit, pluginCommit, files }, null, 2));
fs.cpSync(path.join(source, 'build-evidence'), path.join(output, 'build-evidence'), { recursive: true });
for (const entry of fs.readdirSync(path.join(root, 'standalone/installer'))) fs.cpSync(path.join(root, 'standalone/installer', entry), path.join(output, entry), { recursive: true });
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(output, 'LICENSE-Vencord'));
fs.copyFileSync(path.join(root, 'standalone/README.md'), path.join(output, 'README.md'));
fs.cpSync(path.join(root, 'standalone'), path.join(output, 'build-recipe'), { recursive: true });
// Exact modified sources and lockfile; no node_modules, Git history, credentials or user settings.
exec('tar', ['-cf', path.join(output, 'source.tar'), 'src', 'scripts', 'packages', 'patches', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'LICENSE', 'compile.mjs', 'standalone-config.json']);
const zip = output + '.zip';
exec('tar', ['-a', '-cf', zip, '-C', work, path.basename(output)]);
console.log(JSON.stringify({ package: output, zip, source, files: files.length }, null, 2));
