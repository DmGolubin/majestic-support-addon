/* Copyright (c) 2026 SupportTemplates contributors. GPL-3.0-or-later. */
'use strict';
const fs = require('fs');
const path = require('path');
const { safe, json, version, readPackage } = require('./package.cjs');
const { createAdapter } = require('./adapter.cjs');
function selected(channelRoot, base) {
    const pointer = path.join(channelRoot, 'active.json'); safe(pointer);
    if (!fs.existsSync(pointer)) return base;
    const active = json(pointer);
    if (active.schema !== 1 || active.baseVersion !== base.manifest.version || active.baseManifestHash !== base.manifestHash) return base;
    const candidate = readPackage(path.join(channelRoot, 'versions', version(active.version)), true);
    if (candidate.manifestHash !== active.manifestHash) throw Error('Active manifest changed');
    return candidate;
}
async function launch({ channelRoot, baseRoot, loadNative, app, onError = console.error }) {
    const base = readPackage(baseRoot, true);
    let current = base;
    try { current = selected(channelRoot, base); } catch (error) { onError('[VencordFull] Invalid startup selection; using installed base.', error); }
    let barrier = true;
    let updater;
    // Async disk verification must not let Electron's one-shot ready events pass
    // before Discord's original entrypoint has registered its listeners.
    const originalEmit = app.emit;
    const startupEvents = [];
    app.emit = function (event, ...args) {
        if (barrier && (event === 'ready' || event === 'will-finish-launching')) {
            startupEvents.push([event, ...args]); return false;
        }
        return originalEmit.call(this, event, ...args);
    };
    try {
        // Config and updater implementation travel with the selected immutable release.
        const runtime = path.join(current.root, 'runtime');
        const config = json(path.join(runtime, 'release-config.json'));
        const { createUpdater } = require(path.join(runtime, 'updater/index.cjs'));
        updater = createUpdater({ config, variant: 'vencord', currentVersion: current.manifest.version, baseVersion: current.manifest.version,
            stagingDir: path.join(channelRoot, 'updates'), adapter: createAdapter({ channelRoot, base, startupBarrier: () => barrier }),
            onEvent: event => { if (event.type === 'error') onError('[VencordFull] Update unavailable; retrying later.', event.code); } });
        await updater.applyPending({ phase: 'startup' });
        current = selected(channelRoot, base);
    } catch (error) { onError('[VencordFull] Pending update retained; starting verified runtime.', error); }
    barrier = false;
    process.env.DISABLE_UPDATER_AUTO_PATCHING = '1';
    try { loadNative(path.join(current.root, 'runtime/patcher.js')); }
    finally {
        app.emit = originalEmit;
        for (const event of startupEvents) originalEmit.apply(app, event);
    }
    // No automatic reload, relaunch, or quit. The user chooses when to restart.
    if (updater) {
        updater.start();
        app.on('will-quit', () => { void updater.stop().catch(onError); });
    }
    return current;
}
module.exports = { launch, selected };
