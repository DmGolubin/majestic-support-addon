/* Copyright (c) 2026 SupportTemplates contributors. GPL-3.0-or-later. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { safe, readPackage, atomicJson, version, files } = require('./package.cjs');
function extract(archive, destination) {
    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    execFileSync(powershell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'extract.ps1'),'-Archive',archive,'-Destination',destination], { windowsHide: true, timeout: 120000, stdio: 'pipe' });
}
function createAdapter({ channelRoot, base, startupBarrier, extractArchive = extract }) {
    return {
        canApplyNative: async context => context.phase === 'startup' && startupBarrier(),
        async apply(context) {
            if (context.phase !== 'startup' || !startupBarrier() || context.asset.kind !== 'native') return { applied: false, reason: 'Full Vencord applies only before native startup' };
            version(context.version);
            safe(channelRoot); safe(context.assetPath);
            const unpack = path.join(channelRoot, '.unpack-' + crypto.randomBytes(16).toString('hex'));
            await extractArchive(context.assetPath, unpack);
            const roots = fs.readdirSync(unpack);
            if (roots.length !== 1) throw Error('Expected one ZIP package root');
            const source = path.join(unpack, roots[0]);
            const incoming = readPackage(source);
            if (incoming.manifest.version !== context.version) throw Error('Release/package version mismatch');
            const target = path.join(channelRoot, 'versions', context.version); safe(target);
            if (fs.existsSync(target)) {
                if (readPackage(target, true).manifestHash !== incoming.manifestHash) throw Error('Immutable version collision');
            } else {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                const stage = path.join(channelRoot, '.version-' + crypto.randomBytes(16).toString('hex'));
                fs.mkdirSync(stage);
                for (const file of files(path.join(source, 'payload'))) {
                    const dest = path.join(stage, path.relative(path.join(source, 'payload'), file));
                    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
                }
                fs.copyFileSync(path.join(source, 'manifest.json'), path.join(stage, 'manifest.json'), fs.constants.COPYFILE_EXCL);
                readPackage(stage, true);
                fs.renameSync(stage, target);
            }
            // Only the pointer changes. Already running Discord instances retain immutable old files.
            atomicJson(path.join(channelRoot, 'active.json'), { schema: 1, baseVersion: base.manifest.version, baseManifestHash: base.manifestHash, version: context.version, manifestHash: incoming.manifestHash });
            return { applied: true };
        }
    };
}
module.exports = { createAdapter, extract };
