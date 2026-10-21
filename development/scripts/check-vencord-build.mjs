// Build the current adapter in a disposable source copy, never in the installed Discord checkout.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.resolve(process.env.VENCORD_DIR ?? path.join(root, '../Vencord'));
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'support-templates-build-'));
const files = execFileSync('git', ['ls-files', '-z'], { cwd: base, encoding: 'utf8' }).split('\0').filter(Boolean);
for (const name of files) {
    if (name.startsWith('src/userplugins/')) continue;
    const target = path.resolve(staging, name);
    if (!target.startsWith(staging + path.sep)) throw new Error('Invalid source path');
    const source = path.join(base, name);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
}
fs.symlinkSync(path.join(base, 'node_modules'), path.join(staging, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const plugin = path.join(staging, 'src/userplugins/supportTemplates');
fs.cpSync(path.join(root, 'src/vencord'), plugin, { recursive: true });
fs.cpSync(path.join(root, 'src/core'), path.join(plugin, 'core'), { recursive: true });
const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: base, encoding: 'utf8' }).trim();
console.log('Isolated build source:', staging);
const result = spawnSync(process.execPath, ['scripts/build/build.mjs', '--disable-updater'], {
    cwd: staging, stdio: 'inherit', env: { ...process.env, VENCORD_HASH: hash, VENCORD_REMOTE: 'Vendicated/Vencord' }
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const patcher = fs.readFileSync(path.join(staging, 'dist/patcher.js'), 'utf8');
const renderer = fs.readFileSync(path.join(staging, 'dist/renderer.js'), 'utf8');
if (!patcher.includes('panelVaultAvailable') || !patcher.includes('panelVaultSave') || !renderer.includes('/sync/events')) {
    throw new Error('Current native vault/SSE adapter was not included');
}
console.log('Current native vault + renderer built successfully. Diagnostic artifacts only; not installed or released.');
