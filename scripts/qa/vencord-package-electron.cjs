// Real Electron regression for physical ASAR validation; never starts Discord.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

if (process.versions.electron) {
    const { app } = require('electron');
    const raw = require('original-fs');
    const config = JSON.parse(raw.readFileSync(process.argv[2], 'utf8'));
    app.setPath('userData', path.join(config.root, 'userData'));
    const report = { electron: process.versions.electron, checks: [] };
    try {
        const { readPackage } = require(config.validator);
        const check = (name, fn) => { fn(); report.checks.push(name); };
        const assert = require('assert/strict');
        const incoming = path.join(config.root, 'incoming');
        raw.cpSync(config.package, incoming, { recursive: true });
        const stored = path.join(config.root, 'stored');
        raw.cpSync(path.join(incoming, 'payload'), stored, { recursive: true });
        raw.copyFileSync(path.join(incoming, 'manifest.json'), path.join(stored, 'manifest.json'));
        const loader = path.join(stored, 'loader.asar');
        check('real ASAR is virtual to Electron fs and physical to original-fs', () => {
            assert.equal(fs.statSync(loader).isDirectory(), true);
            assert.equal(raw.statSync(loader).isFile(), true);
        });
        check('incoming package passes in Electron', () => readPackage(incoming));
        check('stored package passes in Electron', () => readPackage(stored, true));
        const original = raw.readFileSync(loader);
        const changed = Buffer.from(original); changed[changed.length - 1] ^= 1;
        raw.writeFileSync(loader, changed);
        check('same-size ASAR tampering fails', () => assert.throws(() => readPackage(stored, true), /integrity/));
        raw.writeFileSync(loader, original);
        raw.writeFileSync(path.join(stored, 'extra.txt'), 'unexpected');
        check('unlisted files fail', () => assert.throws(() => readPackage(stored, true), /Unlisted/));
        raw.unlinkSync(path.join(stored, 'extra.txt'));
        const manifestFile = path.join(stored, 'manifest.json');
        const manifestBytes = raw.readFileSync(manifestFile);
        const manifest = JSON.parse(manifestBytes);
        manifest.files.find(entry => entry.path === 'payload/loader.asar').size++;
        raw.writeFileSync(manifestFile, JSON.stringify(manifest));
        check('incorrect archive size fails', () => assert.throws(() => readPackage(stored, true), /integrity/));
        raw.writeFileSync(manifestFile, manifestBytes);
        check('restored package passes', () => readPackage(stored, true));
        report.passed = true;
    } catch (error) {
        report.passed = false;
        report.error = error.stack;
    }
    raw.writeFileSync(config.output, JSON.stringify(report, null, 2));
    app.exit(report.passed ? 0 : 1);
} else {
    // Usage: node script.cjs electron.exe package-directory validator.cjs report.json
    if (process.argv.length !== 6) throw Error('Four arguments required');
    const [electron, packagePath, validator, output] = process.argv.slice(2).map(p => path.resolve(p));
    const temp = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(temp, 'support-templates-package-electron-'));
    const marker = require('crypto').randomUUID();
    fs.writeFileSync(path.join(root, '.qa-owner'), marker);
    fs.copyFileSync(__filename, path.join(root, 'main.cjs'));
    const config = path.join(root, 'config.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ root, package: packagePath, validator, output }));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^ELECTRON_/i.test(key)) delete env[key];
    delete env.NODE_OPTIONS;
    env.APPDATA = path.join(root, 'appData');
    env.LOCALAPPDATA = path.join(root, 'localAppData');
    const child = spawn(electron, [path.join(root, 'main.cjs'), config], { env, windowsHide: true, stdio: 'ignore' });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45000);
    child.once('error', error => { console.error(error); process.exitCode = 1; });
    child.once('close', code => {
        clearTimeout(timer);
        if (fs.existsSync(output)) console.log(fs.readFileSync(output, 'utf8'));
        if (path.dirname(fs.realpathSync(root)) !== temp
            || fs.lstatSync(root).isSymbolicLink()
            || !path.basename(root).startsWith('support-templates-package-electron-')
            || fs.readFileSync(path.join(root, '.qa-owner'), 'utf8') !== marker) throw Error('TEMP cleanup guard failed');
        fs.rmSync(root, { recursive: true });
        process.exitCode = timedOut || code !== 0 ? 1 : 0;
    });
}
