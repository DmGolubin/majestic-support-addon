import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vencord = process.env.VENCORD_DIR ?? "C:/Users/oblako/dev/Vencord";
const dest = join(vencord, "src/userplugins/supportTemplates");
if (!existsSync(join(vencord, "package.json"))) throw new Error("Vencord not found at " + vencord);

// Plugin root = src/vencord (index.tsx at the top), core goes to ./core next to it.
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(root, "src/vencord"), dest, { recursive: true });
cpSync(join(root, "src/core"), join(dest, "core"), { recursive: true });
const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts/sync-vencord.mjs'], { cwd: root, encoding: 'utf8' }).trim();
const build = `${revision}${dirty ? '+working' : ''} · ${new Date().toISOString()}`;
const info = join(dest, 'buildInfo.ts');
writeFileSync(info, readFileSync(info, 'utf8').replace('"source"', JSON.stringify(build)));
console.log("synced →", dest);
