import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { pins, csp, assertQuickCssHtml } from './security.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function buildQuickCss({ dependencies, outputHtml }) {
    if (!dependencies) throw Error('Set QUICKCSS_DEPS_DIR to the isolated frozen QuickCSS dependency directory');
    dependencies = path.resolve(dependencies);
    for (const file of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
        if (sha(fs.readFileSync(path.join(dependencies, file))) !== sha(fs.readFileSync(path.join(here, file)))) throw Error('QuickCSS dependency recipe differs: ' + file);
    }
    const require = createRequire(path.join(dependencies, 'package.json'));
    for (const [name, version] of Object.entries(pins)) {
        const actual = JSON.parse(fs.readFileSync(path.join(dependencies, 'node_modules', name, 'package.json'))).version;
        if (actual !== version) throw Error(`QuickCSS dependency mismatch: ${name}`);
    }
    const { build } = require('esbuild');
    const purify = path.join(dependencies, 'node_modules/dompurify/dist/purify.es.mjs');
    const inputHashes = new Map();
    const record = metadata => {
        for (const file of Object.keys(metadata.inputs)) {
            if (file.startsWith('quickcss-worker:')) continue;
            const absolute = path.resolve(here, file);
            if (absolute.includes(`${path.sep}node_modules${path.sep}`) && !absolute.startsWith(dependencies + path.sep)) throw Error('QuickCSS resolved an unpinned ancestor dependency');
            const key = absolute.startsWith(dependencies + path.sep) ? 'dependencies/' + path.relative(dependencies, absolute) : 'recipe/' + path.relative(here, absolute);
            inputHashes.set(key.replaceAll('\\', '/'), sha(fs.readFileSync(absolute)));
        }
    };
    let redirectedSanitizers = 0;
    const sanitizer = {
        name: 'pinned-dompurify', setup(builder) {
            // The surrounding pinned Vencord tree has its own older Monaco.
            // Never let ancestor node_modules shadow this editor's dependency pin.
            builder.onResolve({ filter: /^monaco-editor(?:\/|$)/ }, args => ({ path: args.path === 'monaco-editor'
                ? path.join(dependencies, 'node_modules/monaco-editor/esm/vs/index.js') : require.resolve(args.path) }));
            builder.onResolve({ filter: /(?:^dompurify$|(?:^|\/)dompurify(?:\.js)?)$/ }, args => {
                // Monaco vendors its own copy: a package-manager override alone is insufficient.
                if (args.path === 'dompurify' || /[/\\]monaco-editor[/\\]/.test(args.importer)) {
                    redirectedSanitizers++;
                    return { path: purify };
                }
            });
        }
    };
    const options = { absWorkingDir: here, bundle: true, write: false, platform: 'browser', format: 'iife', target: 'chrome120', minify: true, legalComments: 'inline', metafile: true, nodePaths: [path.join(dependencies, 'node_modules')], plugins: [sanitizer], loader: { '.ttf': 'dataurl' } };
    const workers = {};
    for (const [label, entry] of Object.entries({ 'editor-worker': 'monaco-editor/editor/editor.worker', 'css-worker': 'monaco-editor/languages/features/css/css.worker' })) {
        const result = await build({ ...options, entryPoints: [require.resolve(entry)] });
        record(result.metafile);
        workers[label] = result.outputFiles[0].text;
    }
    const workerPlugin = { name: 'inline-workers', setup(builder) {
        builder.onResolve({ filter: /^quickcss:/ }, args => ({ path: args.path.slice(9), namespace: 'quickcss-worker' }));
        builder.onLoad({ filter: /.*/, namespace: 'quickcss-worker' }, args => {
            if (!(args.path in workers)) throw Error('Unknown QuickCSS worker');
            return { contents: `export default ${JSON.stringify(workers[args.path])}`, loader: 'js' };
        });
    } };
    // Wrap top-level await for an inline classic script on an opaque data: origin.
    const entry = fs.readFileSync(path.join(here, 'editor.mjs'), 'utf8');
    const split = entry.indexOf('const workers');
    if (split < 0) throw Error('QuickCSS entry structure changed');
    const result = await build({ ...options, stdin: { contents: entry.slice(0, split) + '(async () => {\n' + entry.slice(split) + '\n})();', resolveDir: here, sourcefile: 'editor.mjs' }, outfile: 'quickcss.js', plugins: [sanitizer, workerPlugin] });
    record(result.metafile);
    if (!redirectedSanitizers || Object.keys(result.metafile.inputs).some(file => /monaco-editor.*dompurify\.js$/.test(file))) throw Error('Monaco vendored sanitizer was not replaced');
    const js = result.outputFiles.find(file => file.path.endsWith('.js'))?.text;
    const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text;
    if (!js || !css) throw Error('Missing QuickCSS assets');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp.replaceAll("'", '&apos;')}"><title>Vencord QuickCSS Editor</title><style>${css}\nhtml,body,#container{width:100%;height:100%;margin:0;overflow:hidden}#status{position:absolute;inset:0;box-sizing:border-box;font:14px sans-serif;padding:24px;background:Canvas;color:CanvasText}</style></head><body><div id="container"></div><div id="status" role="alert" hidden></div></body></html>`;
    assertQuickCssHtml(html, js);
    if (!outputHtml.endsWith('.html')) throw Error('QuickCSS output must end in .html');
    fs.mkdirSync(path.dirname(path.resolve(outputHtml)), { recursive: true });
    fs.writeFileSync(outputHtml, html);
    fs.writeFileSync(outputHtml.slice(0, -5) + '.js', js);
    return { schema: 1, versions: pins, htmlSha256: sha(html), scriptSha256: sha(js), lockSha256: sha(fs.readFileSync(path.join(here, 'pnpm-lock.yaml'))), network: 'No runtime CDN; trusted packaged script, inline styles and blob workers; CSP script-src/connect-src none', redirectedSanitizers, inputs: Object.fromEntries([...inputHashes].sort(([a], [b]) => a.localeCompare(b))) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const evidence = await buildQuickCss({ dependencies: process.env.QUICKCSS_DEPS_DIR, outputHtml: process.argv[2] });
    fs.writeFileSync(process.argv[2] + '.build.json', JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ html: process.argv[2], versions: evidence.versions, sha256: evidence.htmlSha256 }));
}
