/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyToClipboard } from "@utils/clipboard";
import { useEffect, useState } from "@webpack/common";

import { CATEGORIES, Category, filterEvents, formatEvent } from "../core/ring";
import { toast } from "../platform";
import { clearDebugLog, costEnd, costStart, debugCap, debugCount, debugEvents, debugGeometry, debugPerf, debugReport, debugSnapshot, debugState, onGeometryEvent, usePanelTick } from "./debug";

type Section = "state" | "geom" | "perf" | "log";

/** The log section shows only the newest events; the report has the whole ring. */
const LOG_SHOWN = 50;

/** Mounted only while debug mode is on. Bottom-left, above Discord's user panel; never takes focus. Its render is a `debug` cost span. */
export function DebugPanel() {
    const t0 = costStart();
    try { return DebugPanelView(); } finally { costEnd("debug", t0); }
}

function DebugPanelView() {
    const [open, setOpen] = useState(true);
    const [shown, setShown] = useState<Record<Section, boolean>>({ state: true, geom: false, perf: false, log: true });
    const [cat, setCat] = useState<Category | null>(null);
    const [geom, setGeom] = useState("");
    // Throttled: at most 4 renders a second; collapsed, only the header counter follows new events.
    usePanelTick(open);
    const { verbose } = debugState.get();

    // Geometry reads layout: never in render — once a second while the section is open, and on window open/close/resize.
    const geomOn = open && shown.geom;
    useEffect(() => {
        if (!geomOn) return;
        let raf = 0;
        const measure = () => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => setGeom(debugGeometry().join("\n")));
        };
        measure();
        const iv = setInterval(measure, 1000);
        const off = onGeometryEvent(measure);
        return () => { clearInterval(iv); cancelAnimationFrame(raf); off(); };
    }, [geomOn]);

    const copy = () => {
        copyToClipboard(debugReport())
            .then(() => toast("Отчёт отладки скопирован", "success"))
            .catch(e => { console.error("[SupportTemplates] report copy failed", e); toast("Не удалось скопировать отчёт", "failure"); });
    };

    const title = (
        <button className="vc-stx-dbg-title" onClick={() => setOpen(!open)}>
            {open ? "▾" : "▸"} SupportTemplates · debug{verbose ? " · подробно" : ""}{open ? "" : ` · ${debugCount()}/${debugCap()}`}
        </button>
    );
    const header = (
        <div className="vc-stx-dbg-head">
            {title}
            <button onClick={copy}>Скопировать отчёт</button>
            <button onClick={clearDebugLog}>Очистить</button>
        </div>
    );
    const cls = "vc-stx-debug" + (verbose ? " verbose" : "");
    // preventDefault: clicks here keep focus where it was (the window's search input, the chat box).
    if (!open) return <div className={cls} onMouseDown={e => e.preventDefault()}>{header}</div>;

    const events = debugEvents();
    const head = (s: Section, name: string, extra = "") => (
        <button className="vc-stx-dbg-sec" onClick={() => setShown({ ...shown, [s]: !shown[s] })}>
            {shown[s] ? "▾" : "▸"} {name}{extra}
        </button>
    );
    const counts = new Map<Category, number>();
    for (const e of events) counts.set(e.cat, (counts.get(e.cat) ?? 0) + 1);
    const visible = filterEvents(events, cat);
    const tail = visible.slice(-LOG_SHOWN);

    return (
        <div className={cls} onMouseDown={e => e.preventDefault()}>
            {header}
            <div className="vc-stx-dbg-body">
                {head("state", "Состояние")}
                {shown.state && <pre className="vc-stx-dbg-pre">{debugSnapshot().join("\n")}</pre>}
                {head("geom", "Геометрия", " (раз в секунду)")}
                {shown.geom && <pre className="vc-stx-dbg-pre">{geom || "…"}</pre>}
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
                    {visible.length > LOG_SHOWN && <div className="vc-stx-dbg-note">показаны последние {LOG_SHOWN} из {visible.length}; в отчёте — все</div>}
                    <pre className="vc-stx-dbg-pre vc-stx-dbg-log">
                        {tail.length ? tail.reverse().map(e => formatEvent(e, cat === null)).join("\n") : "пусто"}
                    </pre>
                </>}
            </div>
        </div>
    );
}
