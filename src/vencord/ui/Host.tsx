/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { useState } from "@webpack/common";

import { toast } from "../platform";
import { ComposeBar } from "./ComposeBar";
import { ContextMenu } from "./ContextMenu";
import { debugState, dlog } from "./debug";
import { DebugPanel } from "./DebugPanel";
import { Dialogs, idOf } from "./Dialogs";
import { supersede } from "./flow";
import { Inline } from "./InlinePop";
import { ui, UiState } from "./uiState";
import { Window } from "./Window";

// Each part has its own ErrorBoundary: a UI error never breaks Discord's chat input. On error the
// part's state is reset and the boundary remounts (new key), so the next open works again.
const RESET: Record<string, () => Partial<UiState>> = {
    window: () => ({ windowOpen: false }),
    compose: () => ({ compose: [] }),
    inline: () => ({ inline: null }),
    menu: () => ({ menu: null }),
    dialog: () => { supersede(); return { dialog: null }; },
    debug: () => ({}),
};

export function Host() {
    const windowOpen = ui.useSelect(s => s.windowOpen);
    const dialog = ui.useSelect(s => s.dialog);
    const debugOn = debugState.useSelect(s => s.on);
    const [gen, setGen] = useState<Record<string, number>>({});
    const safe = (part: string, node: React.ReactNode, key: string | number = "") => (
        <ErrorBoundary
            key={`${part}-${gen[part] ?? 0}-${key}`}
            noop
            onError={({ error }) => {
                console.error("[SupportTemplates] UI error in " + part, error);
                dlog("error", { where: "ErrorBoundary:" + part, msg: String((error as any)?.message ?? error) });
                ui.set(RESET[part]());
                toast("Ошибка интерфейса шаблонов — подробности в консоли", "failure");
                setGen(g => ({ ...g, [part]: (g[part] ?? 0) + 1 }));
            }}
        >{node}</ErrorBoundary>
    );
    return (
        <div className="vc-stx-root">
            {windowOpen && safe("window", <Window />)}
            {safe("compose", <ComposeBar />)}
            {safe("inline", <Inline />)}
            {safe("menu", <ContextMenu />)}
            {safe("dialog", <Dialogs />, dialog ? idOf(dialog) : 0)}
            {debugOn && safe("debug", <DebugPanel />)}
        </div>
    );
}
