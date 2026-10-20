/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { diagnosticData, diagnosticJournal } from "./diagnosticJournal";

export type ReminderProject = "majestic" | "russia-online";

export interface PanelNotificationSettings {
    version: string;
    discordEnabled: boolean;
    thresholdSource: "telegram";
    projects: { project: ReminderProject; personalReminderMinutes: number; telegramEnabled: boolean }[];
}

export interface ReminderContext {
    accountId: string;
    projects: readonly string[];
    sessionId: string;
    permissionsRevision: string;
    /** The parent has verified the session, Discord account and tickets:assigned:read scope. */
    enabled: boolean;
}

export interface PanelAssignedTicket {
    ticketId: string;
    guildId: string | null;
    channelId: string | null;
    project: ReminderProject;
    assigneeAccountId: string;
    state: "waiting_support" | "waiting_player";
    waitingSince: number | null;
    waitingCycleId: string | null;
    reminderAt: number | null;
    reminderId: string | null;
}
/** No account/session identity crosses the audio boundary. */
export type ReminderPlaybackTicket = Pick<PanelAssignedTicket, "ticketId" | "channelId" | "guildId" | "project" | "waitingCycleId" | "reminderId"> & { cycle: number };

/** Parsed timestamps are UTC epoch milliseconds. Revisions and reminder IDs stay opaque. */
export interface PanelAssignedSnapshot {
    accountId: string;
    revision: string;
    serverTime: number;
    checkedAt: number;
    maxAgeSeconds: 75;
    discordEnabled: boolean;
    tickets: PanelAssignedTicket[];
}

export interface ReminderState {
    status: "stopped" | "refreshing" | "ready" | "unavailable";
    ticket?: PanelAssignedTicket;
    played?: boolean;
}

export interface ReminderOptions {
    accountId: string;
    projects: readonly string[];
    /** Fresh, uncached GET /tickets/assigned JSON. Errors may carry retryAfterMs. */
    get: () => Promise<unknown>;
    storage: {
        get(key: string): Promise<unknown>;
        /** Resolve only after durable persistence; undefined from get means no saved value. */
        set(key: string, value: unknown): Promise<void>;
    };
    /** Check stillValid after decode/resume awaits and immediately before starting audio. */
    play: (stillValid: () => boolean, ticket?: ReminderPlaybackTicket) => Promise<boolean>;
    current: () => ReminderContext | null;
    onState?: (state: ReminderState) => void;
    clock?: {
        /** Monotonic elapsed milliseconds, including suspended time where available. */
        now(): number;
        setTimeout(callback: () => void, ms: number): unknown;
        clearTimeout(handle: unknown): void;
    };
    random?: () => number;
}

export interface ReminderController {
    start(): void;
    stop(): void;
    invalidate(event?: string): void;
    refresh(): Promise<void>;
}

const MAX_AGE_MS = 75_000;
const OVERDUE_RETRY_MS = 5_000;
const RECEIPT_LIMIT = 10_000;
const RECEIPT_KEY = "SupportTemplates_panel_reminder_receipts_v1";
type Receipt = [accountId: string, project: ReminderProject, ticketId: string, reminderId: string];

class ReminderDataError extends Error {
    constructor(readonly reason: string) { super("Invalid panel reminder data"); }
}
function invalid(reason = "invalid_response"): never { throw new ReminderDataError(reason); }
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    return value as Record<string, unknown>;
}
function text(value: unknown): string {
    if (typeof value !== "string" || !value.length || value.length > 512
        || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
    return value;
}
function snowflake(value: unknown): string {
    const id = text(value);
    if (!/^[1-9]\d{16,19}$/.test(id) || BigInt(id) > 18446744073709551615n) return invalid();
    return id;
}
function boolean(value: unknown): boolean {
    if (typeof value !== "boolean") return invalid();
    return value;
}
function project(value: unknown): ReminderProject {
    if (value !== "majestic" && value !== "russia-online") return invalid();
    return value;
}
function list(value: unknown, max: number): unknown[] {
    if (!Array.isArray(value) || value.length > max) return invalid();
    return [...value];
}
function projects(value: unknown): ReminderProject[] {
    const result = list(value, 2).map(project);
    if (new Set(result).size !== result.length) return invalid();
    return result;
}
function timestamp(value: unknown): number {
    const s = text(value);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(s)) return invalid();
    const ms = Date.parse(s);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== s.slice(0, 19)) return invalid();
    return ms;
}

/** Settings are read-only here. Telegram thresholds never determine a local reminderAt. */
export function parseNotificationSettings(raw: unknown): PanelNotificationSettings {
    const r = object(raw);
    const version = text(r.version);
    // Suitable for the parent's quoted If-Match header, without transforming the version.
    if (!/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(version) || r.thresholdSource !== "telegram") return invalid();
    const rows = list(r.projects, 2).map(value => {
        const row = object(value);
        if (typeof row.personalReminderMinutes !== "number" || !Number.isSafeInteger(row.personalReminderMinutes)
            || row.personalReminderMinutes <= 0) return invalid();
        return { project: project(row.project), personalReminderMinutes: row.personalReminderMinutes,
            telegramEnabled: boolean(row.telegramEnabled) };
    });
    if (new Set(rows.map(row => row.project)).size !== rows.length) return invalid();
    return { version, discordEnabled: boolean(r.discordEnabled), thresholdSource: "telegram", projects: rows };
}

/** All-or-nothing validation, including foreign assignments; never silently filter a bad snapshot. */
export function parseAssignedSnapshot(raw: unknown, accountId: string, allowedProjects: readonly string[]): PanelAssignedSnapshot {
    const allowed = projects(allowedProjects);
    const r = object(raw);
    if (snowflake(r.accountId) !== snowflake(accountId)) return invalid("snapshot_account");
    if (r.maxAgeSeconds !== 75) return invalid();
    const serverTime = timestamp(r.serverTime), checkedAt = timestamp(r.checkedAt);
    if (checkedAt > serverTime || serverTime - checkedAt > MAX_AGE_MS) return invalid("stale_snapshot");
    const seen = new Set<string>();
    const tickets = list(r.tickets, 4000).map(value => {
        const row = object(value);
        const p = project(row.project), ticketId = text(row.ticketId);
        const key = JSON.stringify([p, ticketId]);
        if (!allowed.includes(p) || seen.has(key)) return invalid();
        if (snowflake(row.assigneeAccountId) !== accountId) return invalid("foreign_assignment");
        seen.add(key);
        const base = { ticketId, project: p, assigneeAccountId: accountId,
            guildId: row.guildId === null ? null : snowflake(row.guildId),
            channelId: row.channelId === null ? null : snowflake(row.channelId) };
        if (row.state === "waiting_player") {
            if ([row.waitingSince, row.waitingCycleId, row.reminderAt, row.reminderId].some(v => v !== null)) return invalid();
            return { ...base, state: "waiting_player" as const, waitingSince: null, waitingCycleId: null, reminderAt: null, reminderId: null };
        }
        if (row.state !== "waiting_support") return invalid();
        const waitingSince = timestamp(row.waitingSince), reminderAt = timestamp(row.reminderAt);
        if (waitingSince > checkedAt || reminderAt < waitingSince) return invalid();
        return { ...base, state: "waiting_support" as const, waitingSince, reminderAt,
            waitingCycleId: text(row.waitingCycleId), reminderId: text(row.reminderId) };
    });
    return { accountId, revision: text(r.revision), serverTime, checkedAt, maxAgeSeconds: 75,
        discordEnabled: boolean(r.discordEnabled), tickets };
}

// Serialize durable read/modify/write across controllers sharing this storage object. Different
// processes/devices require an atomic adapter; the API deliberately has no delivery coordination.
const storageTails = new WeakMap<ReminderOptions["storage"], Promise<void>>();
let diagnosticCycle = 0;
function trace(event: string, data: Record<string, unknown>) {
    try { diagnosticJournal.record(`runtime.reminder_${event}`, data); } catch { /* Diagnostics are observational. */ }
}
function ticketTrace(ticket: PanelAssignedTicket | ReminderPlaybackTicket) {
    return diagnosticData({
        ticketId: ticket.ticketId, channelId: ticket.channelId, guildId: ticket.guildId, project: ticket.project,
        waitingCycleId: ticket.waitingCycleId, reminderId: ticket.reminderId,
        ...("state" in ticket ? { state: ticket.state, waitingSince: ticket.waitingSince, reminderAt: ticket.reminderAt,
            thresholdMs: ticket.reminderAt !== null && ticket.waitingSince !== null ? ticket.reminderAt - ticket.waitingSince : undefined } : {}),
    });
}
function withStorage<T>(storage: ReminderOptions["storage"], work: () => Promise<T>): Promise<T> {
    const result = (storageTails.get(storage) ?? Promise.resolve()).then(work);
    const tail = result.then(() => {}, () => {});
    storageTails.set(storage, tail);
    void tail.then(() => { if (storageTails.get(storage) === tail) storageTails.delete(storage); });
    return result;
}
function parseReceipts(raw: unknown): Receipt[] {
    if (raw === undefined) return [];
    const r = object(raw);
    if (r.v !== 1) return invalid();
    const seen = new Set<string>();
    return list(r.receipts, RECEIPT_LIMIT).map(value => {
        const row = list(value, 4);
        if (row.length !== 4) return invalid();
        const receipt: Receipt = [snowflake(row[0]), project(row[1]), text(row[2]), text(row[3])];
        const key = JSON.stringify(receipt);
        if (seen.has(key)) return invalid();
        seen.add(key);
        return receipt;
    });
}

/** Independent engine: no network, Discord observation, Telegram writes or audio implementation.
 * Parent owns lifecycle and must update current() before delivering invalidation events.
 * Receipts are at-most-once attempts, including play=false/rejection or stop during persistence.
 * There is no safe contractual expiry for opaque IDs: at 10,000 receipts fail closed, never evict.
 */
export function createReminderController(options: ReminderOptions): ReminderController {
    const accountId = snowflake(options.accountId), allowed = projects(options.projects);
    const clock = options.clock ?? {
        now: () => performance.now(),
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    let active = false;
    let generation = 0;
    let currentCycle = 0;
    let identity = "";
    let timer: unknown;
    let pending = false;
    let worker: Promise<void> | undefined;
    let notBefore = 0;
    let snapshot: PanelAssignedSnapshot | undefined;
    let receivedAt = 0;
    let requestAt = 0;
    let lastServerTime = -Infinity;
    let lastCheckedAt = -Infinity;
    let observedServerTime = -Infinity;
    let observedAt = 0;
    let receipts = new Set<string>();

    function notify(state: ReminderState) {
        // UI callbacks are observational; exceptions cannot restart delivery or undo a receipt.
        try { options.onState?.(state); } catch { /* isolated UI */ }
    }
    function context(): string {
        try {
            const c = options.current();
            if (!c || c.enabled !== true || snowflake(c.accountId) !== accountId) return "";
            const ps = projects(c.projects);
            if (ps.length !== allowed.length || ps.some(p => !allowed.includes(p))) return "";
            return JSON.stringify([accountId, [...ps].sort(), text(c.sessionId), text(c.permissionsRevision)]);
        } catch { return ""; }
    }
    function cancelTimer() {
        if (timer !== undefined) clock.clearTimeout(timer);
        timer = undefined;
    }
    function stop(reason = "stop") {
        if (active) trace("stop", { cycle: currentCycle, generation, reason });
        active = false;
        generation++;
        pending = false;
        snapshot = undefined;
        cancelTimer();
        notify({ status: "stopped" });
    }
    function valid(g: number): boolean {
        if (!active || generation !== g) return false;
        if (context() !== identity) { stop("context_invalid"); return false; }
        return true;
    }
    function fresh(s: PanelAssignedSnapshot): boolean {
        const now = clock.now();
        const elapsed = now - requestAt;
        // Count the entire request duration conservatively; no local UTC clock comparison.
        // Re-reading a cached serverTime must not reset the age of an old checkedAt.
        const serverNow = Math.max(s.serverTime + elapsed, observedServerTime + now - observedAt);
        return Number.isFinite(elapsed) && elapsed >= 0 && serverNow - s.checkedAt <= MAX_AGE_MS;
    }
    function key(ticket: PanelAssignedTicket): string {
        return JSON.stringify([accountId, ticket.project, ticket.ticketId, ticket.reminderId]);
    }
    function pollDelay(): number {
        const n = (options.random ?? Math.random)();
        return 50_000 + 20_000 * (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5);
    }
    function schedule() {
        cancelTimer();
        if (!valid(generation)) return;
        const now = clock.now();
        let delay = pollDelay();
        if (snapshot?.discordEnabled && fresh(snapshot)) {
            const serverNow = snapshot.serverTime + Math.max(0, now - receivedAt);
            for (const ticket of snapshot.tickets) {
                if (ticket.state !== "waiting_support" || ticket.reminderAt === null || receipts.has(key(ticket))) continue;
                const untilDue = ticket.reminderAt - serverNow;
                delay = Math.min(delay, untilDue <= 0 ? OVERDUE_RETRY_MS : Math.max(1, untilDue));
            }
        }
        delay = Math.max(delay, notBefore - now);
        // Long Retry-After values are revisited in chunks to avoid platform timeout overflow.
        timer = clock.setTimeout(() => { timer = undefined; void refresh(); }, Math.min(delay, 2_147_483_647));
    }

    async function run(g: number) {
        const cycle = ++diagnosticCycle;
        currentCycle = cycle;
        let phase = "snapshot_read";
        snapshot = undefined;
        notify({ status: "refreshing" });
        if (!valid(g)) return;
        requestAt = clock.now();
        trace("refresh", { cycle, generation: g, phase });
        try {
            const raw = await options.get();
            if (!valid(g)) return;
            receivedAt = clock.now();
            phase = "snapshot_validate";
            // Counts describe the received (not yet accepted) response. Never
            // publish assignee/account IDs, revision text or a raw ticket object.
            if (diagnosticJournal.active && raw && typeof raw === "object" && !Array.isArray(raw)) {
                const r = raw as Record<string, unknown>;
                const rows = Array.isArray(r.tickets) ? r.tickets.slice(0, 4000) : [];
                let ownCount = 0, otherCount = 0, tracedCount = 0;
                for (const row of rows) {
                    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
                    if (row.assigneeAccountId === accountId) ownCount++;
                    else if (typeof row.assigneeAccountId === "string") {
                        otherCount++;
                        if (tracedCount++ < 20) trace("ticket", { cycle, phase, ticketId: row.ticketId,
                            channelId: row.channelId, guildId: row.guildId, project: row.project,
                            ownAssignee: false, reason: "foreign_assignment", eligible: false });
                    }
                }
                trace("snapshot", { cycle, phase, snapshotCount: rows.length, ownCount, otherCount,
                    accountMatches: r.accountId === accountId, snapshotRevision: r.revision });
            }
            const s = parseAssignedSnapshot(raw, accountId, allowed);
            if (!fresh(s)) return invalid("stale_snapshot");
            if (s.serverTime < lastServerTime || s.checkedAt < lastCheckedAt) return invalid("snapshot_regressed");
            lastServerTime = s.serverTime;
            lastCheckedAt = s.checkedAt;
            observedServerTime = Math.max(s.serverTime + receivedAt - requestAt, observedServerTime + receivedAt - observedAt);
            observedAt = receivedAt;
            snapshot = s;
            trace("snapshot", { cycle, phase: "complete", snapshotCount: s.tickets.length, ownCount: s.tickets.length,
                otherCount: 0, fresh: true, enabled: s.discordEnabled, serverTime: s.serverTime, checkedAt: s.checkedAt,
                ageMs: s.serverTime + receivedAt - requestAt - s.checkedAt, snapshotRevision: s.revision });
            if (!s.discordEnabled) {
                trace("skip", { cycle, reason: "settings_disabled" });
                notify({ status: "ready" }); return;
            }

            phase = "receipt_read";
            const claimed = await withStorage(options.storage, async () => {
                if (!valid(g) || !fresh(s)) return undefined;
                const saved = parseReceipts(await options.storage.get(RECEIPT_KEY));
                if (!valid(g) || !fresh(s)) return undefined;
                receipts = new Set(saved.map(row => JSON.stringify(row)));
                const serverNow = s.serverTime + (clock.now() - receivedAt);
                phase = "selection";
                let ticket: PanelAssignedTicket | undefined, eligibleCount = 0;
                for (let index = 0; index < s.tickets.length; index++) {
                    const t = s.tickets[index];
                    const reason = t.state !== "waiting_support" ? "waiting_player"
                        : t.reminderAt === null || t.reminderAt > serverNow ? "not_due"
                            : receipts.has(key(t)) ? "receipt_duplicate" : "eligible";
                    if (reason === "eligible") { eligibleCount++; ticket ??= t; }
                    if (index < 20 && diagnosticJournal.active) trace("ticket", { cycle, ...ticketTrace(t), ownAssignee: true,
                        eligible: reason === "eligible", reason, serverNow,
                        dueInMs: t.reminderAt === null ? undefined : t.reminderAt - serverNow });
                }
                trace("selection", { cycle, eligibleCount, snapshotCount: s.tickets.length, receiptCount: receipts.size,
                    tracedCount: Math.min(s.tickets.length, 20), reason: ticket ? "eligible" : s.tickets.length ? "no_eligible_ticket" : "empty_snapshot" });
                if (!ticket) return undefined;
                // No expiry is promised by the contract, even when tickets leave a snapshot.
                if (saved.length >= RECEIPT_LIMIT) return invalid("receipt_limit");
                trace("chosen", { cycle, ...ticketTrace(ticket), ownAssignee: true, eligible: true, serverNow });
                const receipt: Receipt = [accountId, ticket.project, ticket.ticketId, ticket.reminderId!];
                phase = "receipt_write";
                await options.storage.set(RECEIPT_KEY, { v: 1, receipts: [...saved, receipt] });
                trace("receipt", { cycle, ...ticketTrace(ticket), reason: "receipt_saved" });
                if (!valid(g) || !fresh(s)) return undefined;
                receipts.add(JSON.stringify(receipt));
                return ticket;
            });
            if (!valid(g)) return;
            if (!fresh(s)) return invalid("stale_snapshot");
            if (claimed) {
                phase = "playback";
                // Log only guard transitions; audio may call this several times.
                let previousGuard: boolean | undefined;
                const stillValid = () => {
                    const ok = valid(g) && snapshot === s && s.discordEnabled && fresh(s);
                    if (ok !== previousGuard) {
                        previousGuard = ok;
                        trace("guard", { cycle, ...ticketTrace(claimed), currentGuard: ok,
                            reason: ok ? "guard_valid" : generation !== g ? "generation_changed"
                                : snapshot !== s ? "snapshot_changed" : !s.discordEnabled ? "settings_disabled"
                                    : !fresh(s) ? "stale_snapshot" : "context_invalid" });
                    }
                    return ok;
                };
                let played = false;
                const playbackTicket: ReminderPlaybackTicket = { ticketId: claimed.ticketId, channelId: claimed.channelId,
                    guildId: claimed.guildId, project: claimed.project, waitingCycleId: claimed.waitingCycleId,
                    reminderId: claimed.reminderId, cycle };
                try { if (stillValid()) played = await options.play(stillValid, playbackTicket) === true; } catch { /* attempt stays consumed */ }
                trace("play", { cycle, ...ticketTrace(claimed), played, currentGuard: stillValid(), outcome: played ? "success" : "failure" });
                if (!stillValid()) return;
                notify({ status: "ready", ticket: { ...claimed }, played });
            } else notify({ status: "ready" });
        } catch (error) {
            trace("failure", { cycle, phase, reason: error instanceof ReminderDataError ? error.reason : "unknown_failure" });
            // Even an invalidated request's Retry-After applies to the shared endpoint.
            let retry = 0;
            try {
                const ms = object(error).retryAfterMs;
                if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) retry = ms;
            } catch { /* no transport delay */ }
            // Invalidation must not turn a failed in-flight read into an immediate retry.
            notBefore = Math.max(notBefore, clock.now() + Math.max(retry, pollDelay()));
            if (!valid(g)) return;
            snapshot = undefined;
            notify({ status: "unavailable" });
        }
    }

    function refresh(): Promise<void> {
        if (!valid(generation)) return Promise.resolve();
        cancelTimer();
        pending = true;
        if (worker) return worker;
        // Defer entry so reentrant UI callbacks see the already assigned worker.
        worker = Promise.resolve().then(async () => {
            while (pending && valid(generation)) {
                pending = false;
                if (clock.now() < notBefore) break;
                await run(generation);
            }
        }).finally(() => {
            worker = undefined;
            if (active) schedule();
        });
        return worker;
    }
    return {
        start() {
            if (active && context() === identity) return;
            stop();
            identity = context();
            if (!identity) return;
            active = true;
            lastServerTime = lastCheckedAt = -Infinity;
            observedServerTime = -Infinity;
            receipts = new Set();
            void refresh();
        },
        stop,
        invalidate(event = "tickets.changed") {
            if (["permissions.changed", "session.revoked", "token.expired"].includes(event)) { stop(event); return; }
            if (!["tickets.changed", "tickets.unavailable", "resync.required"].includes(event) || !active) return;
            trace("invalidate", { cycle: currentCycle, generation, reason: event });
            generation++;
            snapshot = undefined;
            cancelTimer();
            if (event === "tickets.unavailable") notify({ status: "unavailable" });
            void refresh();
        },
        refresh,
    };
}
