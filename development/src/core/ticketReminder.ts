/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Trusted server state, not inferred from mentions, thread membership or message authors. */
export interface WaitingTicket {
    id: string;
    assigneeId: string | null;
    state: "waiting_support" | "waiting_player" | "pool" | "closed";
    waitingSince: number | null;
    /** Stable for the whole unanswered period, including additional player messages. */
    waitingCycleId: string | null;
    returnToPoolAt: number | null;
}

/** Pure decision only. The future transport must validate identity, freshness and snapshot ordering. */
export function reminderDue(ticket: WaitingTicket, me: string, minutes: 5 | 10 | 15, serverNow: number): boolean {
    return !!me && ticket.assigneeId === me && ticket.state === "waiting_support"
        && !!ticket.waitingCycleId && ticket.waitingSince !== null && Number.isFinite(ticket.waitingSince)
        && Number.isFinite(serverNow) && serverNow >= ticket.waitingSince + minutes * 60000
        && (ticket.returnToPoolAt === null || (Number.isFinite(ticket.returnToPoolAt) && serverNow < ticket.returnToPoolAt));
}

/** One reminder per unanswered period. Persist receipts in the adapter before enabling real use. */
export const reminderKey = (accountId: string, ticket: WaitingTicket) => JSON.stringify([accountId, ticket.id, ticket.waitingCycleId]);
