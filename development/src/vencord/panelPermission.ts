/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PANEL_ORIGIN } from "./core/panelProtocol";

interface HostPermissions {
    isDomainAllowed(url: string, directives: string[]): Promise<boolean>;
    requestAddOverride(url: string, directives: string[], caller: string): Promise<string>;
}

export type PanelPermission = "ready" | "required" | "restart" | "unavailable";

/** Ask only on an explicit login click; restoring a session never opens a permission prompt. */
export function createPanelPermission(check: HostPermissions) {
    let restart = false;
    return async (interactive: boolean): Promise<PanelPermission> => {
        if (restart) return "restart";
        try {
            if (await check.isDomainAllowed(PANEL_ORIGIN, ["connect-src"])) return "ready";
            if (!interactive) return "required";
            const result = await check.requestAddOverride(PANEL_ORIGIN, ["connect-src"], "SupportTemplates");
            if (result === "ok") { restart = true; return "restart"; }
            return result === "cancelled" || result === "unchecked" ? "required" : "unavailable";
        } catch { return "unavailable"; }
    };
}

let check: ReturnType<typeof createPanelPermission> | undefined;
export async function ensurePanelPermission(interactive: boolean): Promise<PanelPermission> {
    if (typeof IS_WEB !== "undefined" && IS_WEB) return "ready";
    if (typeof VencordNative === "undefined" || !VencordNative.csp) return "unavailable";
    check ??= createPanelPermission(VencordNative.csp);
    return check(interactive);
}
