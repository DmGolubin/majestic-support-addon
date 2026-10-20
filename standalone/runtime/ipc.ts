/* SPDX-License-Identifier: GPL-3.0-or-later */
import "../main/ipcPlugins";
import "../main/settings";
import { IpcEvents } from "@shared/IpcEvents";
import { ipcMain, shell, systemPreferences } from "electron";
import { readFileSync } from "fs";
import { join } from "path";

// The package declares its only external API host. No arbitrary CSP overrides or native code updater.
ipcMain.handle(IpcEvents.CSP_IS_DOMAIN_ALLOWED, (_, raw: string, directives: string[]) => {
    try { return new URL(raw).origin === "https://panel.majestic-rp.tech" && directives.every(d => d === "connect-src"); }
    catch { return false; }
});
ipcMain.handle(IpcEvents.CSP_REQUEST_ADD_OVERRIDE, () => "invalid");
ipcMain.handle(IpcEvents.CSP_REMOVE_OVERRIDE, () => false);
ipcMain.handle(IpcEvents.INIT_FILE_WATCHERS, () => {});
ipcMain.handle(IpcEvents.GET_RENDERER_CSS, () => readFileSync(join(__dirname, "renderer.css"), "utf8"));
ipcMain.on(IpcEvents.PRELOAD_GET_RENDERER_JS, e => { e.returnValue = readFileSync(join(__dirname, "renderer.js"), "utf8"); });
ipcMain.on(IpcEvents.SUPPORTS_WINDOWS_MATERIAL, e => { e.returnValue = false; });
ipcMain.handle(IpcEvents.GET_THEME_SYSTEM_VALUES, () => ({ "os-accent-color": "#" + systemPreferences.getAccentColor() }));
ipcMain.handle(IpcEvents.OPEN_EXTERNAL, (_, raw: string) => {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Unsupported link");
    return shell.openExternal(url.href);
});
