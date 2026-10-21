// Run from the prepared, pinned Vencord source tree. No checkout mutation or downloads.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { builtinModules } from 'node:module';
import { build } from 'esbuild';

const config = JSON.parse(fs.readFileSync('standalone-config.json', 'utf8'));
const virtual = {
    '~plugins': `
        import support from './src/userplugins/supportTemplates';
        import chat from './src/plugins/_api/chatButtons';
        import settings from './src/standalone/settings';
        import extractor from './src/plugins/_core/concatenatedComponentExtractor';
        support.required = true;
        export default {SupportTemplates:support,ChatInputButtonAPI:chat,Settings:settings,ConcatenatedComponentExtractor:extractor};
        export const PluginMeta = {}; export const ExcludedPlugins = {};`,
    '~pluginNatives': `import * as support from './src/userplugins/supportTemplates/native'; export default {SupportTemplates:support};`,
    '~git-hash': `export default ${JSON.stringify(config.upstreamCommit.slice(0, 8))};`,
    '~git-remote': `export default 'SupportTemplates/standalone';`
};
const registry = { name: 'standalone-registry', setup(b) {
    b.onResolve({ filter: /^~(plugins|pluginNatives|git-hash|git-remote)$/ }, ({ path }) => ({ path, namespace: 'standalone' }));
    b.onLoad({ filter: /.*/, namespace: 'standalone' }, ({ path }) => ({ contents: virtual[path], resolveDir: process.cwd() }));
} };
const define = Object.fromEntries(Object.entries({
    IS_STANDALONE: true, IS_DEV: false, IS_REPORTER: false, IS_ANTI_CRASH_TEST: false,
    IS_UPDATER_DISABLED: true, IS_WEB: false, IS_EXTENSION: false, IS_USERSCRIPT: false,
    IS_DISCORD_DESKTOP: true, IS_VESKTOP: false, VERSION: config.version,
    BUILD_TIMESTAMP: config.timestamp
}).map(([k, v]) => [k, JSON.stringify(v)]));
const common = { bundle: true, minify: true, metafile: true, sourcemap: 'external', legalComments: 'linked',
    define, plugins: [registry], target: 'es2022', tsconfig: 'tsconfig.json',
    inject: ['./scripts/build/inject/react.mjs'], jsx: 'transform', jsxFactory: 'VencordCreateElement', jsxFragment: 'VencordFragment',
    banner: { js: `// SupportTemplates ${config.version}; based on Vencord ${config.upstreamCommit}; upstream updater disabled.` }
};
const outputs = await Promise.all([
    build({ ...common, platform: 'node', format: 'cjs', external: ['electron', 'electron/*', 'original-fs'], entryPoints: ['src/standalone/main.ts'], outfile: 'dist/patcher.js' }),
    build({ ...common, platform: 'node', format: 'cjs', external: ['electron', 'electron/*', 'original-fs'], entryPoints: ['src/preload.ts'], outfile: 'dist/preload.js' }),
    build({ ...common, platform: 'browser', format: 'iife', globalName: 'Vencord', external: ['/assets/*'], entryPoints: ['src/standalone/renderer.ts'], outfile: 'dist/renderer.js' })
]);
const inputs = [...new Set(outputs.flatMap(o => Object.keys(o.metafile.inputs)))].sort();
fs.mkdirSync('build-evidence', { recursive: true });
for (let i = 0; i < outputs.length; i++) fs.writeFileSync(`build-evidence/metafile-${i}.json`, JSON.stringify(outputs[i].metafile, null, 2));
const allowed = ['src/plugins/_api/chatButtons.ts', 'src/plugins/_core/concatenatedComponentExtractor.tsx'];
for (const input of inputs) {
    if (input.startsWith('src/plugins/') && !allowed.includes(input)) throw new Error(`Unexpected plugin input: ${input}`);
    if (/src\/(main\/updater|main\/persistAfterDiscordUpdates|api\/SettingsSync|components\/settings|main\/utils\/extensions)/.test(input)) throw new Error(`Forbidden feature input: ${input}`);
}
for (const output of outputs) {
    for (const [name, info] of Object.entries(output.metafile.outputs)) {
        for (const imported of info.imports) {
            if (!imported.external) continue;
            const id = imported.path.replace(/^node:/, '');
            if (!['electron', 'electron/renderer', 'original-fs'].includes(id) && !builtinModules.includes(id) && !id.startsWith('/assets/')) throw new Error(`Unpackaged external dependency in ${name}: ${id}`);
        }
    }
}
fs.mkdirSync('build-evidence', { recursive: true });
fs.writeFileSync('build-evidence/inputs.json', JSON.stringify({ rendererPlugins: config.rendererPlugins, nativePlugins: config.nativePlugins, inputs }, null, 2));
const require = createRequire(import.meta.url);
const dependencies = Object.fromEntries(['esbuild', 'typescript', '@intrnl/xxhash64', 'diff'].map(name => {
    let directory = path.dirname(require.resolve(name));
    while (true) {
        const file = path.join(directory, 'package.json');
        if (fs.existsSync(file)) {
            const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (pkg.name === name) return [name, pkg.version];
        }
        const parent = path.dirname(directory);
        if (parent === directory) throw new Error(`Cannot establish dependency version: ${name}`);
        directory = parent;
    }
}));
fs.writeFileSync('build-evidence/toolchain.json', JSON.stringify({ node: process.version, dependencies }, null, 2));
console.log(`Built ${config.product} ${config.version}: ${inputs.length} source inputs; forbidden feature checks passed.`);
