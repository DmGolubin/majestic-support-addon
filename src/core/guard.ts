/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { soft, titleKey } from "./text";
import { otherProject, ProjectId, PROJECTS, Template } from "./types";

export type ServerBinding = ProjectId | "none";

export const DEFAULT_GUILDS: Record<string, ProjectId> = {
    [PROJECTS.mj.guildId]: "mj",
    [PROJECTS.ro.guildId]: "ro",
};

/** Key under which the answer for DMs / group DMs is remembered. */
export const DM_KEY = "@dm";

/** Project of a server: built-in table first, then the user's answer. null = never asked. */
export function projectForGuild(guildId: string | null, saved: Record<string, ServerBinding>): ServerBinding | null {
    if (!guildId) return saved[DM_KEY] ?? null;
    return DEFAULT_GUILDS[guildId] ?? saved[guildId] ?? null;
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
