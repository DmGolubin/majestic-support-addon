#!/usr/bin/env node
'use strict';

// Native Electron compatibility smoke check; no repository dependencies required.
// node scripts/qa/quickcss-electron-check.cjs [--html file] [--script file] [--out directory]
//   [--electron-version 44.9.0] [--electron absolute-path-in-TEMP]
// Installs the pinned runtime into a unique TEMP directory unless --electron is
// supplied. The caller owns a supplied runtime; all helper-owned TEMP files are
// removed after the Electron process exits. Reports contain hashes, never CSS.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => ({ bytes: Buffer.byteLength(value), sha256: sha(value) });
const errorInfo = error => ({ name: error?.name || 'Error', code: error?.code, syscall: error?.syscall,
    // Keep controlled QA assertions actionable; unknown Electron errors can
    // contain an entire multi-megabyte data URL, so retain only their digest.
    message: /^(Timed out: |Check failed: |Owned-process query failed|TEMP cleanup ownership check failed|Owned Electron processes remain|Electron installation failed|Electron binary download failed|Unexpected sender|Unexpected save)/.test(String(error?.message))
        ? String(error.message).slice(0, 240) : undefined,
    path: typeof error?.path === 'string' && error.path.length < 500 && !/^(data|blob):/.test(error.path) ? error.path : undefined,
    messageSha256: sha(String(error?.message || error)) });
const INITIAL_CSS = '/* Synthetic Electron QA: Ω */\n.quickcss-electron-qa {\n  color: #123456;\n  qa-unknown-property: 1;\n}\n';
const EDIT_PREFIX = '/* Synthetic save: Ω Ж 😀 */ ';
const EDITED_CSS = EDIT_PREFIX + INITIAL_CSS;

function inside(parent, child) {
    const relative = path.relative(parent, child);
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function preload() {
    const { contextBridge, ipcRenderer } = require('electron');
    if (location.protocol !== 'data:') return;
    globalThis.__quickcssIsolatedSentinel = true;
    contextBridge.exposeInMainWorld('getCurrentCss', () => ipcRenderer.invoke('qa:getCurrentCss'));
    contextBridge.exposeInMainWorld('getTheme', () => ipcRenderer.sendSync('qa:getTheme'));
    contextBridge.exposeInMainWorld('setCss', css => ipcRenderer.invoke('qa:setCss', css));
    ipcRenderer.send('qa:preload', { contextIsolated: process.contextIsolated,
        sandboxed: process.sandboxed === true, bridgeMethods: ['getCurrentCss', 'getTheme', 'setCss'] });
}

// Installed using CDP before navigation, in the page world, without changing HTML
// or adding any contextBridge methods. Payloads and full URLs are never retained.
function instrument() {
    const state = { workers: [], blobs: [], errors: [], csp: [], resizeEvents: 0 };
    Object.defineProperty(window, '__quickcssQa', { value: state });
    const blobRows = new Map();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => {
        const url = create(blob);
        const row = { protocol: new URL(url).protocol, origin: new URL(url).origin,
            bytes: blob.size, type: blob.type, revoked: false };
        state.blobs.push(row); blobRows.set(url, row);
        return url;
    };
    URL.revokeObjectURL = url => { if (blobRows.has(url)) blobRows.get(url).revoked = true; return revoke(url); };
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
        constructor(url, options) {
            super(url, options);
            const row = { name: options?.name || '', protocol: new URL(url).protocol,
                origin: new URL(url).origin, sent: 0, received: 0, methods: [], errors: 0, terminated: false };
            state.workers.push(row);
            this.addEventListener('message', () => row.received++);
            this.addEventListener('error', () => row.errors++);
            this.addEventListener('messageerror', () => row.errors++);
            const post = this.postMessage.bind(this);
            this.postMessage = (...args) => {
                row.sent++;
                const method = args[0]?.method;
                if (typeof method === 'string' && /^[$\w]{1,70}$/.test(method) && !row.methods.includes(method)) row.methods.push(method);
                return post(...args);
            };
            const terminate = this.terminate.bind(this);
            this.terminate = () => { row.terminated = true; return terminate(); };
        }
    };
    window.addEventListener('error', event => state.errors.push({ kind: 'error', line: event.lineno, column: event.colno }));
    window.addEventListener('unhandledrejection', () => state.errors.push({ kind: 'unhandledrejection' }));
    window.addEventListener('securitypolicyviolation', event => state.csp.push({ directive: event.effectiveDirective,
        blockedProtocol: event.blockedURI.split(':')[0] }));
    window.addEventListener('resize', () => state.resizeEvents++);
}

async function until(predicate, label, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const result = await predicate(); if (result) return result; await sleep(100); }
    throw new Error('Timed out: ' + label);
}

async function electronMain() {
    const { app, BrowserWindow, ipcMain, session } = require('electron');
    const config = JSON.parse(fs.readFileSync(process.argv.find(arg => arg.endsWith('qa-config.json')), 'utf8'));
    const report = { schema: 1, startedAt: new Date().toISOString(), versions: process.versions,
        platform: process.platform, arch: process.arch, input: config.input, script: config.scriptInput,
        mode: config.script ? 'loadURL-then-executeJavaScript' : 'inline-script-data-url', checks: [], scenarios: [],
        network: { blocked: [], sent: [], phase: 'application' }, lifecycle: { mainPid: process.pid } };
    const write = () => fs.writeFileSync(config.result, JSON.stringify(report, (key, value) => ['win', 'lastSaved'].includes(key) ? undefined : value, 2));
    const check = (name, passed, evidence) => {
        report.checks.push({ name, passed: Boolean(passed), evidence: JSON.parse(JSON.stringify(evidence)) });
        write();
        if (!passed) throw new Error('Check failed: ' + name);
    };
    const watchdog = setTimeout(() => {
        report.fatal = { stage: 'main-watchdog' }; report.passed = false; write(); app.exit(2);
    }, 90000);
    let current;
    app.setName('quickcss-electron-qa');
    for (const [key, folder] of Object.entries({ appData: 'appData', userData: 'userData',
        sessionData: 'sessionData', crashDumps: 'crashDumps', logs: 'logs' })) {
        const target = path.join(config.root, folder); fs.mkdirSync(target, { recursive: true }); app.setPath(key, target);
    }
    app.commandLine.appendSwitch('disable-background-networking');
    app.commandLine.appendSwitch('disable-component-update');
    app.commandLine.appendSwitch('disable-domain-reliability');
    // Fail closed even for browser-level requests outside the instrumented page.
    app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
    app.commandLine.appendSwitch('proxy-server', 'http://127.0.0.1:9');
    app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');
    app.on('window-all-closed', () => {});
    const validSender = event => current && event.sender === current.win.webContents && event.senderFrame === event.sender.mainFrame;
    ipcMain.handle('qa:getCurrentCss', event => {
        if (!validSender(event)) throw new Error('Unexpected sender');
        current.bridge.getCurrentCss++; return INITIAL_CSS;
    });
    ipcMain.on('qa:getTheme', event => {
        if (!validSender(event)) { event.returnValue = null; return; }
        current.bridge.getTheme++; event.returnValue = current.theme;
    });
    ipcMain.handle('qa:setCss', (event, css) => {
        if (!validSender(event) || typeof css !== 'string') throw new Error('Unexpected save');
        current.bridge.setCss++;
        current.lastSaved = css;
        current.bridge.saves.push({ ...digest(css), exactEditedFixture: css === EDITED_CSS });
    });
    ipcMain.on('qa:preload', (event, details) => { if (validSender(event)) current.preload = details; });
    try {
        await app.whenReady();
        check('pinned-electron-version', process.versions.electron === config.version, process.versions.electron);
        check('isolated-userData', inside(config.root, app.getPath('userData')), app.getPath('userData'));
        const qaSession = session.fromPartition('quickcss-qa-' + config.token, { cache: false });
        qaSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
        qaSession.setPermissionCheckHandler(() => false);
        const requestRecord = details => ({ protocol: new URL(details.url).protocol,
            host: new URL(details.url).hostname, resourceType: details.resourceType, phase: report.network.phase });
        qaSession.webRequest.onBeforeRequest((details, callback) => {
            const allowed = /^(data:|blob:|about:)/.test(details.url);
            if (!allowed) report.network.blocked.push(requestRecord(details));
            callback({ cancel: !allowed });
        });
        qaSession.webRequest.onSendHeaders(details => {
            if (/^(https?|wss?|ftp):/.test(details.url)) report.network.sent.push(requestRecord(details));
        });
        const html = fs.readFileSync(config.html);
        check('input-snapshot-unchanged', sha(html) === config.input.sha256, digest(html));
        const dataUrl = 'data:text/html;base64,' + html.toString('base64');
        report.dataUrl = { characters: dataUrl.length, scheme: 'data:text/html;base64', htmlBytes: html.length };
        const script = config.script ? fs.readFileSync(config.script, 'utf8') : undefined;
        if (script !== undefined) check('script-snapshot-unchanged', sha(script) === config.scriptInput.sha256, digest(script));
        for (const theme of ['vs-dark', 'vs']) {
            const scenario = { theme, bridge: { getCurrentCss: 0, getTheme: 0, setCss: 0, saves: [] },
                consoleCounts: {}, renderGone: [], preloadErrors: [], shownEvents: 0, workerTargets: [] };
            report.scenarios.push(scenario);
            const win = new BrowserWindow({ width: 960, height: 680, useContentSize: true, show: false,
                webPreferences: { preload: config.preload, contextIsolation: true, nodeIntegration: false,
                    sandbox: false, session: qaSession, webSecurity: true } });
            current = Object.assign(scenario, { win, lastSaved: null });
            const wc = win.webContents;
            win.on('show', () => scenario.shownEvents++);
            wc.on('console-message', (_event, ...args) => {
                const level = typeof args[0] === 'object' ? args[0].level : args[0];
                scenario.consoleCounts[level] = (scenario.consoleCounts[level] || 0) + 1;
            });
            wc.on('preload-error', (_event, _file, error) => scenario.preloadErrors.push(errorInfo(error)));
            wc.on('render-process-gone', (_event, details) => scenario.renderGone.push(details));
            wc.setWindowOpenHandler(() => ({ action: 'deny' }));
            wc.on('will-navigate', event => event.preventDefault());
            wc.on('will-attach-webview', event => event.preventDefault());
            const preferences = wc.getLastWebPreferences();
            scenario.preferences = Object.fromEntries(['contextIsolation', 'nodeIntegration', 'sandbox', 'webSecurity',
                'nodeIntegrationInWorker'].map(key => [key, preferences[key]]));
            check(theme + ':preferences', preferences.contextIsolation === true && preferences.nodeIntegration === false
                && preferences.sandbox === false && preferences.webSecurity === true, scenario.preferences);
            // A new hidden window has no active renderer yet. Prime it before
            // awaiting CDP Page.enable, which otherwise waits for a navigation.
            scenario.stage = 'prime-about-blank';
            await win.loadURL('about:blank');
            wc.debugger.attach('1.3');
            const command = (method, params = {}, sessionId) => wc.debugger.sendCommand(method, params, sessionId);
            const evaluate = expression => wc.executeJavaScript(expression, true);
            const workerSessions = new Map();
            wc.debugger.on('message', (_event, method, params) => {
                if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'worker') {
                    const row = { type: 'worker', protocol: new URL(params.targetInfo.url).protocol };
                    scenario.workerTargets.push(row); workerSessions.set(params.sessionId, row);
                }
            });
            await command('Page.enable');
            await command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
            await command('Page.addScriptToEvaluateOnNewDocument', { source: '(' + instrument.toString() + ')()' });
            scenario.stage = 'loadURL';
            const loadStart = Date.now();
            await win.loadURL(dataUrl);
            scenario.loadMilliseconds = Date.now() - loadStart;
            check(theme + ':unmodified-large-data-url', wc.getURL() === dataUrl, { urlCharacters: wc.getURL().length });
            if (script !== undefined) {
                scenario.stage = 'before-native-injection';
                const before = await evaluate(`({editorPresent:Boolean(document.querySelector('.monaco-editor')),
                    environmentType:typeof MonacoEnvironment,scriptTags:document.scripts.length,
                    workerCount:__quickcssQa.workers.length,
                    bridge:['getCurrentCss','getTheme','setCss'].map(key=>({key,type:typeof window[key]})),
                    csp:document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content})`);
                check(theme + ':no-editor-before-native-injection', !before.editorPresent && before.environmentType === 'undefined'
                    && before.scriptTags === 0 && before.workerCount === 0 && scenario.bridge.getCurrentCss === 0
                    && scenario.bridge.getTheme === 0 && scenario.bridge.setCss === 0
                    && before.bridge.every(row=>row.type==='function') && /script-src\s+'none'/.test(before.csp || ''), before);
                scenario.stage = 'native-script-injection';
                const injectionStart = Date.now();
                await wc.executeJavaScript(script);
                scenario.injectionMilliseconds = Date.now() - injectionStart;
                check(theme + ':trusted-script-injected', true, config.scriptInput);
            }
            scenario.stage = 'editor-ready';
            await until(() => evaluate('Boolean(document.querySelector(".monaco-editor textarea"))'), 'editor ready');
            const page = await evaluate(`({origin:location.origin,protocol:location.protocol,
                requireType:typeof require,processType:typeof process,moduleType:typeof module,
                sentinelType:typeof __quickcssIsolatedSentinel,
                bridge:['getCurrentCss','getTheme','setCss'].map(key=>({key,type:typeof window[key]})),
                themeClasses:document.querySelector('.monaco-editor').className,
                initialTextVisible:document.querySelector('.view-lines').textContent.includes('quickcss-electron-qa'),
                statusHidden:document.getElementById('status')?.hidden})`);
            scenario.page = page;
            check(theme + ':opaque-origin', page.protocol === 'data:' && page.origin === 'null', { protocol: page.protocol, origin: page.origin });
            check(theme + ':context-bridge-isolation', page.requireType === 'undefined' && page.processType === 'undefined'
                && page.moduleType === 'undefined' && page.sentinelType === 'undefined'
                && scenario.preload?.contextIsolated && !scenario.preload?.sandboxed
                && page.bridge.every(item => item.type === 'function'), { page, preload: scenario.preload });
            check(theme + ':initial-css-and-theme', page.initialTextVisible && page.statusHidden
                && page.themeClasses.split(' ').includes(theme) && scenario.bridge.getCurrentCss === 1
                && scenario.bridge.getTheme === 1 && scenario.bridge.setCss === 0, scenario.bridge);
            scenario.stage = 'worker-validation';
            await until(() => evaluate(`__quickcssQa.workers.some(w=>w.name==='quickcss-css' && w.received>0)
                && Boolean(document.querySelector('.squiggly-warning,.squiggly-error'))`), 'CSS worker diagnostic');
            check(theme + ':css-worker-diagnostic', true, { diagnosticVisible: true });
            scenario.stage = 'edit-and-save';
            await command('Emulation.setFocusEmulationEnabled', { enabled: true });
            scenario.inputTarget = await evaluate(`(()=>{const input=[...document.querySelectorAll('.monaco-editor *')]
                .find(element=>element.editContext) || document.querySelector('.monaco-editor textarea');
                input.focus();return {tag:input.tagName,className:input.className,hasEditContext:Boolean(input.editContext),
                    active:document.activeElement===input,documentHasFocus:document.hasFocus()}})()`);
            // Hidden windows do not provide normal OS keyboard focus. Exercise
            // Monaco's real input/model/save path through its EditContext event;
            // no direct call to setCss or changes to the packaged script.
            scenario.editMethod = 'synthetic-EditContext-textupdate';
            await evaluate(`(()=>{const input=document.activeElement, context=input.editContext;
                if(!context)throw new Error('This runtime requires an EditContext input target');
                const text=${JSON.stringify(EDIT_PREFIX)};
                context.updateText(0,0,text);context.updateSelection(text.length,text.length);
                context.dispatchEvent(new TextUpdateEvent('textupdate',{text,updateRangeStart:0,updateRangeEnd:0,
                    selectionStart:text.length,selectionEnd:text.length}));})()`);
            await until(() => scenario.lastSaved === EDITED_CSS, 'exact synthetic edit saved');
            check(theme + ':edit-save-context-bridge', scenario.lastSaved === EDITED_CSS, scenario.bridge.saves);
            const dimensions = () => evaluate(`(()=>{const e=document.querySelector('.monaco-editor').getBoundingClientRect();
                const c=document.getElementById('container').getBoundingClientRect();return {innerWidth,innerHeight,
                    editorWidth:e.width,editorHeight:e.height,containerWidth:c.width,containerHeight:c.height,
                    resizeEvents:__quickcssQa.resizeEvents}})()`);
            scenario.stage = 'resize';
            const before = await dimensions();
            win.setContentSize(720, 480);
            const after = await until(async () => { const d = await dimensions(); return d.innerWidth === 720 && d.innerHeight === 480
                && Math.abs(d.editorWidth - d.containerWidth) < 2 && Math.abs(d.editorHeight - d.containerHeight) < 2
                && d.resizeEvents > before.resizeEvents ? d : false; }, 'hidden window resize');
            check(theme + ':hidden-window-resize', true, { before, after });
            scenario.stage = 'worker-runtime';
            // Unicode highlighting normally starts the editor worker. If it did
            // not, exercise the production worker factory explicitly and label it.
            scenario.editorWorkerExplicitProbe = await evaluate(`(()=>{if(__quickcssQa.workers.some(w=>w.name==='quickcss-editorWorkerService'))return false;
                window.MonacoEnvironment.getWorker('qa','editorWorkerService');return true;})()`);
            await until(() => workerSessions.size >= 2, 'both real worker targets');
            for (const [sessionId, row] of workerSessions) {
                const result = await command('Runtime.evaluate', { expression: `({protocol:location.protocol,origin:location.origin,
                    requireType:typeof require,processType:typeof process,onmessageType:typeof onmessage})`, returnByValue: true }, sessionId);
                row.runtime = result.result.value;
            }
            check(theme + ':blob-worker-runtime', scenario.workerTargets.length >= 2 && scenario.workerTargets.every(row =>
                row.protocol === 'blob:' && row.runtime?.origin === 'null' && row.runtime?.requireType === 'undefined'
                && row.runtime?.processType === 'undefined' && row.runtime?.onmessageType === 'function'), scenario.workerTargets);
            scenario.beforeNetworkProbe = await evaluate('JSON.parse(JSON.stringify(__quickcssQa))');
            check(theme + ':worker-traffic-and-no-runtime-errors', scenario.beforeNetworkProbe.workers.every(row => row.errors === 0)
                && scenario.beforeNetworkProbe.workers.some(row => row.name === 'quickcss-css' && row.sent > 0 && row.received > 0)
                && scenario.beforeNetworkProbe.errors.length === 0 && scenario.beforeNetworkProbe.csp.length === 0
                && scenario.preloadErrors.length === 0 && scenario.renderGone.length === 0, scenario.beforeNetworkProbe);
            check(theme + ':no-application-network', report.network.blocked.filter(row => row.phase === 'application').length === 0
                && report.network.sent.length === 0, report.network);
            scenario.stage = 'network-negative-control';
            report.network.phase = 'negative-control';
            const fetchRejected = await evaluate(`fetch('https://quickcss-qa.invalid/blocked').then(()=>false,()=>true)`);
            // A main-process session fetch proves the interceptor independently
            // of the document's connect-src CSP. This is a reserved .invalid host.
            let sessionRejected = false;
            try { await qaSession.fetch('https://quickcss-qa.invalid/interceptor'); } catch { sessionRejected = true; }
            await until(() => evaluate('__quickcssQa.csp.length>0'), 'CSP negative control');
            check(theme + ':external-network-rejected', fetchRejected && sessionRejected
                && report.network.blocked.some(row => row.host === 'quickcss-qa.invalid')
                && report.network.sent.length === 0, { documentFetchRejected: fetchRejected, sessionFetchRejected: sessionRejected });
            scenario.stage = 'pagehide-cleanup';
            // Exercise the production cleanup listener before inspecting it; the
            // actual BrowserWindow is then destroyed, rather than left running.
            await evaluate(`window.dispatchEvent(new Event('pagehide'))`);
            scenario.afterPagehide = await evaluate('JSON.parse(JSON.stringify(__quickcssQa))');
            check(theme + ':pagehide-disposes-workers-and-blobs', scenario.afterPagehide.workers.every(row => row.terminated)
                && scenario.afterPagehide.blobs.every(row => row.revoked), scenario.afterPagehide);
            check(theme + ':window-never-shown', !win.isVisible() && scenario.shownEvents === 0, { isVisible: win.isVisible(), shownEvents: scenario.shownEvents });
            scenario.stage = 'complete';
            wc.debugger.detach(); win.destroy(); scenario.windowDestroyed = win.isDestroyed();
            delete scenario.win; delete scenario.lastSaved;
            current = null; report.network.phase = 'application';
        }
        await qaSession.clearStorageData();
        report.passed = report.checks.every(row => row.passed);
    } catch (error) {
        report.fatal = { stage: current?.stage || 'setup', ...errorInfo(error) };
        report.passed = false;
    } finally {
        for (const scenario of report.scenarios) { delete scenario.win; delete scenario.lastSaved; }
        for (const win of BrowserWindow.getAllWindows()) win.destroy();
        report.lifecycle.remainingWindows = BrowserWindow.getAllWindows().length;
        report.finishedAt = new Date().toISOString();
        clearTimeout(watchdog); write();
        app.exit(report.passed ? 0 : 1);
    }
}

// Query/terminate only executable paths inside the helper's owned TEMP tree.
// The caller's Electron runtime (if supplied) is never swept by this function.
function ownedWindowsProcesses(root, terminate = false) {
    if (process.platform !== 'win32') return [];
    const quoted = (root + path.sep).replaceAll("'", "''");
    const source = `$items = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${quoted}', [StringComparison]::OrdinalIgnoreCase) }); `
        + (terminate ? '$items | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; ' : '')
        + 'ConvertTo-Json -InputObject @($items | Select-Object ProcessId,ParentProcessId,Name) -Compress';
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
        { windowsHide: true, encoding: 'utf8', timeout: 20000 });
    if (result.status !== 0) throw new Error('Owned-process query failed');
    return JSON.parse(result.stdout.trim() || '[]');
}

async function nodeMain() {
    const options = { html: path.join(__dirname, 'runs/q19/quickcss-dev.html'), out: path.join(__dirname, 'runs/q19/electron'), version: '44.9.0' };
    const names = { '--html': 'html', '--script': 'script', '--out': 'out', '--electron-version': 'version', '--electron': 'electron' };
    for (let i = 2; i < process.argv.length; i++) {
        if (process.argv[i] === '--help') { console.log('Usage: node quickcss-electron-check.cjs [--html file] [--script file] [--out directory] [--electron-version 44.9.0] [--electron absolute-TEMP-executable]'); return; }
        const key = names[process.argv[i]];
        if (!key || !process.argv[i + 1]) throw new Error('Invalid CLI argument');
        options[key] = process.argv[++i];
    }
    if (!/^\d+\.\d+\.\d+$/.test(options.version)) throw new Error('An exact Electron version is required');
    const html = fs.readFileSync(path.resolve(options.html));
    const script = options.script ? fs.readFileSync(path.resolve(options.script)) : undefined;
    const output = path.resolve(options.out); fs.mkdirSync(output, { recursive: true });
    const tempParent = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(tempParent, 'quickcss-electron-qa-'));
    const token = crypto.randomUUID();
    fs.writeFileSync(path.join(root, '.qa-owner'), token);
    const guard = () => {
        if (fs.lstatSync(root).isSymbolicLink() || path.dirname(fs.realpathSync(root)) !== tempParent
            || !path.basename(root).startsWith('quickcss-electron-qa-')
            || fs.readFileSync(path.join(root, '.qa-owner'), 'utf8') !== token) throw new Error('TEMP cleanup ownership check failed');
    };
    const launcher = { root, version: options.version, input: { path: path.resolve(options.html), ...digest(html) },
        script: options.script ? { path: path.resolve(options.script), ...digest(script) } : undefined,
        helperSha256: sha(fs.readFileSync(__filename)), startedAt: new Date().toISOString(), commands: [] };
    let activeChild;
    const run = (executable, args, env, timeout) => new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        activeChild = child;
        const row = { executable, pid: child.pid, stdoutBytes: 0, stderrBytes: 0 };
        launcher.commands.push(row);
        const hashes = { stdout: crypto.createHash('sha256'), stderr: crypto.createHash('sha256') };
        for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => { row[stream + 'Bytes'] += bytes.length; hashes[stream].update(bytes); });
        const timer = setTimeout(() => { row.timedOut = true; child.kill(); }, timeout);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => {
            clearTimeout(timer); activeChild = null;
            Object.assign(row, { exitCode: code, signal, stdoutSha256: hashes.stdout.digest('hex'), stderrSha256: hashes.stderr.digest('hex') });
            resolve(row);
        });
    });
    let report;
    try {
        const env = { ...process.env, npm_config_cache: path.join(root, 'npm-cache'), ELECTRON_CACHE: path.join(root, 'electron-cache') };
        for (const key of Object.keys(env)) if (/^ELECTRON_/i.test(key) && key !== 'ELECTRON_CACHE') delete env[key];
        env.electron_config_cache = path.join(root, 'electron-cache');
        delete env.NODE_OPTIONS;
        let executable;
        if (options.electron) {
            executable = fs.realpathSync(path.resolve(options.electron));
            if (!inside(tempParent, executable)) throw new Error('Supplied Electron must be in TEMP');
            launcher.runtimeOwnership = 'caller';
        } else {
            launcher.runtimeOwnership = 'helper';
            const runtime = path.join(root, 'runtime'); fs.mkdirSync(runtime);
            fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ name: 'quickcss-electron-qa-runtime', private: true }));
            const npmCandidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
                path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
            const npm = npmCandidates.find(file => fs.existsSync(file));
            if (!npm) throw new Error('Cannot locate npm-cli.js; supply a TEMP Electron with --electron');
            console.log('Installing pinned Electron ' + options.version + ' in isolated TEMP.');
            const installation = await run(process.execPath, [npm, 'install', '--prefix', runtime, '--no-audit', '--no-fund', '--ignore-scripts=false', '--save-exact', 'electron@' + options.version], env, 240000);
            if (installation.exitCode !== 0) throw new Error('Electron installation failed');
            const electronPackage = path.join(runtime, 'node_modules/electron');
            launcher.package = JSON.parse(fs.readFileSync(path.join(electronPackage, 'package.json'), 'utf8')).version;
            fs.copyFileSync(path.join(runtime, 'package-lock.json'), path.join(output, 'runtime-package-lock.json'));
            // Current Electron packages expose install-electron without an npm
            // postinstall; older pinned releases may already have downloaded it.
            if (!fs.existsSync(path.join(electronPackage, 'path.txt'))) {
                const download = await run(process.execPath, [path.join(electronPackage, 'install.js')], env, 240000);
                if (download.exitCode !== 0) throw new Error('Electron binary download failed');
            }
            executable = path.join(electronPackage, fs.readFileSync(path.join(electronPackage, 'path.txt'), 'utf8').trim());
            // path.txt is relative to dist in Electron's npm package.
            if (!fs.existsSync(executable)) executable = path.join(electronPackage, 'dist', fs.readFileSync(path.join(electronPackage, 'path.txt'), 'utf8').trim());
        }
        const appDir = path.join(root, 'app'); fs.mkdirSync(appDir);
        fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'quickcss-electron-qa', version: '1.0.0', main: 'main.cjs' }));
        fs.copyFileSync(__filename, path.join(appDir, 'main.cjs'));
        const preloadFile = path.join(appDir, 'preload.cjs'); fs.writeFileSync(preloadFile, '(' + preload.toString() + ')();\n');
        fs.copyFileSync(preloadFile, path.join(output, 'preload.cjs'));
        const snapshot = path.join(appDir, 'input.html'); fs.writeFileSync(snapshot, html);
        const scriptSnapshot = script !== undefined ? path.join(appDir, 'input.js') : undefined;
        if (scriptSnapshot) fs.writeFileSync(scriptSnapshot, script);
        const result = path.join(root, 'result.json');
        const configFile = path.join(appDir, 'qa-config.json');
        fs.writeFileSync(configFile, JSON.stringify({ root, token, html: snapshot, input: launcher.input,
            script: scriptSnapshot, scriptInput: launcher.script, preload: preloadFile, result, version: options.version }));
        console.log('Running hidden BrowserWindow compatibility checks.');
        const launch = await run(executable, [appDir, configFile, '--user-data-dir=' + path.join(root, 'userData'), '--disk-cache-dir=' + path.join(root, 'disk-cache')],
            { ...env, APPDATA: path.join(root, 'appData'), LOCALAPPDATA: path.join(root, 'localAppData'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }, 110000);
        report = fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) : { passed: false, fatal: { stage: 'no-electron-report' } };
        launcher.exitCode = launch.exitCode;
        report.passed = report.passed && launch.exitCode === 0 && !launch.timedOut;
    } catch (error) {
        launcher.error = errorInfo(error); report ||= { passed: false, fatal: { stage: 'launcher', ...errorInfo(error) } };
    } finally {
        if (activeChild) activeChild.kill();
        try {
            guard();
            let processes = ownedWindowsProcesses(root);
            for (let i = 0; processes.length && i < 10; i++) { await sleep(250); processes = ownedWindowsProcesses(root); }
            launcher.processesAfterExit = processes;
            if (processes.length) { ownedWindowsProcesses(root, true); await sleep(500); }
            launcher.remainingOwnedProcesses = ownedWindowsProcesses(root);
            if (launcher.remainingOwnedProcesses.length) throw new Error('Owned Electron processes remain');
            guard(); fs.rmSync(root, { recursive: true, force: false, maxRetries: 8, retryDelay: 300 });
            launcher.tempRemoved = !fs.existsSync(root);
        } catch (error) { launcher.cleanupError = errorInfo(error); }
        launcher.finishedAt = new Date().toISOString();
        report ||= { passed: false };
        report.passed = Boolean(report.passed && launcher.tempRemoved && !launcher.cleanupError);
        report.launcher = launcher;
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ passed: report.passed, electron: report.versions?.electron,
            htmlBytes: launcher.input.bytes, dataUrlCharacters: report.dataUrl?.characters,
            passedChecks: report.checks?.filter(row => row.passed).length, totalChecks: report.checks?.length,
            failureStage: report.fatal?.stage, tempRemoved: launcher.tempRemoved, report: path.join(output, 'report.json') }));
        process.exitCode = report.passed ? 0 : 1;
    }
}

if (process.versions.electron) electronMain().catch(() => require('electron').app.exit(2));
else nodeMain().catch(error => { console.error(JSON.stringify(errorInfo(error))); process.exitCode = 1; });
