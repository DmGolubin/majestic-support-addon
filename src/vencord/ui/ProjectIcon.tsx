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
