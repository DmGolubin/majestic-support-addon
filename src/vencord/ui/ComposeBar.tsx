/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useState } from "@webpack/common";

import { joinPieces } from "../core/compose";
import { activeEditor, chatAreaRect, currentChannel, insertText, toast } from "../platform";
import { confirmedForeign, fillFields, Snap, stillCurrent } from "./flow";
import { ProjectIcon } from "./ProjectIcon";
import { activeProject, store, ui } from "./uiState";

export function ComposeBar() {
    const { compose } = ui.use();
    const [drag, setDrag] = useState<string | null>(null);
    if (!compose.length) return null;
    const rect = chatAreaRect();
    if (!rect) return null;
    const items = compose.map(id => store.byId(id)).filter(t => !!t);

    const move = (over: string) => {
        if (!drag || drag === over) return;
        const ids = compose.filter(x => x !== drag);
        ids.splice(ids.indexOf(over) + (compose.indexOf(drag) < compose.indexOf(over) ? 1 : 0), 0, drag);
        ui.set({ compose: ids });
    };

    const insertAll = async () => {
        const snap: Snap = { channelId: currentChannel().id, project: activeProject().project };
        // Every piece must be common, of the channel's project, or a foreign one the user confirmed for it.
        const fits = () => {
            const p = snap.project;
            if (items.every(t => !t!.project || (p && (t!.project === p || confirmedForeign.has(`${p}:${t!.id}`))))) return true;
            toast("В ответе есть шаблон другого проекта — вставка отменена", "failure");
            return false;
        };
        if (!fits()) return;
        const text = await fillFields("\u041E\u0442\u0432\u0435\u0442", joinPieces(items.map(t => t!.text)));
        if (text === null || !stillCurrent(snap) || !fits()) return;
        activeEditor()?.focus();
        if (!insertText(text)) return;
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
                    <button onMouseDown={e => e.stopPropagation()} onClick={() => ui.set({ compose: compose.filter(x => x !== t!.id) })}>✕</button>
                </span>
            ))}
            <span style={{ flex: 1 }} />
            <button className="vc-stx-btn vc-stx-ghost" onClick={() => ui.set({ compose: [] })}>Очистить</button>
            <button className="vc-stx-btn" onClick={insertAll}>Вставить всё</button>
        </div>
    );
}
