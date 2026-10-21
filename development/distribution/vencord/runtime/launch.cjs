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
    // Discord/Sentry must initialize before Electron becomes ready. Replaying
    // ready events cannot rewind app.isReady(); never await before loadNative.
    process.env.DISABLE_UPDATER_AUTO_PATCHING = '1';
    loadNative(path.join(current.root, 'runtime/patcher.js'));
    let running = true;
    let updater;
    app.once('will-quit', () => {
        running = false;
        if (updater) void updater.stop().catch(onError);
    });
    const prepare = () => updater.applyPending({ phase: 'next-startup' })
        .catch(error => onError('[VencordFull] Pending update retained for a later attempt.', error));
    try {
        // Config and updater implementation travel with the selected immutable release.
        const runtime = path.join(current.root, 'runtime');
        const config = json(path.join(runtime, 'release-config.json'));
        const { createUpdater } = require(path.join(runtime, 'updater/index.cjs'));
        updater = createUpdater({ config, variant: 'vencord', currentVersion: current.manifest.version, baseVersion: current.manifest.version,
            stagingDir: path.join(channelRoot, 'updates'), adapter: createAdapter({ channelRoot, base, prepareNextStartup: () => running }),
            onEvent: event => {
                if (event.type === 'error') onError('[VencordFull] Update unavailable; retrying later.', event.code);
                if (running && event.type === 'staged') void prepare();
            } });
        // Only immutable cache files and the NEXT launch pointer change here.
        // This instance keeps the already selected native/preload/renderer paths.
        await prepare();
        if (running) updater.start();
    } catch (error) { onError('[VencordFull] Update unavailable; running verified runtime.', error); }
    return current;
}
module.exports = { launch, selected };
