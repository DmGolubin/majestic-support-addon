import { execFileSync } from 'node:child_process';

const inputs = ['src', 'standalone', 'distribution'];

export function cleanBuildCommit(root) {
    const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--ignored', '--', ...inputs], { cwd: root, encoding: 'utf8' });
    if (status.trim()) throw new Error('Build inputs in src/, standalone/ or distribution/ are dirty; commit or remove changes before building.');
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

// Extract committed bytes only: subsequent checkout edits cannot alter build inputs.
// Destination must already exist and be an isolated temporary directory.
export function extractBuildSnapshot(root, commit, destination) {
    const archive = execFileSync('git', ['archive', '--format=tar', commit, '--', ...inputs], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', destination], { input: archive });
}
