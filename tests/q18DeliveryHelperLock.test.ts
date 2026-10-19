import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const disk = require('../distribution/updater/storage.cjs');
const roots: string[] = [];
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
afterEach(() => {
    for (const root of roots.splice(0)) {
        if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('q18Delivery-lock-')) throw Error('Unsafe fixture cleanup');
        rmSync(root, { recursive: true, force: true });
    }
});

describe.skipIf(process.platform !== 'win32')('q18Delivery standalone receipt lock interoperability', () => {
    function fixture() {
        const root = mkdtempSync(path.join(os.tmpdir(), 'q18Delivery-lock-')); roots.push(root);
        const helper = path.resolve('standalone/runtime/update-helper.ps1');
        const script = path.join(root, 'fixture.ps1');
        const request = "@{repository='owner/releases';releaseChannel='canary';version='1.0.0-canary.2';sha256=('a'*64)}";
        const run = (before: string) => {
            writeFileSync(script, `$ErrorActionPreference='Stop'\n. ${psQuote(helper)}\n${before}\nWrite-UpdateReceipt ${request} ${psQuote(root)}\n`);
            return spawnSync(path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
                ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        };
        return { root, run };
    }

    // The Windows child itself has a 15s bound; the runner must allow startup and cleanup.
    it('recovers a helper crash after lock acquisition through the real shared engine protocol', async () => {
        const f = fixture();
        // Exit our own fixture child at the first receipt access, after acquiring its lock.
        const child = f.run("function Safe-UpdatePath([string]$Path) { if ([IO.Path]::GetFileName($Path) -ceq 'applied.json') { [Environment]::Exit(23) } }");
        expect(child.status, child.stderr).toBe(23);
        expect(existsSync(path.join(f.root, '.lock'))).toBe(true);
        await expect(disk.locked(f.root, async () => 'recovered')).resolves.toBe('recovered');
        expect(existsSync(path.join(f.root, '.lock'))).toBe(false);
    }, 20000);

    it('does not acknowledge pending state while a live engine owns the cache', async () => {
        const f = fixture();
        await disk.locked(f.root, async () => {
            const owner = readFileSync(path.join(f.root, '.lock'));
            const child = f.run('');
            expect(child.status, child.stderr).toBe(0);
            expect(readFileSync(path.join(f.root, '.lock'))).toEqual(owner);
            expect(existsSync(path.join(f.root, 'applied.json'))).toBe(false);
        });
    }, 20000);
});
