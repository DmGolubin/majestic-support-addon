/*
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import "./ipc";
import { app } from "electron";
import { initCsp } from "@main/csp";
import { IS_VANILLA } from "@main/utils/constants";
import { startAutoUpdate } from "./update";

if (!IS_VANILLA) void app.whenReady().then(() => {
    initCsp();
    startAutoUpdate();
});
// Bootstrap on the original call stack, before Electron ready. Never await update
// preparation here: Discord/Sentry must register their native startup hooks now.
require("../main/patcher");
