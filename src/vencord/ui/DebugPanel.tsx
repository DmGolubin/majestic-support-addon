/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyToClipboard } from "@utils/clipboard";
import { useState } from "@webpack/common";

import { CATEGORIES, Category, filterEvents, formatEvent } from "../core/ring";
import { toast } from "../platform";
import { clearDebugLog, debugCap, debugGeometry, debugPerf, debugReport, debugSnapshot, debugState, useDebugLog, useFocusTick } from "./debug";
import { ui, useStore } from "./uiState";

type Section = "state" | "geom" | "perf" | "log";

/** Mounted only while debug mode is on. Bottom-left, above Discord's user panel; never takes focus. */
export function DebugPanel() {
    ui.use();
    useStore();
    debugState.useSelect(s => s.win);
    const verbose = debugState.useSelect(s => s.verbose);
    useFocusTick();
    const events = useDebugLog();
    const [open, setOpen] = useState(true);
    const [shown, setShown] = useState<Record<Section, boolean>>({ state: true, geom: false, perf: false, log: true });
    const [cat, setCat] = useState<Category | null>(null);

    const copy = () => {
        copyToClipboard(debugReport())
            .then(() => toast("Отчёт отладки скопирован", "success"))
            .catch(e => { console.error("[SupportTemplates] report copy failed", e); toast("Не удалось скопировать отчёт", "failure"); });
    };

    const head = (s: Section, title: string, extra = "") => (
        <button className="vc-stx-dbg-sec" onClick={() => setShown({ ...shown, [s]: !shown[s] })}>
            {shown[s] ? "▾" : "▸"} {title}{extra}
        </button>
    );
    const counts = new Map<Category, number>();
    for (const e of events) counts.set(e.cat, (counts.get(e.cat) ?? 0) + 1);
    const visible = filterEvents(events, cat);

    return (
        // preventDefault: clicks here keep focus where it was (the window's search input, the chat box).
        <div className={"vc-stx-debug" + (verbose ? " verbose" : "")} onMouseDown={e => e.preventDefault()}>
            <div className="vc-stx-dbg-head">
                <button className="vc-stx-dbg-title" onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} SupportTemplates · debug{verbose ? " · подробно" : ""}</button>
                <button onClick={copy}>Скопировать отчёт</button>
                <button onClick={clearDebugLog}>Очистить</button>
            </div>
            {open && <div className="vc-stx-dbg-body">
                {head("state", "Состояние")}
                {shown.state && <pre className="vc-stx-dbg-pre">{debugSnapshot().join("\n")}</pre>}
                {head("geom", "Геометрия")}
                {/* Layout reads: only while the section is open, and in normal mode only on demand. */}
                {shown.geom && <pre className="vc-stx-dbg-pre">{debugGeometry().join("\n")}</pre>}
                {head("perf", "Производительность")}
                {shown.perf && <pre className="vc-stx-dbg-pre">{debugPerf().join("\n")}</pre>}
                {head("log", "Журнал", ` (${events.length}/${debugCap()})`)}
                {shown.log && <>
                    <div className="vc-stx-dbg-chips">
                        <button className={cat === null ? "on" : ""} onClick={() => setCat(null)}>Все</button>
                        {CATEGORIES.map(c => (
                            <button key={c} className={cat === c ? "on" : ""} disabled={!counts.get(c) && cat !== c} onClick={() => setCat(cat === c ? null : c)}>
                                {c}{counts.get(c) ? <i>{counts.get(c)}</i> : null}
                            </button>
                        ))}
                    </div>
                    <pre className="vc-stx-dbg-pre vc-stx-dbg-log">
                        {visible.length ? visible.slice().reverse().map(e => formatEvent(e, cat === null)).join("\n") : "пусто"}
                    </pre>
                </>}
            </div>}
        </div>
    );
}
