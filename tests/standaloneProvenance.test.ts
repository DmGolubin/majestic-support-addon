import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanBuildCommit, extractBuildSnapshot } from '../standalone/provenance.mjs';

const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'support-provenance-test-'));
    fixtures.push(root);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const put = (name: string, text = 'committed') => {
        const file = path.join(root, name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
    };
    git('init', '--quiet');
    put('src/core/input.ts');
    put('standalone/config.json');
    put('standalone/runtime/loader.cjs');
    put('standalone/installer/install.bat');
    put('standalone/compile.mjs');
    put('distribution/config.json');
    put('distribution/updater/index.cjs');
    put('docs/audit.md');
    put('.gitignore', 'src/ignored/\n');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    return { root, git, put };
}

describe('standalone build provenance', () => {
    it('accepts clean inputs and returns their full commit', () => {
        const f = fixture();
        expect(cleanBuildCommit(f.root)).toBe(f.git('rev-parse', 'HEAD'));
    });
    it.each(['src/core/input.ts', 'standalone/config.json', 'distribution/config.json', 'distribution/updater/index.cjs'])('rejects tracked edits in %s', name => {
        const f = fixture(); f.put(name, 'dirty');
        expect(() => cleanBuildCommit(f.root)).toThrow(/Build inputs.*dirty/);
    });
    it('rejects staged edits', () => {
        const f = fixture(); f.put('src/core/input.ts', 'staged'); f.git('add', 'src');
        expect(() => cleanBuildCommit(f.root)).toThrow(/dirty/);
    });
    it.each(['src/new file.ts', 'standalone/new.mjs', 'src/ignored/input.ts'])('rejects untracked or ignored production input %s', name => {
        const f = fixture(); f.put(name);
        expect(() => cleanBuildCommit(f.root)).toThrow(/dirty/);
    });
    it('accepts unrelated tracked, staged and untracked docs/audits/graph outputs', () => {
        const f = fixture(); f.put('docs/audit.md', 'staged'); f.git('add', 'docs');
        f.put('docs/audit.md', 'unstaged too');
        f.put('docs/audits/new.md'); f.put('graphify-out/manifest.json');
        expect(cleanBuildCommit(f.root)).toBe(f.git('rev-parse', 'HEAD'));
    });
    it('extracts only the captured committed production inputs despite later edits and commits', () => {
        const f = fixture(); const commit = cleanBuildCommit(f.root);
        for (const name of ['src/core/input.ts', 'standalone/config.json', 'standalone/runtime/loader.cjs', 'standalone/installer/install.bat', 'standalone/compile.mjs']) f.put(name, 'later');
        f.git('add', '.');
        f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'later');
        f.put('src/untracked.ts', 'not archived');
        const destination = path.join(f.root, 'snapshot'); mkdirSync(destination);
        extractBuildSnapshot(f.root, commit, destination);
        expect(readFileSync(path.join(destination, 'distribution/updater/index.cjs'), 'utf8')).toBe('committed');
        for (const name of ['src/core/input.ts', 'standalone/config.json', 'standalone/runtime/loader.cjs', 'standalone/installer/install.bat', 'standalone/compile.mjs']) expect(readFileSync(path.join(destination, name), 'utf8')).toBe('committed');
        expect(() => readFileSync(path.join(destination, 'src/untracked.ts'))).toThrow();
        expect(() => readFileSync(path.join(destination, 'docs/audit.md'))).toThrow();
    });
    it('runs preflight before temporary setup and uses frozen paths throughout packaging', () => {
        const build = readFileSync(new URL('../standalone/build.mjs', import.meta.url), 'utf8');
        expect(build.indexOf('cleanBuildCommit(root)')).toBeLessThan(build.indexOf('fs.mkdtempSync'));
        expect(build).not.toMatch(/path\.join\(root, '(src|standalone)\//);
        expect(build).toContain('extractBuildSnapshot(root, pluginCommit, frozen)');
    });
});
