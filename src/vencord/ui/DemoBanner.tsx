/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { demo } from "./demo";
import { ui } from "./uiState";

export function DemoBanner() {
    const d = demo.use();
    if (!d.enabled) return null;
    return <button className="vc-stx-demo-banner" title="Настройки деморежима" onClick={() => ui.set({ management: true })}>Демо</button>;
}
