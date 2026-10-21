/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { ChannelStore, NavigationRouter, PermissionStore } from "@webpack/common";

import { reminderDestination } from "./core/reminderDestination";
import { ReminderPlaybackTicket } from "./core/panelReminders";

/** Local Discord mapping/permission must agree with the freshly checked panel assignment. Never sends. */
export function openReminderChannel(ticket: ReminderPlaybackTicket, current: () => boolean): boolean {
    try {
        const destination = reminderDestination(ticket);
        if (!destination || !current()) return false;
        const channel = ChannelStore.getChannel(destination.channelId);
        if (!channel || channel.id !== destination.channelId || channel.guild_id !== destination.guildId
            || !PermissionStore.can(1024n, channel) || !current()) return false;
        NavigationRouter.transitionTo(`/channels/${destination.guildId}/${destination.channelId}`);
        return true;
    } catch { return false; }
}
