/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ProjectId, PROJECTS } from "../core/types";
import { MJ_ICON, RO_ICON } from "./icons";

export function ProjectIcon({ project, size = 16 }: { project: ProjectId | null; size?: number; }) {
    if (!project) return <span className="vc-stx-pi vc-stx-pi-none" style={{ width: size, height: size }}>★</span>;
    return (
        <img
            className={"vc-stx-pi vc-stx-pi-" + project}
            src={project === "mj" ? MJ_ICON : RO_ICON}
            alt={PROJECTS[project].short}
            style={{ width: size, height: size }}
        />
    );
}

/** Chat-bar icon, 24x24 like Discord's own buttons; no project = neutral «Ш» tile (no image). */
export function ChatBarIcon({ project }: { project: ProjectId | null; }) {
    if (!project) return <span className="vc-stx-cbi vc-stx-cbi-none" aria-hidden="true">Ш</span>;
    return <img className={"vc-stx-cbi vc-stx-cbi-" + project} src={project === "mj" ? MJ_ICON : RO_ICON} alt="" />;
}
