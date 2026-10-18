// Build dependencies belong to a clean pinned checkout, never the installed Vencord.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'standalone/config.json')));
const sourceRepo = path.resolve(process.env.VENCORD_DIR ?? path.join(root, '../Vencord'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'support-templates-release-deps-'));
const checkout = path.join(workspace, 'Vencord');
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });
run('git', ['clone', '--no-checkout', '--shared', sourceRepo, checkout]);
run('git', ['checkout', '--detach', config.upstreamCommit], checkout);
// Use the pnpm version pinned by upstream; a missing/mismatched tool fails the build.
const pkg = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json')));
if (!/^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager)) throw new Error('Unsupported package manager pin');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const manager = ['exec', '--yes', `--package=${pkg.packageManager}`, '--', 'pnpm'];
const version = execFileSync(npm, [...manager, '--version'], { cwd: checkout, shell: process.platform === 'win32', encoding: 'utf8' }).trim();
if (`pnpm@${version}` !== pkg.packageManager) throw new Error(`Required ${pkg.packageManager}, found pnpm@${version}`);
execFileSync(npm, [...manager, 'install', '--frozen-lockfile'], { cwd: checkout, shell: process.platform === 'win32', stdio: 'inherit' });
const lock = fs.readFileSync(path.join(checkout, 'pnpm-lock.yaml'));
const evidence = { upstreamCommit: config.upstreamCommit, packageManager: pkg.packageManager,
    lockSha256: createHash('sha256').update(lock).digest('hex'), node: process.version,
    method: 'isolated-checkout-frozen-lockfile', checkout };
fs.writeFileSync(path.join(checkout, 'support-templates-dependency-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
