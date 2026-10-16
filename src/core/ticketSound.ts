/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PROJECTS } from "./types";

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
