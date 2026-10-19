// Offline release check: execute exact packaged source-map modules with host/state mocks.
// This verifies packaging and diagnostic integration, not Discord's webpack/React host.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'betterdiscord/package.json'));
const { build } = require('esbuild');
const release = path.resolve(process.argv[2]);
const resultFile = path.resolve(process.argv[3]);
if (fs.existsSync(resultFile)) throw Error('Refusing to overwrite prior package evidence');
const releaseManifest = JSON.parse(fs.readFileSync(path.join(release, 'support-templates-update.json')));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const results = [];
const normalize = value => value.replaceAll('\r\n', '\n');
function memberPath(base, name) {
    if (typeof name !== 'string' || !name || /[\\:\u0000-\u001f\u007f]/.test(name)
        || name.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Unsafe package member path');
    const resolved = path.resolve(base, name);
    if (!resolved.startsWith(path.resolve(base) + path.sep)) throw Error('Package member escapes its directory');
    return resolved;
}

for (const variant of ['vencord', 'standalone']) {
    const assertions = [];
    const check = (name, condition) => { assert.ok(condition, `${variant}: ${name}`); assertions.push(name); };
    const asset = releaseManifest.assets.find(a => a.variant === variant);
    const archive = memberPath(release, asset.name);
    check('release archive hash', sha(fs.readFileSync(archive)) === asset.sha256);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'support-templates-package-qa-'));
    try {
    const entries = execFileSync('tar', ['-tf', archive], {encoding: 'utf8'}).trim().split(/\r?\n/)
        .map(name => name.replace(/^(\.\/)+/, '').replace(/\/$/, ''));
    for (const entry of entries) memberPath(dir, entry);
    const roots = new Set(entries.map(entry => entry.split('/')[0]));
    check('single archive root', roots.size === 1);
    const types = execFileSync('tar', ['-tvf', archive], {encoding: 'utf8'}).trim().split(/\r?\n/);
    check('archive has only regular files and directories', types.every(line => /^[d-]/.test(line)));
    execFileSync('tar', ['-xf', archive, '-C', dir]);
    const pkg = memberPath(dir, [...roots][0]);
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'manifest.json')));
    check('version matches release manifest', manifest.version === releaseManifest.version);
    for (const item of manifest.files) {
        const bytes = fs.readFileSync(memberPath(pkg, item.path));
        assert.equal(bytes.length, item.size); assert.equal(sha(bytes), item.sha256);
    }
    check('all payload hashes', manifest.files.length > 0);
    check('BAT installer, no EXE', fs.readdirSync(pkg).some(n => n.endsWith('.bat')) && !manifest.files.some(f => /\.exe$/i.test(f.path)));
    const runtime = path.join(pkg, 'payload/runtime');
    const map = JSON.parse(fs.readFileSync(path.join(runtime, 'renderer.js.map')));
    const sources = new Map();
    for (let i = 0; i < map.sources.length; i++) {
        const marker = 'src/userplugins/supportTemplates/';
        const offset = map.sources[i].indexOf(marker);
        if (offset >= 0) sources.set(map.sources[i].slice(offset + marker.length), map.sourcesContent[i]);
    }
    for (const file of ['core/diagnosticJournal.ts', 'core/panelTransport.ts', 'core/panelClient.ts',
        'core/panelEvents.ts', 'core/panelProtocol.ts', 'core/panelReminders.ts',
        'ui/diagnostics.ts', 'ui/DiagnosticControls.tsx', 'ui/Settings.tsx', 'ui/panel.ts',
        'ui/ticketReminders.ts', 'ui/Management.tsx', 'ui/Window.tsx', 'ui/LoginWindow.tsx']) {
        const original = path.join(root, file.startsWith('core/') ? 'src' : 'src/vencord', file);
        check(`packaged source matches ${file}`, normalize(sources.get(file)) === normalize(fs.readFileSync(original, 'utf8')));
    }
    check('correct distribution identity', sources.get('buildInfo.ts').includes(`"${variant}"`));
    const pluginSources = map.sources.filter(s => s.includes('/src/plugins/'));
    if (variant === 'standalone') {
        check('only essential upstream APIs', pluginSources.length === 2 && pluginSources.every(s => /\/(chatButtons\.ts|concatenatedComponentExtractor\.tsx)$/.test(s)));
    } else {
        check('ordinary Vencord plugins retained', pluginSources.length > 100);
        const evidence = JSON.parse(fs.readFileSync(path.join(pkg, 'build-evidence.json')));
        check('upstream preservation evidence', evidence.upstreamPlugins.length > 100);
    }
    const text = fs.readFileSync(path.join(runtime, 'renderer.js'), 'utf8');
    check('diagnostic persistence and request events in renderer', ['SupportTemplates_diagnostics_v1', 'request.failure', 'auth.terminated', 'SupportTemplates-diagnostics-'].every(s => text.includes(s)));
    execFileSync(process.execPath, ['--check', path.join(runtime, 'renderer.js')]);
    execFileSync(process.execPath, ['--check', path.join(runtime, 'patcher.js')]);
    execFileSync(process.execPath, ['--check', path.join(runtime, 'preload.js')]);
    check('renderer/native/preload syntax', true);

    const observers = new Set(), listeners = new Set(), timers = new Map(), persisted = new Map();
    const subscribe = cb => { observers.add(cb); return () => observers.delete(cb); };
    const mocks = {
        'ui/debug.ts': 'export const debugFileSnapshot=()=>({});',
        'ui/panel.ts': 'export const panel=globalThis.fixture.panel;',
        'ui/uiState.ts': 'export const ui=globalThis.fixture.ui;export const store=globalThis.fixture.store;'
    };
    const compiled = await build({
        stdin: { contents: 'export * from "./ui/diagnostics.ts";export {diagnosticJournal} from "./core/diagnosticJournal.ts";export {createPanelTransport} from "./core/panelTransport.ts";', resolveDir: '/', loader: 'ts' },
        bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{name: 'packaged-map', setup(b) {
            b.onResolve({filter: /.*/}, a => {
                const base = a.importer ? path.posix.dirname(a.importer) : '.';
                let name = path.posix.normalize(path.posix.join(base, a.path));
                if (!name.endsWith('.ts')) name += '.ts';
                if (!(name in mocks) && !sources.has(name)) throw Error(`Missing packaged module ${name}`);
                return {path: name, namespace: 'packaged'};
            });
            b.onLoad({filter: /.*/, namespace: 'packaged'}, a => ({contents: mocks[a.path] ?? sources.get(a.path), loader: 'ts'}));
        }}]
    });
    let timerId = 0, downloaded = null, clicked = false;
    const eventHost = {addEventListener: (name, cb) => listeners.add(cb), removeEventListener: (name, cb) => listeners.delete(cb)};
    const box = {
        module: {exports: {}}, exports: {}, console, Date, JSON, Blob, Response, Headers, TextDecoder, AbortController,
        URL: class extends URL {static createObjectURL(blob) {downloaded = blob; return 'blob:fixture';} static revokeObjectURL() {}},
        setTimeout: (cb, delay) => {timers.set(++timerId, {cb, delay}); return timerId;}, clearTimeout: id => timers.delete(id),
        navigator: {onLine: true},
        window: {...eventHost, innerWidth: 1280, innerHeight: 720, localStorage: {getItem: k => persisted.get(k) ?? null, setItem: (k, v) => persisted.set(k, v)}},
        document: {...eventHost, visibilityState: 'visible', body: {append() {}}, createElement: () => ({click() {clicked = true;}, remove() {}})},
        fixture: {panel: {get: () => ({phase: 'ready', sync: 'idle', persistent: true}), subscribe},
            ui: {get: () => ({windowOpen: false, management: false, compose: []}), subscribe},
            store: {data: {favorites: [], recent: [], binds: {}}, templates: [], subscribe}}
    };
    box.exports = box.module.exports;
    vm.runInNewContext(compiled.outputFiles[0].text, box);
    const api = box.module.exports;
    api.startDiagnostics();
    check('default recording off', !api.diagnosticJournal.active && timers.size === 0);
    api.setRecording(true);
    const send = api.createPanelTransport(async () => Response.json({code: 'session_revoked', message: 'PRIVATE_BODY_SENTINEL'}, {status: 401}));
    await assert.rejects(send('/me', {token: 'PRIVATE_TOKEN_SENTINEL'}), e => e.code === 'session_revoked');
    api.downloadDiagnostics();
    const exported = await downloaded.text();
    const report = JSON.parse(exported);
    check('JSON download', clicked && report.version === manifest.version);
    check('request failure records status and reason', report.journal.events.some(e => e.event === 'request.failure' && e.data.status === 401 && e.data.code === 'session_revoked'));
    check('no token or response body in export', !exported.includes('PRIVATE_'));
    api.stopDiagnostics(); api.startDiagnostics();
    check('recording and request history survive restart', api.diagnosticJournal.active && JSON.parse(api.diagnosticFile()).journal.events.some(e => e.data.status === 401));
    for (let i = 0; i < 2500; i++) api.diagnosticJournal.record('ui.state', {count: i, query: 'PRIVATE_QUERY_SENTINEL'});
    const flood = JSON.parse(api.diagnosticFile());
    check('bounded flood', flood.journal.events.length <= 2000 && persisted.get('SupportTemplates_diagnostics_v1').length <= 512 * 1024);
    api.setRecording(false); api.diagnosticJournal.clear();
    check('disable and clear', !api.diagnosticJournal.active && api.diagnosticJournal.snapshot().events.length === 0);
    api.stopDiagnostics();
    // The download URL is revoked after one second; execute only that mock timer.
    for (const [id, timer] of timers) if (timer.delay === 1000) {timers.delete(id); timer.cb();}
    check('no observers/listeners/timers after stop', observers.size === 0 && listeners.size === 0 && timers.size === 0);
    results.push({variant, archive: asset.name, sha256: asset.sha256, version: manifest.version, pluginCommit: manifest.pluginCommit,
        payloadFiles: manifest.files.length, rendererPluginSources: pluginSources.length, assertions,
        limitation: 'Packaged source-map modules executed with host/state mocks; no Discord host or live panel API.'});
    } finally {
        // Only the exact temporary directory created for this archive may be removed.
        if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir())) throw Error('Unexpected package QA temporary directory');
        fs.rmSync(dir, {recursive: true, force: true});
    }
}
fs.writeFileSync(resultFile, JSON.stringify({status: 'pass', results}, null, 2));
console.log(`PASS ${results.reduce((n, r) => n + r.assertions.length, 0)} packaged diagnostic checks`);
