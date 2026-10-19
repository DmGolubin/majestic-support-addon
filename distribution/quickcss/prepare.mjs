// Isolated build dependencies only; never installs or changes Discord.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'support-templates-quickcss-deps-'));
for (const file of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) fs.copyFileSync(path.join(here, file), path.join(workspace, file));
const manager = JSON.parse(fs.readFileSync(path.join(here, 'package.json'))).packageManager;
if (manager !== 'pnpm@11.9.0') throw Error('Unexpected QuickCSS package manager');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = ['exec', '--yes', `--package=${manager}`, '--', 'pnpm'];
const options = { cwd: workspace, shell: process.platform === 'win32', encoding: 'utf8' };
if (execFileSync(npm, [...args, '--version'], options).trim() !== '11.9.0') throw Error('Incorrect pnpm version');
execFileSync(npm, [...args, 'install', '--frozen-lockfile', '--ignore-scripts'], { ...options, stdio: 'inherit' });
console.log(JSON.stringify({ dependencies: workspace, packageManager: manager, method: 'isolated-frozen-lockfile-ignore-scripts', lockSha256: createHash('sha256').update(fs.readFileSync(path.join(workspace, 'pnpm-lock.yaml'))).digest('hex') }));
