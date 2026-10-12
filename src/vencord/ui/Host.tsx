/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ui } from "./uiState";

export function Host() {
    const s = ui.use();
    return (
        <div className="vc-stx-root">
            {s.windowOpen && <div className="vc-stx-win" style={{ right: 80, bottom: 80, width: 300, height: 120 }}>окно</div>}
        </div>
    );
}
