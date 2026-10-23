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

/** One server project, a project selector in Tech/private messages, or disabled. */
export type ServerMode = ProjectId | "all" | "off";

/** Missing guild data is not proof of a DM. Only Discord DM (1) and group DM (3) types enable it. */
export function serverMode(guildId: string | null, channelType?: number | null): ServerMode {
    if (guildId === null && (channelType === 1 || channelType === 3)) return "all";
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

/** Validated personal visibility does not change the record's source project or API write scope. */
export function templateFitsProject(t: Template, project: ProjectId): boolean {
    if (t.source === "personal" && t.personalVisibleIn) return t.personalVisibleIn.includes(project);
    return !t.project || t.project === project;
}

/** Project FAQ/common plus the account's fetched personal records; none when off (null). */
export function poolOf(templates: Template[], scope: Scope | null, techProject: ProjectId): Template[] {
    if (scope === null) return [];
    const p = listProject(scope, techProject);
    return templates.filter(t => templateFitsProject(t, p));
}

export function findMirror(t: Template, pool: Template[], project: ProjectId): Template | null {
    if (templateFitsProject(t, project)) return null;
    const k = titleKey(t.title);
    if (!k) return null; // Unrelated emoji/punctuation titles must not become the same mirror identity.
    return pool.find(x => x.project === project && titleKey(x.title) === k) ?? null;
}

export type Decision =
    | { kind: "ok"; t: Template; }
    | { kind: "mirror"; t: Template; from: Template; }
    | { kind: "foreign"; t: Template; };

/** What to insert when template t is picked in a channel of `project`. */
export function decide(t: Template, project: ProjectId, pool: Template[]): Decision {
    if (templateFitsProject(t, project)) return { kind: "ok", t };
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
