/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PROJECTS } from "./types";

export const MAX_TICKET_SOUND_BYTES = 5 * 1024 * 1024;
export const MAX_TICKET_SOUND_SECONDS = 30;

/** Encoded local bytes only; never a URL, path, or executable media element. */
export interface CustomTicketSound {
    version: 1;
    name: string;
    data: string;
}

export function ticketSoundFileName(name: string): string {
    return name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 160) || "Свой звук";
}

/** DataStore is untrusted on read. Duration is checked again after decoding. */
export function readCustomTicketSound(value: unknown): CustomTicketSound | null {
    if (!value || typeof value !== "object") return null;
    const v = value as Partial<CustomTicketSound>;
    if (v.version !== 1 || typeof v.name !== "string" || typeof v.data !== "string") return null;
    const { data } = v;
    if (!data.length || data.length > Math.ceil(MAX_TICKET_SOUND_BYTES / 3) * 4 || data.length % 4 !== 0) return null;
    // Strip at most two padding characters before checking the alphabet, avoiding
    // a repeated-group regexp over a multi-megabyte string.
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    if (/[^A-Za-z0-9+/]/.test(data.slice(0, data.length - padding))) return null;
    if (data.length / 4 * 3 - padding > MAX_TICKET_SOUND_BYTES) return null;
    return { version: 1, name: ticketSoundFileName(v.name), data };
}

export interface TicketSoundOptions {
    enabled: boolean;
    channelIds: string[];
    volume: number;
    cooldownMs: number;
    quietWhenVisible: boolean;
}

export const defaultTicketSound = (): TicketSoundOptions => ({
    enabled: false,
    channelIds: ["696711470783922247", "1534231644842754090"],
    volume: 30,
    cooldownMs: 3000,
    quietWhenVisible: true,
});

export function readTicketSound(value: unknown): TicketSoundOptions {
    const base = defaultTicketSound();
    if (!value || typeof value !== "object") return base;
    const v = value as Partial<TicketSoundOptions>;
    const number = (x: unknown, min: number, max: number, fallback: number) => typeof x === "number" && Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : fallback;
    return {
        enabled: v.enabled === true,
        channelIds: Array.isArray(v.channelIds) ? [...new Set(v.channelIds.filter((id): id is string => typeof id === "string" && /^\d{17,20}$/.test(id)))].slice(0, 20) : base.channelIds,
        volume: number(v.volume, 0, 100, base.volume),
        cooldownMs: number(v.cooldownMs, 1000, 30000, base.cooldownMs),
        quietWhenVisible: typeof v.quietWhenVisible === "boolean" ? v.quietWhenVisible : true,
    };
}

export interface NewTicketEvent {
    id: string;
    parentId: string;
    guildId: string;
    newlyCreated?: boolean;
    archived?: boolean;
}

/** No content, authors or ticket ownership inferred here. Fresh snowflakes reject history/replays. */
export class TicketSoundGate {
    private seen = new Map<string, number>();
    private lastSound = -Infinity;
    constructor(private startedAt: number) { }

    accept(e: NewTicketEvent, options: TicketSoundOptions, now: number, visible: boolean): boolean {
        if (!options.enabled || !options.channelIds.includes(e.parentId)) return false;
        if (e.guildId !== PROJECTS.mj.guildId && e.guildId !== PROJECTS.ro.guildId) return false;
        if (e.newlyCreated === false || e.archived || !/^\d{17,20}$/.test(e.id)) return false;
        const created = Number(BigInt(e.id) >> 22n) + 1420070400000;
        if (created < this.startedAt || created < now - 30000 || created > now + 5000) return false;
        for (const [id, at] of this.seen) if (at < now - 60000) this.seen.delete(id);
        if (this.seen.has(e.id)) return false;
        this.seen.set(e.id, now);
        if (this.seen.size > 1000) this.seen.delete(this.seen.keys().next().value!);
        if (options.volume === 0 || (visible && options.quietWhenVisible) || now - this.lastSound < options.cooldownMs) return false;
        this.lastSound = now;
        return true;
    }
}
