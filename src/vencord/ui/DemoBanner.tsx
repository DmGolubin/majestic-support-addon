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
    return <div className="vc-stx-demo-banner" role="status">ДЕМО · {d.phase === "ready" ? `тестовые шаблоны v${d.revision}` : "подключение не готово — тестовая вставка недоступна"}
        <button className="vc-stx-btn vc-stx-ghost" onClick={() => ui.set({ management: true })}>Настройки деморежима</button>
    </div>;
}
