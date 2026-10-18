/* SPDX-License-Identifier: GPL-3.0-or-later */
import { app, Notification } from "electron";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const { createUpdater } = require("../../distribution/updater/index.cjs");
const { createStandaloneController } = require("./update-controller.cjs");
const { launchUpdateHelper } = require("./update-launcher.cjs");

export function startAutoUpdate() {
    if (process.platform !== "win32") return;
    try {
        const channel = process.env.SUPPORT_TEMPLATES_CHANNEL;
        if (channel !== "stable" && channel !== "canary") throw new Error("Missing installed host channel");
        const root = join(process.env.LOCALAPPDATA!, "SupportTemplates", "channels", channel);
        if (resolve(process.env.SUPPORT_TEMPLATES_DATA_DIR!).toLowerCase() !== join(root, "data").toLowerCase())
            throw new Error("Unexpected installed data directory");
        const config = JSON.parse(readFileSync(join(__dirname, "update-config.json"), "utf8"));
        // Release channel (canary/stable) is separate from the installed Discord channel.
        const controller = createStandaloneController({ createUpdater, config,
            stagingDir: join(root, "auto-updates"),
            launch: (pending: any) => launchUpdateHelper({ pending, channel, channelRoot: root,
                helperPath: join(__dirname, "update-helper.ps1"), parentPid: process.pid,
                currentVersion: config.version }),
            notify: (version: string) => {
                if (Notification.isSupported()) new Notification({ title: "SupportTemplates",
                    body: `Обновление ${version} загружено. После полного выхода из Discord оно установится автоматически. Сохраните черновики перед выходом.` }).show();
            },
            onError: (error: any) => console.warn("[SupportTemplates] Update unavailable; will retry.", error?.code ?? "unavailable")
        });
        void controller.start();
        app.once("before-quit", () => { void controller.stop(); });
    } catch (error) {
        // An unavailable/private feed or broken updater must never block Discord startup.
        console.warn("[SupportTemplates] Automatic updates unavailable.");
    }
}
