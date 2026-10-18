import { createHash } from "node:crypto";
import { realpathSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { api } from "../shims/host";
export function installationPaths() {
    const origin = globalThis.location?.origin;
    if (!["https://discord.com", "https://ptb.discord.com", "https://canary.discord.com"].includes(origin)) throw new Error("Unsupported Discord origin");
    const plugins = realpathSync(api().Plugins.folder);
    const identity = createHash("sha256").update(JSON.stringify([process.platform === "win32" ? plugins.toLowerCase() : plugins, origin])).digest("hex");
    const root = join(dirname(plugins), "SupportTemplates", identity);
    for (let current = root;; current = dirname(current)) {
        try { if (lstatSync(current).isSymbolicLink()) throw new Error("Unsafe storage path"); }
        catch (error) { if ((error as any).code !== "ENOENT") throw error; }
        if (dirname(current) === current) break;
    }
    return { origin, plugins, root };
}
