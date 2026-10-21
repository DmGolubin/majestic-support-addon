/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { ReminderPlaybackTicket } from "./panelReminders";
import { PROJECTS } from "./types";

const snowflake = (value: unknown): value is string => typeof value === "string"
    && /^[1-9]\d{16,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;

/** Only explicit API mapping; an opaque panel ticketId is never a Discord channel ID. */
export function reminderDestination(ticket: Pick<ReminderPlaybackTicket, "project" | "guildId" | "channelId">) {
    const project = ticket.project === "majestic" ? "mj" : ticket.project === "russia-online" ? "ro" : null;
    if (!project || ticket.guildId !== PROJECTS[project].guildId || !snowflake(ticket.channelId)) return null;
    return { guildId: ticket.guildId, channelId: ticket.channelId };
}
