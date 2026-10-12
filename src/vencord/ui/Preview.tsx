/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { splitGreeting } from "../core/text";
import { PROJECTS, Template } from "../core/types";
import { addToCompose, insertTemplate } from "./flow";
import { store } from "./uiState";

/** compact = hover tooltip: text only, no action buttons. */
export function Preview({ t, compact = false }: { t: Template | undefined; compact?: boolean; }) {
    if (!t) return <div className="vc-stx-pre"><div className="vc-stx-empty">Выбери шаблон</div></div>;
    const { greeting, body } = splitGreeting(t.text);
    const uses = store.data.usage[t.id]?.n ?? 0;
    const meta = [
        t.category,
        t.project ? PROJECTS[t.project].name : "общий",
        t.source === "local" ? "локальный" : null,
        uses ? `использован ${uses} раз` : null,
        t.teamUses ? `командой ${t.teamUses} раз` : null,
    ].filter(Boolean).join(" · ");
    const fav = store.isFavorite(t.id);
    return (
        <div className="vc-stx-pre">
            <h4>{t.title}</h4>
            <div className="vc-stx-meta">{meta}</div>
            <div className="vc-stx-body">
                {greeting && <><span className="vc-stx-greet">{greeting}</span>{"\n"}<span className="vc-stx-gmark">— граница приветствия —</span>{"\n"}</>}
                {body}
            </div>
            {!compact && <div className="vc-stx-acts">
                <button className="vc-stx-btn" onClick={() => insertTemplate(t)}>Вставить</button>
                {greeting && <button className="vc-stx-btn vc-stx-ghost" onClick={() => insertTemplate(t, { noGreeting: true })}>Без приветствия</button>}
                <button className="vc-stx-btn vc-stx-ghost" onClick={() => addToCompose(t)}>+ в ответ</button>
                <button className="vc-stx-btn vc-stx-ghost" title="Избранное (Ctrl+D)" onClick={() => store.toggleFavorite(t.id)}>{fav ? "★" : "☆"}</button>
            </div>}
        </div>
    );
}
