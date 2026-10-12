/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PROJECTS } from "../core/types";
import { chatAreaRect } from "../platform";
import { nqHighlight } from "./highlight";
import { acceptInline } from "./inline";
import { ProjectIcon } from "./ProjectIcon";
import { activeProject, ui } from "./uiState";

export function Inline() {
    const inline = ui.useSelect(s => s.inline);
    const hasCompose = ui.useSelect(s => s.compose.length > 0);
    if (!inline) return null;
    const rect = chatAreaRect();
    if (!rect) return null;
    const { project } = activeProject();
    return (
        <div className="vc-stx-pop" style={{ left: rect.left + 8, bottom: window.innerHeight - rect.top + 6 + (hasCompose ? 48 : 0) }}>
            <div className="vc-stx-sec">Шаблоны{project ? " · " + PROJECTS[project].name : ""}</div>
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
            <div className="vc-stx-foot">Tab / Enter — подставить · Shift+Tab — без приветствия · ↑↓ · Esc</div>
        </div>
    );
}
