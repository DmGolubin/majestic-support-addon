/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type ProjectId = "mj" | "ro";
export type TemplateStatus = "actual" | "needs_review" | "outdated";
export type WindowTab = "all" | "personal" | "fav" | "recent";
export const WINDOW_TABS: readonly WindowTab[] = ["all", "personal", "fav", "recent"];
export const WINDOW_TAB_LABELS: Record<WindowTab, string> = { all: "Все", personal: "Мои", fav: "Избранное", recent: "Недавние" };

/** Retain valid saved order, remove duplicates, append new or missing tabs. */
export function readWindowTabOrder(value: unknown): WindowTab[] {
    const result: WindowTab[] = [];
    if (Array.isArray(value)) {
        for (let i = 0; i < Math.min(value.length, 32); i++) {
            const tab = Object.getOwnPropertyDescriptor(value, String(i))?.value;
            if (WINDOW_TABS.includes(tab) && !result.includes(tab)) result.push(tab);
        }
    }
    return [...result, ...WINDOW_TABS.filter(tab => !result.includes(tab))];
}

export function moveWindowTab(order: readonly WindowTab[], from: WindowTab, to: WindowTab): WindowTab[] {
    const next = readWindowTabOrder(order);
    const source = next.indexOf(from), target = next.indexOf(to);
    if (source < 0 || target < 0 || source === target) return next;
    next.splice(source, 1);
    next.splice(target, 0, from);
    return next;
}

export interface Template {
    id: string;
    /** Source project, retained for editor writes and folder ownership. */
    project: ProjectId | null;
    /** Memory-only personal visibility from the validated account snapshot; never a write scope. */
    personalVisibleIn?: readonly ProjectId[];
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
