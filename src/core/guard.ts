/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { soft, titleKey } from "./text";
import { otherProject, ProjectId, PROJECTS, Template } from "./types";

/** Legacy: per-server answers of the old "which project is this server?" dialog. Kept only so old saved data still type-checks; never read for decisions. */
export type ServerBinding = ProjectId | "none";

/** «Tech™» — the support staff server: templates of both projects are available there. */
export const TECH_GUILD = "1395915167040016545";

/** How the plugin works on a server: one project, all templates (Tech), or not at all. */
export type ServerMode = ProjectId | "all" | "off";

/** Fixed table: Majestic → mj, Россия Онлайн → ro, Tech → all; any other server, DMs and group DMs → off. */
export function serverMode(guildId: string | null): ServerMode {
    if (!guildId) return "off";
    if (guildId === PROJECTS.mj.guildId) return "mj";
    if (guildId === PROJECTS.ro.guildId) return "ro";
    if (guildId === TECH_GUILD) return "all";
    return "off";
}

export function findMirror(t: Template, pool: Template[], project: ProjectId): Template | null {
    if (!t.project || t.project === project) return null;
    const k = titleKey(t.title);
    return pool.find(x => x.project === project && titleKey(x.title) === k) ?? null;
}

export type Decision =
    | { kind: "ok"; t: Template; }
    | { kind: "mirror"; t: Template; from: Template; }
    | { kind: "foreign"; t: Template; };

/** What to insert when template t is picked in a channel of `project`. */
export function decide(t: Template, project: ProjectId, pool: Template[]): Decision {
    if (!t.project || t.project === project) return { kind: "ok", t };
    const m = findMirror(t, pool, project);
    return m ? { kind: "mirror", t: m, from: t } : { kind: "foreign", t };
}

const MARKERS: Record<ProjectId, string[]> = {
    mj: ["majestic-rp.ru", "gta5majestic.com", "majestic rp", "маджестик"],
    ro: ["russia.online", "россия онлайн", "russia online"],
};

/** Markers of the *other* project found in a template that has no project of its own. */
export function foreignMarkers(text: string, project: ProjectId): string[] {
    const s = soft(text);
    return MARKERS[otherProject(project)].filter(m => s.includes(m))
        .filter((m, _i, arr) => !arr.some(o => o !== m && o.includes(m)));
}
