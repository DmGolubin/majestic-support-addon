/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ComposeBar } from "./ComposeBar";
import { ContextMenu } from "./ContextMenu";
import { Dialogs } from "./Dialogs";
import { ui } from "./uiState";
import { Window } from "./Window";

export function Host() {
    const s = ui.use();
    return (
        <div className="vc-stx-root">
            {s.windowOpen && <Window />}
            <ComposeBar />
            <ContextMenu />
            <Dialogs />
        </div>
    );
}
