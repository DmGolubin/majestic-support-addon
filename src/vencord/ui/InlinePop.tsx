/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PROJECTS } from "../core/types";
import { costEnd, costStart } from "./debug";
import { nqHighlight } from "./highlight";
import { acceptInline } from "./inline";
import { ProjectIcon } from "./ProjectIcon";
import { activeScope, listedProject, ui, useChatRect } from "./uiState";

/** Its render is a `render` cost span while debug is on. */
export function Inline() {
    const t0 = costStart();
    try { return InlineView(); } finally { costEnd("render", t0); }
}

function InlineView() {
    const inline = ui.useSelect(s => s.inline);
    const hasCompose = ui.useSelect(s => s.compose.length > 0);
    const rect = useChatRect(!!inline);
    if (!inline) return null;
    if (!rect) return null;
    const scope = activeScope();
    const listed = listedProject(scope);
    const width = Math.max(0, Math.min(560, rect.width - 16, window.innerWidth - 16));
    const left = Math.max(8, Math.min(rect.left + 8, window.innerWidth - width - 8));
    return (
        <div className="vc-stx-pop" style={{ left, width, bottom: window.innerHeight - rect.top + 6 + (hasCompose ? 48 : 0) }}>
            <div className="vc-stx-sec">Шаблоны{listed ? " · " + PROJECTS[listed].name : ""}{scope === "all" ? " (Tech)" : ""}</div>
            {inline.note && <div className="vc-stx-empty">{inline.note}</div>}
            {inline.items.map((t, i) => (
                <div
                    key={t.id}
                    className={"vc-stx-item" + (i === inline.sel ? " sel" : "")}
                    onMouseDown={e => { if (e.button !== 0) return; e.preventDefault(); void acceptInline(i, false); }}
                >
                    <div className="vc-stx-r">
                        <ProjectIcon project={t.project} />
                        <span className="vc-stx-nm">{nqHighlight(t.title, [inline.query.toLowerCase()])}</span>
                        {t.command && <span className="vc-stx-kb">{t.command}</span>}
                    </div>
                </div>
            ))}
            <div className="vc-stx-foot">Tab / Enter — подставить · Shift+Tab — без приветствия · стрелки — выбор · Esc</div>
        </div>
    );
}
