/* SPDX-License-Identifier: GPL-3.0-or-later */
"use strict";
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function safePath(location) {
    let cursor = path.resolve(location);
    for (;;) {
        if (fs.existsSync(cursor) && (fs.lstatSync(cursor).isSymbolicLink()
            || fs.realpathSync(cursor).toLowerCase() !== cursor.toLowerCase())) throw new Error('Redirected update path');
        const parent = path.dirname(cursor);
        if (parent === cursor) return;
        cursor = parent;
    }
}
function under(location, root) {
    const relative = path.relative(root, location);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function launchUpdateHelper({ pending, channel, channelRoot, helperPath, parentPid, currentVersion }, spawnProcess = spawn) {
    if (!['canary', 'stable', 'ptb'].includes(channel) || !Number.isSafeInteger(parentPid) || parentPid < 1)
        throw new Error('Invalid host identity');
    if (pending.variant !== 'standalone' || !/^[a-f0-9]{64}$/.test(pending.asset.sha256)
        || !Number.isSafeInteger(pending.asset.size) || pending.asset.size <= 0
        || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(pending.version))
        throw new Error('Invalid staged standalone package');
    const staging = path.join(channelRoot, 'auto-updates');
    if (!under(pending.assetPath, staging)) throw new Error('Staged package escapes updater cache');
    for (const location of [channelRoot, staging, pending.assetPath, helperPath]) safePath(location);
    const requests = path.join(staging, 'handoff');
    safePath(requests);
    fs.mkdirSync(requests, { recursive: true });
    const requestPath = path.join(requests, `${pending.asset.sha256}-${parentPid}.json`);
    safePath(requestPath);
    const request = JSON.stringify({ schema: 1, variant: 'standalone', channel, parentPid, currentVersion,
        repository: pending.manifest.repository, releaseChannel: pending.channel,
        version: pending.version, assetPath: pending.assetPath, sha256: pending.asset.sha256, size: pending.asset.size });
    // A helper reads immutable inputs, never a mutable latest-release pointer.
    try {
        const fd = fs.openSync(requestPath, 'wx');
        try { fs.writeFileSync(fd, request); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (error) {
        if (error.code !== 'EEXIST' || fs.readFileSync(requestPath, 'utf8') !== request) throw error;
    }
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await new Promise((resolve, reject) => {
        const child = spawnProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-WindowStyle', 'Hidden', '-File', helperPath, '-RequestPath', requestPath],
        { detached: true, windowsHide: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
    });
}
module.exports = { launchUpdateHelper, safePath };
