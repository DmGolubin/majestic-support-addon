/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import "~plugins";
import { initPluginManager, startAllPlugins } from "@api/PluginManager";
import { initStyles } from "@api/Styles";
import { StartAt } from "@utils/types";
import { onceReady } from "@webpack";

export * as Api from "./api";
export * as Plugins from "@api/PluginManager";
export * as Webpack from "../webpack";
export * as WebpackPatcher from "../webpack/patchWebpack";
export { Settings, PlainSettings } from "@api/Settings";

export const standalone = Object.freeze({ product: "SupportTemplates", version: VERSION, updater: false });
initPluginManager();
initStyles();
startAllPlugins(StartAt.Init);
void onceReady.then(() => startAllPlugins(StartAt.WebpackReady));
document.addEventListener("DOMContentLoaded", () => startAllPlugins(StartAt.DOMContentLoaded), { once: true });
