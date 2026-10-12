import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
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
console.log("synced →", dest);
