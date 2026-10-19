import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'betterdiscord/package.json'));
const out = path.join(root, 'artifacts/memory19');
fs.mkdirSync(out, { recursive: true });
const plugin = fs.readFileSync(path.join(root, 'artifacts/distribution/1.0.1-canary.19/SupportTemplates.plugin.js'));
fs.writeFileSync(path.join(out, 'plugin.js'), plugin);
// CommonJS scope matters: exposing bundle declarations as browser globals would
// replace native window.open/confirm with unrelated internal functions.
fs.writeFileSync(path.join(out, 'runtime.js'), '(function(module,exports,require){\n' + plugin.toString() + '\nwindow.harness={connectPanel,panel,panelPersonal,ui,setDebugEnabled,setDebugVerbose,captureWindowTarget,rememberComposeTarget,refs:()=>({windowTargetConnected:windowTarget?.editor?.isConnected??null,composeTargetConnected:composeTarget?.editor?.isConnected??null,visibleCount:visibleItems.length})};\n})(window.module,window.module.exports,window.require);');
await require('esbuild').build({ stdin: { contents: `import React from 'react';import * as ReactDOM from 'react-dom/client';globalThis.testReact=React;globalThis.testReactDOM=ReactDOM;`, resolveDir: path.join(root, 'betterdiscord'), loader: 'js' }, bundle: true, platform: 'browser', outfile: path.join(out, 'react.js'), define: { 'process.env.NODE_ENV': '"production"' } });
fs.copyFileSync(path.join(root, 'scripts/qa/memory-host.js'), path.join(out, 'host.js'));
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>SupportTemplates memory fixture</title><style>body{margin:0;background:#25272e;color:white;font:16px sans-serif}.channelTextArea_test{position:fixed;bottom:10px;left:20px;right:20px;height:55px;display:flex}.editor{flex:1;min-height:40px}.buttons_test{display:flex}</style><div class="channelTextArea_test"><div class="editor" role="textbox" tabindex="0" data-slate-editor="true" contenteditable="true"></div><div class="buttons_test"></div></div><script src="react.js"></script><script src="host.js"></script><script src="runtime.js"></script><script>window.instance=new module.exports(); window.started=instance.start();</script>`);
fs.writeFileSync(path.join(out, 'provenance.json'), JSON.stringify({ pluginSha256: createHash('sha256').update(plugin).digest('hex'), exactPublishedBundle: true, mocks: ['Discord stores/event bus', 'test OAuth and API', 'unsupported native persistence/updater bridge'], real: ['React production', 'published BetterDiscord bundle', 'UI components and lifecycle', 'panel client, SSE parser and timers'] }, null, 2));
console.log(out);
