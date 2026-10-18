'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { assert } = require('./validation.cjs');
const disk = require('./storage.cjs');

// Atomic replacement of a self-contained BetterDiscord plugin. The engine owns
// download/verification/lifecycle; this adapter never requests a reload or exit.
function createFileAdapter({ targetPath, canApplyNative }) {
    assert(typeof targetPath === 'string' && path.isAbsolute(targetPath) && targetPath.endsWith('.plugin.js'), 'INVALID_PLUGIN_TARGET');
    return {
        canApplyNative,
        async apply({ assetPath, asset, variant, phase }) {
            assert(variant === 'betterdiscord' && asset.name.endsWith('.plugin.js'), 'INVALID_PLUGIN_ASSET');
            // BetterDiscord may watch plugin files and hot-reload on replacement.
            // Use a real startup/closed lifecycle point to preserve open drafts.
            if (phase !== 'startup' && phase !== 'app-closed') return { applied: false, reason: 'restart-required' };
            await disk.safePath(targetPath);
            const stat = await fs.stat(path.dirname(targetPath));
            assert(stat.isDirectory(), 'INVALID_PLUGIN_DIRECTORY');
            await disk.verify(assetPath, asset);
            const temp = `${targetPath}.${randomUUID()}.tmp`;
            try {
                // Exclusive file and hash recheck ensure the staged source cannot
                // change unnoticed between initial verification and replacement.
                await fs.copyFile(assetPath, temp, require('node:fs').constants.COPYFILE_EXCL);
                await disk.verify(temp, asset);
                const handle = await fs.open(temp, 'r+');
                try { await handle.sync(); } finally { await handle.close(); }
                await disk.safePath(targetPath);
                await fs.rename(temp, targetPath);
                return { applied: true };
            } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        }
    };
}
module.exports = { createFileAdapter };
