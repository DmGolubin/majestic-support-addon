/*
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import "./ipc";
import { app } from "electron";
import { initCsp } from "@main/csp";
import { IS_VANILLA } from "@main/utils/constants";

if (!IS_VANILLA) void app.whenReady().then(initCsp);
require("../main/patcher");
