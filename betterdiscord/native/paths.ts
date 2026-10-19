import { createHash } from "node:crypto";
import { realpathSync, lstatSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { api } from "../shims/host";
import { hasNativeStorage } from "./capabilities";
export function installationPaths() {
    const origin = globalThis.location?.origin;
    if (!["https://discord.com", "https://ptb.discord.com", "https://canary.discord.com"].includes(origin)) throw new Error("Unsupported Discord origin");
    const plugins = realpathSync(api().Plugins.folder);
    const identity = createHash("sha256").update(JSON.stringify([process.platform === "win32" ? plugins.toLowerCase() : plugins, origin])).digest("hex");
    const root = join(dirname(plugins), "SupportTemplates", identity);
    const native = hasNativeStorage();
    for (let current = root;; current = dirname(current)) {
        // Electron's context bridge drops Error.code; missing paths are normal
        // before first use. Other failures still propagate without being ignored.
        if (native) {
            // Native lstat also detects dangling links, which existsSync follows.
            try { if (lstatSync(current).isSymbolicLink()) throw new Error("Unsafe storage path"); }
            catch (error) { if ((error as any).code !== "ENOENT") throw error; }
        } else if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Unsafe storage path");
        if (dirname(current) === current) break;
    }
    return { origin, plugins, root };
}
