/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useState } from "@webpack/common";

import { joinPieces } from "../core/compose";
import { insertText, toast } from "../platform";
import { costEnd, costStart, dlog } from "./debug";
import { confirmedForeign, fillFields, focusTarget, snapNow, stillCurrent } from "./flow";
import { composeEditor, composeTargetNow, resetComposeTarget } from "./op";
import { ProjectIcon } from "./ProjectIcon";
import { IconClose } from "./svg";
import { store, ui, useChatRect } from "./uiState";

/** Its render is a `render` cost span while debug is on. */
export function ComposeBar() {
    const t0 = costStart();
    try { return ComposeBarView(); } finally { costEnd("render", t0); }
}

function ComposeBarView() {
    const compose = ui.useSelect(s => s.compose);
    const [drag, setDrag] = useState<string | null>(null);
    const rect = useChatRect(compose.length > 0, composeEditor);
    if (!compose.length) return null;
    if (!rect) return null;
    const items = compose.map(id => store.byId(id)).filter(t => !!t);

    const move = (over: string) => {
        if (!drag || drag === over) return;
        const ids = compose.filter(x => x !== drag);
        ids.splice(ids.indexOf(over) + (compose.indexOf(drag) < compose.indexOf(over) ? 1 : 0), 0, drag);
        ui.set({ compose: ids });
    };

    const insertAll = async () => {
        if (!items.length) { ui.set({ compose: [] }); return; } // every piece was removed (import): nothing to insert
        const snap = snapNow(composeTargetNow()); // the editor the answer was started in
        // Every piece must be common, of the channel's project, or a foreign one the user confirmed for it; on Tech ("all") any piece fits.
        const fits = () => {
            const p = snap.scope;
            if (p === "all" || items.every(t => !t!.project || (p && (t!.project === p || confirmedForeign.has(`${p}:${t!.id}`))))) return true;
            dlog("cancel", { reason: "в ответе шаблон другого проекта", scope: p });
            toast("В ответе есть шаблон другого проекта — вставка отменена", "failure");
            return false;
        };
        if (!fits()) return;
        const text = await fillFields("Ответ", joinPieces(items.map(t => t!.text)), snap);
        if (text === null || !fits()) return;
        if (!stillCurrent(snap)) {
            if (snap.editor && !snap.editor.isConnected) resetComposeTarget(); // the next click goes to the current editor
            return;
        }
        focusTarget(snap);
        const ok = insertText(text);
        dlog("insert", { ids: items.map(t => t!.id).join(","), via: "compose", ok });
        if (!ok) { dlog("error", { where: "insertText", via: "compose" }); return; }
        items.forEach(t => store.markUsed(t!.id));
        ui.set({ compose: [] });
    };

    return (
        <div
            className="vc-stx-compose"
            style={{ left: rect.left + 8, width: rect.width - 16, bottom: window.innerHeight - rect.top + 6 }}
            onMouseUp={() => setDrag(null)}
            onMouseLeave={() => setDrag(null)}
        >
            <span className="vc-stx-sec" style={{ margin: 0 }}>Ответ:</span>
            {items.map(t => (
                <span
                    key={t!.id}
                    className={"vc-stx-chip" + (drag === t!.id ? " drag" : "")}
                    onMouseDown={e => { e.preventDefault(); setDrag(t!.id); }}
                    onMouseEnter={() => move(t!.id)}
                    title="Перетащи, чтобы поменять порядок"
                >
                    <ProjectIcon project={t!.project} size={14} />{t!.title}
                    <button onMouseDown={e => e.stopPropagation()} title="Убрать из ответа" onClick={() => ui.set({ compose: compose.filter(x => x !== t!.id) })}><IconClose size={12} /></button>
                </span>
            ))}
            <span style={{ flex: 1 }} />
            <button className="vc-stx-btn vc-stx-ghost" onClick={() => ui.set({ compose: [] })}>Очистить</button>
            <button className="vc-stx-btn" onClick={insertAll}>Вставить всё</button>
        </div>
    );
}
