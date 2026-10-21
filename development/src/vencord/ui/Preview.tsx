/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useMemo } from "@webpack/common";

import { splitGreeting } from "../core/text";
import { PROJECTS, Template } from "../core/types";
import { insertTemplate } from "./flow";
import { latchButtonKey } from "./keylatch";
import { Markdown } from "./markdown";
import { ProjectIcon } from "./ProjectIcon";
import { IconBack, IconEnter, IconStar } from "./svg";
import { store } from "./uiState";

/** 1 раз, 2 раза, 5 раз. */
export function plural(n: number, one: string, few: string, many: string) {
    const d = n % 10, h = n % 100;
    return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
}

/** Tooltip body: fade the bottom only when the text is actually cut off (it cannot be scrolled). */
const markCut = (el: HTMLDivElement | null) => {
    if (el) el.classList.toggle("cut", el.scrollHeight > el.clientHeight + 1);
};

/**
 * compact = hover tooltip: text only, no action buttons, no scrolling.
 * onBack = the window is in compact mode (the preview covers the list): a «назад» button on top.
 */
export function Preview({ t, compact = false, onBack }: { t: Template | undefined; compact?: boolean; onBack?: () => void; }) {
    const parts = useMemo(() => t ? splitGreeting(t.text) : null, [t]);
    const backBtn = onBack && <button className="vc-stx-back" title="Скрыть текст (стрелка влево)" onClick={onBack}><IconBack size={13} />назад</button>;
    if (!t || !parts) return <div className="vc-stx-pre">{backBtn}<div className="vc-stx-empty">Выбери шаблон</div></div>;
    const { greeting, body } = parts;
    const uses = store.data.usage[t.id]?.n ?? 0;
    const fav = store.isFavorite(t.id);
    return (
        <div className="vc-stx-pre">
            {backBtn}
            <h4>{t.title}</h4>
            <div className="vc-stx-meta">
                <span className="vc-stx-mchip"><ProjectIcon project={t.project} size={14} />{t.project ? PROJECTS[t.project].name : "общий"}</span>
                {uses > 0 && <span className="vc-stx-mchip">использован {uses} {plural(uses, "раз", "раза", "раз")}</span>}
                {t.category && <span className="vc-stx-mchip">{t.category}</span>}
                {t.source === "local" && <span className="vc-stx-mchip">локальный</span>}
            </div>
            <div className="vc-stx-body" ref={compact ? markCut : undefined}>
                {greeting && <>
                    <span className="vc-stx-greet"><Markdown text={greeting} /></span>{"\n"}
                    <span className="vc-stx-gmark">граница приветствия</span>{"\n"}
                </>}
                <Markdown text={body} />
            </div>
            {compact && <div className="vc-stx-tiphint">Shift — весь текст</div>}
            {!compact && <div className="vc-stx-acts">
                <button className="vc-stx-btn" onKeyDown={latchButtonKey} onClick={() => insertTemplate(t, { via: "preview" })}>Вставить <span className="vc-stx-kb"><IconEnter size={12} /></span></button>
                {greeting && <button className="vc-stx-btn vc-stx-ghost" onKeyDown={latchButtonKey} onClick={() => insertTemplate(t, { noGreeting: true, via: "preview" })}>Без приветствия</button>}
                <button className="vc-stx-btn vc-stx-ghost vc-stx-icon vc-stx-right" title="Избранное (Ctrl+D)" onClick={() => store.toggleFavorite(t.id)}><IconStar size={16} filled={fav} /></button>
            </div>}
        </div>
    );
}
