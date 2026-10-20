/* Copyright (c) 2026 SupportTemplates contributors. GPL-3.0-or-later. */
'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const resources = path.dirname(__dirname);
const original = path.join(resources, '_app.asar');
function safe(location) {
    let cursor = path.resolve(location);
    while (true) {
        if (fs.existsSync(cursor) && (fs.lstatSync(cursor).isSymbolicLink() || fs.realpathSync(cursor).toLowerCase() !== cursor.toLowerCase())) throw Error('Redirected loader path');
        const parent = path.dirname(cursor); if (parent === cursor) return; cursor = parent;
    }
}
const relative = path.relative(process.env.LOCALAPPDATA, resources);
const match = /^(DiscordCanary|Discord)[\\/]app-\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?[\\/]resources$/i.exec(relative);
if (!match) throw Error('Unsupported Discord location');
safe(resources); safe(original);
function vanilla() {
    const pkg = require(path.join(original, 'package.json'));
    app.setAppPath(original); require.main.filename = path.join(original, pkg.main);
    require(require.main.filename);
}
let nativeStarted = false;
(async () => {
    if (process.argv.includes('--vanilla')) return vanilla();
    const config = JSON.parse(fs.readFileSync(path.join(resources, 'support-templates-vencord.json'), 'utf8').replace(/^\uFEFF/, ''));
    const channel = match[1].toLowerCase() === 'discordcanary' ? 'canary' : 'stable';
    if (config.schema !== 1 || config.product !== 'SupportTemplatesVencord' || config.channel !== channel) throw Error('Invalid loader configuration');
    const channelRoot = path.join(process.env.LOCALAPPDATA, 'SupportTemplatesVencord/channels', channel);
    const baseRoot = path.dirname(config.runtime);
    const rel = path.relative(path.join(channelRoot, 'versions'), baseRoot);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(rel) || path.basename(config.runtime) !== 'runtime') throw Error('Runtime outside owned cache');
    const launchPath = path.join(config.runtime, 'launch.cjs'); safe(launchPath);
    const { launch } = require(launchPath);
    await launch({ channelRoot, baseRoot, app, loadNative(file) { nativeStarted = true; require(file); } });
})().catch(error => {
    console.error('[VencordFull] Startup failed.', error);
    // Do not run Discord twice if an error happened after its native startup began.
    if (!nativeStarted) vanilla();
});
