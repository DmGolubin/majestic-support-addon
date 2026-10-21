/* Copyright (c) 2026 SupportTemplates contributors. GPL-3.0-or-later. */
'use strict';
// Electron's patched fs exposes .asar as a virtual directory. Integrity checks
// must inspect the physical archive bytes, just as the installer does.
const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path');
const crypto = require('crypto');
const PIN = '32c90633ce6a95d7e56c95479efbb431bacf1eac';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function safe(location) {
    let cursor = path.resolve(location);
    while (true) {
        try {
            const stat = fs.lstatSync(cursor);
            if (stat.isSymbolicLink() || fs.realpathSync(cursor).toLowerCase() !== cursor.toLowerCase()) throw Error('Redirected path');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const parent = path.dirname(cursor);
        if (parent === cursor) return;
        cursor = parent;
    }
}
function version(value) {
    if (typeof value !== 'string' || value.length > 120 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value)) throw Error('Invalid version');
    return value;
}
function json(file) {
    safe(file);
    if (fs.statSync(file).size > 8388608) throw Error('JSON too large');
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function files(root) {
    safe(root);
    return fs.readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name < b.name ? -1 : 1).flatMap(entry => {
        const file = path.join(root, entry.name); safe(file);
        if (entry.isDirectory()) return files(file);
        if (!entry.isFile()) throw Error('Not a regular file');
        return [file];
    });
}
function readPackage(root, stored = false) {
    const manifestPath = path.join(root, 'manifest.json');
    const manifest = json(manifestPath);
    if (manifest.schema !== 1 || manifest.product !== 'SupportTemplatesVencord' || manifest.variant !== 'vencord-full'
        || typeof manifest.upstreamCommit !== 'string' || !/^[a-f0-9]{40}$/i.test(manifest.upstreamCommit)) throw Error('Wrong package identity');
    version(manifest.version);
    if (!Array.isArray(manifest.files) || manifest.files.length < 5) throw Error('Missing payload');
    const seen = new Map();
    for (const entry of manifest.files) {
        if (typeof entry.path !== 'string' || !/^payload\/(loader\.asar|runtime\/[A-Za-z0-9_+@.-]+(?:\/[A-Za-z0-9_+@.-]+)*)$/.test(entry.path)
            || entry.path.split('/').some(p => p === '.' || p === '..' || p.endsWith('.') || /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(p))
            || seen.has(entry.path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw Error('Unsafe manifest entry');
        const file = path.join(root, stored ? entry.path.slice(8) : entry.path);
        safe(file);
        if (!fs.statSync(file).isFile() || fs.statSync(file).size !== entry.size || sha(fs.readFileSync(file)) !== entry.sha256) throw Error('Payload integrity failure: ' + entry.path);
        seen.set(entry.path.toLowerCase(), file);
    }
    for (const name of ['loader.asar','runtime/patcher.js','runtime/preload.js','runtime/renderer.js','runtime/renderer.css','runtime/launch.cjs','runtime/release-config.json','runtime/updater/index.cjs']) {
        if (!seen.has('payload/' + name)) throw Error('Required file missing: ' + name);
    }
    const actual = files(stored ? root : path.join(root, 'payload')).filter(f => !stored || path.relative(root, f) !== 'manifest.json');
    if (actual.length !== seen.size || actual.some(f => !seen.has((stored ? 'payload/' : '') + path.relative(root, f).replaceAll('\\', '/').toLowerCase()))) throw Error('Unlisted payload');
    return { manifest, manifestHash: sha(fs.readFileSync(manifestPath)), root };
}
function atomicJson(file, value) {
    safe(file);
    const temporary = file + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
    const fd = fs.openSync(temporary, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
}
module.exports = { PIN, sha, safe, version, json, files, readPackage, atomicJson };
