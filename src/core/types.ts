/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type ProjectId = "mj" | "ro";
export type TemplateStatus = "actual" | "needs_review" | "outdated";

export interface Template {
    id: string;
    project: ProjectId | null;
    title: string;
    text: string;
    category: string | null;
    status: TemplateStatus;
    statusNote: string | null;
    teamUses: number;
    command: string | null;
    color: string | null;
    updatedAt: string | null;
    source: "local" | "faq" | "personal";
}

export interface Usage {
    n: number;
    last: number;
}

export const PROJECTS: Record<ProjectId, { name: string; short: string; guildId: string; }> = {
    mj: { name: "Majestic RP", short: "Majestic", guildId: "530693013622489088" },
    ro: { name: "Россия Онлайн", short: "Россия Онлайн", guildId: "1089530150540034181" },
};

export const otherProject = (p: ProjectId): ProjectId => (p === "mj" ? "ro" : "mj");
