// Run from the extracted source.tar root after pnpm install --frozen-lockfile.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const recipe = JSON.parse(fs.readFileSync('vencord-full-build.json', 'utf8'));
execFileSync(process.execPath, ['scripts/build/build.mjs', '--standalone', '--disable-updater'], {
    stdio: 'inherit', env: { ...process.env, VENCORD_HASH: recipe.upstreamCommit.slice(0, 7), VENCORD_REMOTE: 'Vendicated/Vencord', SOURCE_DATE_EPOCH: String(recipe.buildTimestamp) }
});
