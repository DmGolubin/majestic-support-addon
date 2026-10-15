/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ProjectId, Template } from "./types";

export const PERSONAL_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899"];
export interface PersonalFolder { id: string; name: string; }
export interface PersonalTemplate extends Template { source: "personal"; folderId: string | null; }
export interface PersonalDraft { title: string; text: string; project: ProjectId | null; color: string | null; command: string | null; folderId: string | null; }

export function personalTemplate(id: string, draft: PersonalDraft, folders: PersonalFolder[]): PersonalTemplate {
    const title = draft.title.trim();
    if (!title || title.length > 160) throw new Error("Название: от 1 до 160 символов");
    if (!draft.text.trim() || draft.text.length > 20000) throw new Error("Текст: от 1 до 20 000 символов");
    if (draft.project !== null && draft.project !== "mj" && draft.project !== "ro") throw new Error("Выберите проект");
    if (draft.color !== null && !PERSONAL_COLORS.includes(draft.color)) throw new Error("Выберите цвет из палитры");
    const command = draft.command?.trim().toLowerCase() || null;
    if (command && !/^[\p{L}\p{N}_-]{1,40}$/u.test(command)) throw new Error("Команда: до 40 букв, цифр, дефисов или подчёркиваний, без префикса");
    const folder = folders.find(f => f.id === draft.folderId);
    if (draft.folderId && !folder) throw new Error("Папка больше не существует");
    return { id, ...draft, title, command, source: "personal", folderId: folder?.id ?? null, category: folder?.name ?? "Мои шаблоны", status: "actual", statusNote: null, teamUses: 0, updatedAt: new Date().toISOString() };
}

/** Local prototype records stay separate from the imported FAQ. Future API IDs can be mapped here. */
export function readPersonal(value: unknown, folders: PersonalFolder[]): PersonalTemplate[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.flatMap(v => {
        if (!v || typeof v.id !== "string" || !v.id.startsWith("personal:") || seen.has(v.id)) return [];
        try {
            const t = personalTemplate(v.id, { ...v, folderId: folders.some(f => f.id === v.folderId) ? v.folderId : null }, folders);
            if (typeof v.updatedAt === "string" && Number.isFinite(Date.parse(v.updatedAt))) t.updatedAt = v.updatedAt;
            seen.add(t.id);
            return [t];
        } catch { return []; }
    });
}

export function readFolders(value: unknown): PersonalFolder[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.flatMap(f => {
        if (!f || typeof f.id !== "string" || !f.id.startsWith("folder:") || seen.has(f.id) || typeof f.name !== "string" || !f.name.trim()) return [];
        seen.add(f.id);
        return [{ id: f.id, name: f.name.trim().slice(0, 80) }];
    });
}
