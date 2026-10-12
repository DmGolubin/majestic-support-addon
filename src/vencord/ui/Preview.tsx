/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useMemo } from "@webpack/common";

import { splitGreeting } from "../core/text";
import { PROJECTS, Template } from "../core/types";
import { addToCompose, insertTemplate } from "./flow";
import { Markdown } from "./markdown";
import { ProjectIcon } from "./ProjectIcon";
import { store } from "./uiState";

/** 1 раз, 2 раза, 5 раз. */
export function plural(n: number, one: string, few: string, many: string) {
    const d = n % 10, h = n % 100;
    return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
}

/** compact = hover tooltip: text only, no action buttons. */
export function Preview({ t, compact = false }: { t: Template | undefined; compact?: boolean; }) {
    const parts = useMemo(() => t ? splitGreeting(t.text) : null, [t]);
    if (!t || !parts) return <div className="vc-stx-pre"><div className="vc-stx-empty">Выбери шаблон</div></div>;
    const { greeting, body } = parts;
    const uses = store.data.usage[t.id]?.n ?? 0;
    const fav = store.isFavorite(t.id);
    return (
        <div className="vc-stx-pre">
            <h4>{t.title}</h4>
            <div className="vc-stx-meta">
                <span className="vc-stx-mchip"><ProjectIcon project={t.project} size={14} />{t.project ? PROJECTS[t.project].name : "общий"}</span>
                {uses > 0 && <span className="vc-stx-mchip">использован {uses} {plural(uses, "раз", "раза", "раз")}</span>}
                {t.category && <span className="vc-stx-mchip">{t.category}</span>}
                {t.source === "local" && <span className="vc-stx-mchip">локальный</span>}
            </div>
            <div className="vc-stx-body">
                {greeting && <>
                    <span className="vc-stx-greet"><Markdown text={greeting} /></span>{"\n"}
                    <span className="vc-stx-gmark">граница приветствия</span>{"\n"}
                </>}
                <Markdown text={body} />
            </div>
            {!compact && <div className="vc-stx-acts">
                <button className="vc-stx-btn" onClick={() => insertTemplate(t)}>Вставить <span className="vc-stx-kb">↵</span></button>
                {greeting && <button className="vc-stx-btn vc-stx-ghost" onClick={() => insertTemplate(t, { noGreeting: true })}>Без приветствия</button>}
                <button className="vc-stx-btn vc-stx-ghost" onClick={() => addToCompose(t)}>+ в ответ</button>
                <button className="vc-stx-btn vc-stx-ghost vc-stx-icon vc-stx-right" title="Избранное (Ctrl+D)" onClick={() => store.toggleFavorite(t.id)}>{fav ? "★" : "☆"}</button>
            </div>}
        </div>
    );
}
