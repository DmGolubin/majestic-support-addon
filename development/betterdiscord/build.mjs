// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const own = path.join(root, 'betterdiscord');
const license = path.join(root, fs.existsSync(path.join(root, 'LICENSE')) ? 'LICENSE' : '../LICENSE');
const aliases = {
    '@webpack/common': 'common.ts', '@api/DataStore': 'data.ts', '@api/Settings': 'settings.ts',
    '@api/ChatButtons': 'chatButtons.tsx', '@utils/types': 'types.ts', '@utils/discord': 'discord.ts',
    '@utils/clipboard': 'clipboard.ts', '@components/ErrorBoundary': 'errorBoundary.tsx',
    '@shared/vencordUserAgent': 'userAgent.ts'
};
export function adapterPlugin(css = '') {
    return { name: 'betterdiscord-host', setup(builder) {
        // BD's renderer require recognizes bare polyfill names, not node: URLs.
        // Native-only modules remain behind capability-checked lazy imports.
        builder.onResolve({ filter: /^node:/ }, args => ({ path: args.path.slice(5), external: true }));
        builder.onResolve({ filter: /^stx:css$/ }, () => ({ path: 'css', namespace: 'embedded' }));
        builder.onLoad({ filter: /.*/, namespace: 'embedded' }, () => ({ contents: `export default ${JSON.stringify(css)}`, loader: 'js' }));
        builder.onResolve({ filter: /^@/ }, args => {
            if (args.path === '@electron/remote') return { path: args.path, external: true };
            const shim = aliases[args.path];
            if (!shim) throw new Error(`Unadapted host import ${args.path} in ${args.importer}`);
            return { path: path.join(own, 'shims', shim) };
        });
        builder.onResolve({ filter: /^\./ }, args => {
            const importer = args.importer.replaceAll('\\', '/');
            if (!importer.includes('/src/vencord/')) return;
            if (/\/diagnosticStorage$/.test(args.path))
                return { path: path.join(own, 'native/diagnosticStorage.ts') };
            if (/\/(?:buildInfo|panelPermission|panelVault)$/.test(args.path)) {
                const name = path.basename(args.path);
                return { path: path.join(own, name === 'panelVault' ? 'native/vaultHost.ts' : `shims/${name}.ts`) };
            }
            const core = /^(?:\.\.\/|\.\/)core\/(.+)$/.exec(args.path);
            if (core) {
                if (['panelTransport', 'panelEvents'].includes(core[1])) return { path: path.join(own, 'shims', core[1] + '.ts') };
                return { path: path.join(root, 'src/core', core[1] + '.ts') };
            }
        });
    } };
}

export async function buildPlugin({ output = path.join(own, 'out'), archive = true } = {}) {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'distribution/config.json'), 'utf8'));
    if (config.schema !== 1 || !/^\d+\.\d+\.\d+(?:-canary\.\d+)?$/.test(config.version)) throw new Error('Invalid distribution version');
    let commit, timestamp;
    // The packaged exact-source tree also builds without a Git checkout.
    if (fs.existsSync(path.join(own, 'source-info.json'))) {
        ({ commit, timestamp } = JSON.parse(fs.readFileSync(path.join(own, 'source-info.json'), 'utf8')));
        if (!/^[a-f0-9]{12,40}$/.test(commit) || !Number.isSafeInteger(timestamp)) throw new Error('Invalid source provenance');
    } else {
        commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        timestamp = Number(execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()) * 1000;
    }
    const options = {
        absWorkingDir: root, entryPoints: [path.join(own, 'entry.tsx')], bundle: true, write: false,
        platform: 'node', format: 'cjs', target: 'es2022', charset: 'utf8', legalComments: 'inline',
        jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
        inject: [path.join(own, 'shims/common.ts')], external: ['electron', '@electron/remote'],
        define: { __STX_COMMIT__: JSON.stringify(commit), VERSION: JSON.stringify('BetterDiscord'), BUILD_TIMESTAMP: String(timestamp) },
        outfile: path.join(output, 'SupportTemplates.plugin.js'), metafile: true, logLevel: 'silent',
        footer: { js: 'module.exports = module.exports.default;' }
    };
    const first = await build({ ...options, plugins: [adapterPlugin()] });
    const css = first.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
    if (!css.includes('.vc-stx-root')) throw new Error('Shared UI stylesheet missing');
    const result = await build({ ...options, plugins: [adapterPlugin(css + '\n' + fs.readFileSync(path.join(own, 'adapter.css'), 'utf8'))] });
    const header = `/**\n * @name SupportTemplates\n * @author Oblako\n * @version ${config.version}\n * @description SupportTemplates для BetterDiscord. Шаблоны поддержки Majestic / Россия Онлайн. Ctrl+Alt+T — открыть, вставка без отправки.\n * @license GPL-3.0-or-later\n */\n`;
    const pluginPath = path.join(output, 'SupportTemplates.plugin.js');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(pluginPath, header + result.outputFiles.find(file => file.path.endsWith('.js')).text);
    const inputs = Object.keys(result.metafile.inputs).sort();
    const evidence = { version: config.version, sourceCommit: commit, embeddedCssBytes: Buffer.byteLength(css),
        sha256: createHash('sha256').update(fs.readFileSync(pluginPath)).digest('hex'), inputs,
        sourceHashes: Object.fromEntries(inputs.filter(file => !file.startsWith('embedded:')).map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
        aliases, externals: [...new Set(Object.values(result.metafile.outputs).flatMap(o => o.imports.filter(i => i.external).map(i => i.path)))].sort() };
    fs.writeFileSync(path.join(output, 'build-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    fs.copyFileSync(license, path.join(output, 'LICENSE'));
    // Source archive contains exact working inputs, not a borrowed installed client or credentials.
    const source = path.join(output, 'source'); fs.mkdirSync(source, { recursive: true });
    fs.copyFileSync(license, path.join(source, 'LICENSE'));
    for (const file of ['package.json', 'pnpm-lock.yaml', 'tsconfig.json']) fs.copyFileSync(path.join(root, file), path.join(source, file));
    // Keep test sources archived so root Vitest cannot discover and recursively run
    // copies in build output. Extract this tar into source/ when testing the package.
    const testFiles = (fs.existsSync(path.join(root, 'tests')) ? fs.readdirSync(path.join(root, 'tests')) : []).filter(file => file.startsWith('betterdiscord')).map(file => 'tests/' + file);
    if (testFiles.length) execFileSync('tar', ['-cf', path.join(output, 'tests.tar'), '-C', root, ...testFiles]);
    for (const folder of ['src/core', 'src/vencord', 'distribution/updater']) fs.cpSync(path.join(root, folder), path.join(source, folder), { recursive: true });
    fs.mkdirSync(path.join(source, 'distribution'), { recursive: true });
    fs.copyFileSync(path.join(root, 'distribution/config.json'), path.join(source, 'distribution/config.json'));
    fs.mkdirSync(path.join(source, 'betterdiscord'), { recursive: true });
    for (const entry of fs.readdirSync(own)) {
        if (['node_modules', 'out'].includes(entry) || path.resolve(own, entry) === path.resolve(output)) continue;
        fs.cpSync(path.join(own, entry), path.join(source, 'betterdiscord', entry), { recursive: true });
    }
    fs.writeFileSync(path.join(source, 'betterdiscord/source-info.json'), JSON.stringify({ commit, timestamp }, null, 2) + '\n');
    let zip = null;
    if (archive) {
        zip = path.join(output, `SupportTemplates-betterdiscord-${config.version}.zip`);
        execFileSync('tar', ['-a', '-cf', zip, '-C', output, 'SupportTemplates.plugin.js', 'LICENSE', 'build-evidence.json', ...(testFiles.length ? ['tests.tar'] : []), 'source']);
    }
    return { package: output, zip, plugin: pluginPath, source };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const args = process.argv.slice(2);
    if (args.length && (args[0] !== '--out' || args.length !== 2)) throw new Error('Usage: node betterdiscord/build.mjs [--out DIRECTORY]');
    const output = args.length ? path.resolve(args[1]) : undefined;
    console.log(JSON.stringify(await buildPlugin({ output })));
}
