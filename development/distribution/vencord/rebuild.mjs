// Run from the extracted source.tar root after pnpm install --frozen-lockfile.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildQuickCss } from './distribution/quickcss/build.mjs';
const recipe = JSON.parse(fs.readFileSync('vencord-full-build.json', 'utf8'));
const quickCss = await buildQuickCss({ dependencies: process.env.QUICKCSS_DEPS_DIR, outputHtml: 'src/main/monacoWin.html' });
fs.writeFileSync('quickcss-build.json', JSON.stringify(quickCss, null, 2));
execFileSync(process.execPath, ['scripts/build/build.mjs', '--standalone', '--disable-updater'], {
    stdio: 'inherit', env: { ...process.env, VENCORD_HASH: recipe.upstreamCommit.slice(0, 7), VENCORD_REMOTE: 'Vendicated/Vencord', SOURCE_DATE_EPOCH: String(recipe.buildTimestamp) }
});
