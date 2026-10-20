// Native service-panel source fixture. No real Discord, network or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..').replaceAll('\\', '/');
const out = path.resolve(process.argv[2] ?? '').replaceAll('\\', '/');
if (!out.startsWith(root + '/scripts/qa/runs/') || fs.existsSync(out)) throw Error('Use a new directory under scripts/qa/runs');
fs.mkdirSync(out, { recursive: true });
const require = createRequire(root + '/betterdiscord/package.json');
const { build } = require('esbuild');
const version = JSON.parse(fs.readFileSync(root + '/distribution/config.json')).version;
fs.writeFileSync(out + '/inject.js', "export {default as React} from 'react';");
const stubs = {
    '@webpack/common': "export * from 'react';",
    './panel': "export const panel={useSelect:fn=>fn({phase:'ready'})};",
    './uiState': "export const ui={set:patch=>window.handoffs.push(patch)};",
    '../buildInfo': `export const PLUGIN_VERSION=${JSON.stringify(version)};export const PLUGIN_BUILD='source fixture';export const PLUGIN_DISTRIBUTION=location.search.includes('standalone')?'standalone':'vencord';`,
    './diagnostics': "export const diagnosticFile=()=>('{}');export const downloadDiagnostics=()=>{};export const setRecording=()=>{};",
};
await build({ stdin: { resolveDir: out, loader: 'tsx', contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import '${root}/src/vencord/styles.css';
import {NativeServiceSettings} from '${root}/src/vencord/ui/NativeServiceSettings.tsx';
window.handoffs=[];
function App(){const [shown,setShown]=React.useState(true);
window.serviceFixture={close:()=>setShown(false),stop:()=>document.getElementById('vc-stx-host')?.remove()};
return <main>{shown&&<NativeServiceSettings/>}</main>}
createRoot(document.getElementById('fixture')).render(<App/>);`
}, bundle: true, outfile: out + '/app.js', nodePaths: [root + '/betterdiscord/node_modules'], inject: [out + '/inject.js'],
plugins: [{ name: 'offline-native-host', setup(b) {
    b.onResolve({ filter: /.*/ }, args => {
        if (Object.hasOwn(stubs, args.path)) return { path: args.path, namespace: 'fixture' };
        if (args.path.includes('/core/') && args.importer.replaceAll('\\', '/').includes('/src/vencord/'))
            return { path: root + '/src/core/' + path.basename(args.path) + '.ts' };
    });
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'tsx', resolveDir: out }));
} }] });
fs.writeFileSync(out + '/index.html', `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="app.css"><style>body{margin:0;background:#313338;color:#dbdee1;font:16px 'Segoe UI',sans-serif}main{max-width:600px;margin:20px auto;padding:16px}</style><div id="vc-stx-host"></div><div id="fixture"></div><script src="app.js"></script>`);
const files = ['src/vencord/ui/NativeServiceSettings.tsx', 'src/vencord/ui/DiagnosticControls.tsx', 'src/vencord/ui/BuildIdentity.tsx', 'src/vencord/styles.css', 'src/vencord/ui/settings-layout.css'];
fs.writeFileSync(out + '/provenance.json', JSON.stringify({ version, sourceHashes: Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(root + '/' + file)).digest('hex')])),
    limitation: 'Real source React/CSS; synthetic host lifetime, connection and diagnostic actions. Not Discord modal acceptance.' }, null, 2));
console.log(out);
