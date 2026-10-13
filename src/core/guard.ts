/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { soft, titleKey } from "./text";
import { otherProject, ProjectId, PROJECTS, Template } from "./types";

/** Legacy: per-server answers of the old "which project is this server?" dialog. Kept only so old saved data still type-checks; never read for decisions. */
export type ServerBinding = ProjectId | "none";

/** «Tech™» — the support staff server: either project, picked in the window's switch; no project guard. */
export const TECH_GUILD = "1395915167040016545";

/** How the plugin works on a server: one project, Tech (project from the switch, no guard), or not at all. */
export type ServerMode = ProjectId | "all" | "off";

/** Fixed table: Majestic → mj, Россия Онлайн → ro, Tech → all; any other server, DMs and group DMs → off. */
export function serverMode(guildId: string | null): ServerMode {
    if (!guildId) return "off";
    if (guildId === PROJECTS.mj.guildId) return "mj";
    if (guildId === PROJECTS.ro.guildId) return "ro";
    if (guildId === TECH_GUILD) return "all";
    return "off";
}

/** Which templates a server gets: one project (+ common) or Tech ("all"). */
export type Scope = ProjectId | "all";

/**
 * The project whose templates (+ common ones) a scope lists. Tech lists the project picked in its
 * switch (`techProject`) — but Tech still has no mirror/foreign/marker guard: any template is fine there.
 */
export const listProject = (scope: Scope, techProject: ProjectId): ProjectId => scope === "all" ? techProject : scope;

/** Templates visible in a scope: the listed project's own + common (no project); none when off (null). */
export function poolOf(templates: Template[], scope: Scope | null, techProject: ProjectId): Template[] {
    if (scope === null) return [];
    const p = listProject(scope, techProject);
    return templates.filter(t => !t.project || t.project === p);
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
