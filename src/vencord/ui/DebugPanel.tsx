/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyToClipboard } from "@utils/clipboard";
import { useState } from "@webpack/common";

import { formatEvent } from "../core/ring";
import { toast } from "../platform";
import { clearDebugLog, debugReport, debugSnapshot, debugState, useDebugLog, useFocusTick } from "./debug";
import { ui, useStore } from "./uiState";

/** Mounted only while debug mode is on. Bottom-left, above Discord's user panel; never takes focus. */
export function DebugPanel() {
    ui.use();
    useStore();
    debugState.useSelect(s => s.win);
    useFocusTick();
    const events = useDebugLog();
    const [open, setOpen] = useState(true);

    const copy = () => {
        copyToClipboard(debugReport())
            .then(() => toast("Отчёт отладки скопирован", "success"))
            .catch(e => { console.error("[SupportTemplates] report copy failed", e); toast("Не удалось скопировать отчёт", "failure"); });
    };

    return (
        // preventDefault: clicks here keep focus where it was (the window's search input, the chat box).
        <div className="vc-stx-debug" onMouseDown={e => e.preventDefault()}>
            <div className="vc-stx-dbg-head">
                <button className="vc-stx-dbg-title" onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} SupportTemplates · debug</button>
                <button onClick={copy}>Скопировать отчёт</button>
                <button onClick={clearDebugLog}>Очистить</button>
            </div>
            {open && <>
                <pre className="vc-stx-dbg-state">{debugSnapshot().join("\n")}</pre>
                <div className="vc-stx-dbg-sec">События ({events.length}/30)</div>
                <pre className="vc-stx-dbg-log">{events.length ? events.slice().reverse().map(formatEvent).join("\n") : "пусто"}</pre>
            </>}
        </div>
    );
}
