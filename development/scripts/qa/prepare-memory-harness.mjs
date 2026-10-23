import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'betterdiscord/package.json'));
const { values } = parseArgs({ options: { bundle: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) { console.log('node scripts/qa/prepare-memory-harness.mjs --bundle betterdiscord/out/SupportTemplates.plugin.js --out scripts/qa/runs/BUILD/harness\nCreates a new harness directory; never builds the plugin or overwrites memory19.'); process.exit(0); }
if (!values.out) throw new Error('--out is required');
const out = path.resolve(root, values.out);
const runs = path.join(root, 'scripts/qa/runs') + path.sep;
if (!out.startsWith(runs)) throw new Error('Output must be a new directory under scripts/qa/runs/');
if (fs.existsSync(out)) throw new Error('Refusing to overwrite an existing harness');
const bundlePath = path.resolve(root, values.bundle ?? 'betterdiscord/out/SupportTemplates.plugin.js');
const plugin = fs.readFileSync(bundlePath);
const pluginSha256 = createHash('sha256').update(plugin).digest('hex');
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
const sourceDirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=no', '--', 'src', 'betterdiscord', 'distribution'], {cwd: root, encoding: 'utf8'}).trim();
const evidencePath = path.join(path.dirname(bundlePath), 'build-evidence.json');
const evidence = fs.existsSync(evidencePath) ? JSON.parse(fs.readFileSync(evidencePath, 'utf8')) : null;
const sourceHashes = evidence?.sourceHashes ?? {};
const changedBuildInputs = Object.entries(sourceHashes).filter(([file, hash]) => {
    const input = path.resolve(root, file);
    return !input.startsWith(root + path.sep) || !fs.existsSync(input) || createHash('sha256').update(fs.readFileSync(input)).digest('hex') !== hash;
}).map(([file]) => file);
const buildProvenance = {sourceHead, sourceDirty, buildSourceCommit: evidence?.sourceCommit ?? null,
    buildEvidenceMatchesBundle: evidence?.sha256 === pluginSha256,
    worktreeMatchesBuildInputs: Object.keys(sourceHashes).length > 0 && changedBuildInputs.length === 0,
    changedBuildInputs, sourceInputsSha256: createHash('sha256').update(JSON.stringify(Object.entries(sourceHashes).sort())).digest('hex')};
fs.mkdirSync(out, { recursive: true });
if (evidence) fs.writeFileSync(path.join(out, 'build-evidence.json'), JSON.stringify(evidence, null, 2));
fs.writeFileSync(path.join(out, 'plugin.js'), plugin);
// CommonJS scope matters: exposing bundle declarations as browser globals would
// replace native window.open/confirm with unrelated internal functions.
fs.writeFileSync(path.join(out, 'runtime.js'), '(function(module,exports,require){\n' + plugin.toString() + '\nwindow.harness={connectPanel,panel,panelPersonal,ui,setDebugEnabled,setDebugVerbose,captureWindowTarget,refs:()=>({windowTargetConnected:windowTarget?.editor?.isConnected??null,visibleCount:visibleItems.length})};\n})(window.module,window.module.exports,window.require);');
await require('esbuild').build({ stdin: { contents: `import React from 'react';import * as ReactDOM from 'react-dom/client';globalThis.testReact=React;globalThis.testReactDOM=ReactDOM;`, resolveDir: path.join(root, 'betterdiscord'), loader: 'js' }, bundle: true, platform: 'browser', outfile: path.join(out, 'react.js'), define: { 'process.env.NODE_ENV': '"production"' } });
fs.copyFileSync(path.join(root, 'scripts/qa/memory-host.js'), path.join(out, 'host.js'));
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>SupportTemplates memory fixture</title><style>body{margin:0;background:#25272e;color:white;font:16px sans-serif}.channelTextArea_test{position:fixed;bottom:10px;left:20px;right:20px;height:55px;display:flex}.editor{flex:1;min-height:40px}.buttons_test{display:flex}</style><div class="channelTextArea_test"><div class="editor" role="textbox" tabindex="0" data-slate-editor="true" contenteditable="true"></div><div class="buttons_test"></div></div><script src="react.js"></script><script src="host.js"></script><script src="runtime.js"></script><script>window.instance=new module.exports(); window.started=instance.start();</script>`);
fs.writeFileSync(path.join(out, 'control.html'), '<!doctype html><meta charset="utf-8"><script src="react.js"></script><script src="host.js"></script>');
fs.writeFileSync(path.join(out, 'provenance.json'), JSON.stringify({ bundlePath, capturedAt: new Date().toISOString(), pluginSha256, ...buildProvenance, version: /@version\s+(\S+)/.exec(plugin.toString())?.[1], exactPublishedBundle: false, mocks: ['Discord stores/event bus', 'strict synthetic OAuth and API', 'unsupported native persistence/updater bridge'], real: ['React production', 'supplied BetterDiscord bundle', 'UI components and lifecycle', 'panel client, SSE parser and real-time timers'], limitation: 'Browser fixture, not real Discord/BD; native protected storage and updater are not exercised.' }, null, 2));
console.log(out);
