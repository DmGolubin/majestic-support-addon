/* Copyright (c) 2026 SupportTemplates contributors. GPL-3.0-or-later. */
"use strict";
const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const resources = path.dirname(__dirname);
const original = path.join(resources, "_app.asar");

function rejectRedirects(location) {
    let current = path.resolve(location);
    while (true) {
        if (fs.existsSync(current) && (fs.lstatSync(current).isSymbolicLink()
            || fs.realpathSync(current).toLowerCase() !== current.toLowerCase())) throw new Error("Redirected location");
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
}

// A rejected host must never become the fallback destination either.
const hostPath = path.relative(process.env.LOCALAPPDATA, resources);
const hostMatch = /^(DiscordCanary|Discord)[\\/]app-\d+\.\d+\.\d+[\\/]resources$/i.exec(hostPath);
if (!hostMatch || !fs.existsSync(original)) throw new Error("Invalid original Discord location");
rejectRedirects(resources);
rejectRedirects(original);
const hostChannel = hostMatch[1].toLowerCase() === "discordcanary" ? "canary" : "stable";

function originalDiscord() {
    const pkg = require(path.join(original, "package.json"));
    app.setAppPath(original);
    require.main.filename = path.join(original, pkg.main);
    return require(require.main.filename);
}

let config;
try {
    config = JSON.parse(fs.readFileSync(path.join(resources, "support-templates.json"), "utf8").replace(/^\uFEFF/, ""));
    if (config.schema !== 1 || config.product !== "SupportTemplates" || !["canary", "stable"].includes(config.channel)) throw new Error("Invalid loader configuration");
    if (config.channel !== hostChannel) throw new Error("Wrong host channel");
    const root = path.join(process.env.LOCALAPPDATA, "SupportTemplates", "channels", config.channel);
    const runtime = path.resolve(config.runtime);
    const relative = path.relative(path.join(root, "versions"), runtime);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !/^[^\\/]+[\\/]runtime$/.test(relative)) throw new Error("Invalid runtime location");
    if (path.resolve(config.dataDir).toLowerCase() !== path.join(root, "data").toLowerCase()) throw new Error("Invalid data location");
    if (!fs.existsSync(path.join(runtime, "patcher.js")) || !fs.existsSync(path.join(runtime, "preload.js"))) throw new Error("Missing runtime");
    // Re-check at launch: a junction could have appeared after installation.
    for (const location of [runtime, config.dataDir, path.join(runtime, "patcher.js"), path.join(runtime, "preload.js")]) rejectRedirects(location);
    config.runtime = runtime;
} catch {
    console.error("[SupportTemplates] Runtime unavailable. Starting original Discord; run repair.bat.");
    config = null;
}

if (!config || process.argv.includes("--vanilla")) {
    originalDiscord();
} else {
    process.env.SUPPORT_TEMPLATES_DATA_DIR = config.dataDir;
    process.env.DISABLE_UPDATER_AUTO_PATCHING = "1";
    require(path.join(config.runtime, "patcher.js"));
}
