// SPDX-License-Identifier: GPL-3.0-or-later
// Deliberately independent of Discord, the network and credentials. Only explicitly
// allowlisted metadata reaches persistence; neither bodies nor error messages do.
export const DIAGNOSTIC_LIMIT = 2000;
export const DIAGNOSTIC_TTL = 24 * 60 * 60 * 1000;
export const DIAGNOSTIC_CAMPAIGN_DURATION = 4 * DIAGNOSTIC_TTL;
const MAX_BYTES = 512 * 1024;
const WORDS = new Set(("idle connecting pending loading ready offline error live retrying " +
    "GET POST PATCH DELETE start stop success failure cancelled aborted timeout request_timeout " +
    "network_error transport_error invalid_response response_too_large redirect_not_allowed " +
    "authorization_pending slow_down access_denied expired_token invalid_request invalid_client " +
    "invalid_grant invalid_scope invalid_token session_revoked plugin_disabled unauthorized forbidden " +
    "insufficient_scope rate_limited not_found version_required version_conflict idempotency_conflict " +
    "name_exists ticket_state_unavailable service_unavailable http_error not_authenticated " +
    "refresh_uncertain connection_mismatch account_mismatch upgrade_required stale_library vault_error invalid_options invalid_path unknown " +
    "reauthentication_required callback_failed logout_in_progress retain_session terminate_session side compact " +
    "ticket test reminder custom sound_disabled sound_channel sound_guild sound_invalid sound_history sound_duplicate " +
    "sound_muted sound_visible sound_cooldown sound_stopped sound_suspended sound_unavailable sound_save sound_decode " +
    "sound_duration sound_size sound_format sound_read sound_not_ready sound_loading sound_cancelled sound_playback " +
    "headers body decode validation complete dns_failure connection_reset connection_refused connection_closed tls_error host_timeout host_aborted host_network_error unknown_failure " +
    "majestic russia-online waiting_support waiting_player eligible not_due receipt_duplicate receipt_saved receipt_limit " +
    "empty_snapshot foreign_assignment snapshot_account stale_snapshot snapshot_regressed settings_disabled context_invalid generation_changed snapshot_changed " +
    "receipt_read receipt_write snapshot_read snapshot_validate selection playback guard_valid guard_invalid no_eligible_ticket trace_limited " +
    "global channel preview absent running suspended closed interrupted ended stopped " +
    "user discord_logout account_changed permissions.changed token.expired snapshot.updated session.revoked library.changed resync.required tickets.changed tickets.unavailable " +
    "refresh expired rejected_access restore login logout cancel reload resume pagehide online offline " +
    "visible hidden personal general tickets all fav recent confirm fields bind mj ro off " +
    "storage_unavailable no_saved_session invalid_saved_session no_vault startup runtime recording enabled disabled cleared ui panel sync " +
    "window management insert insertText favorite bind compose input storage.get storage.set settings lifecycle cleanup session heartbeat key channel cancel error dialog-open dialog-close dialog-supersede insert-start compose-add guard inline inline-accept search geometry longtask keydown keyup wheel resize").split(/\s+/));
const NUMBERS = new Set(("requestId status durationMs retryAfterMs count items queryLength composeCount " +
    "width height winW previewW avail tipW selIdx ms total storeLoad mount failures attempt " +
    "elapsedMs templates personal folders favoriteCount recentCount bindCount volume " +
    "resultCount matched inserted requested steps generation expiresIn totalMs windowMs keysMs inlineMs renderMs searchMs debugMs maxMs pluginMs " +
    "bytesReceived cycle snapshotCount ownCount otherCount eligibleCount receiptCount tracedCount thresholdMs dueInMs ageMs").split(/\s+/));
const TIMES = new Set(["serverTime", "checkedAt", "serverNow", "waitingSince", "reminderAt", "staleUntil"]);
const BOOLS = new Set(("on verbose ready persistent online visible windowOpen management previewOpen " +
    "peek success hasEditor hadWindow hadDialog serverChanged cancelled debug debugVerbose " +
    "soundEnabled enabled dirty busy active restored authenticated ok noGreeting already ownAssignee accountMatches fresh due eligible currentGuard played stale").split(/\s+/));
const STRINGS = new Set(["phase", "previous", "sync", "method", "code", "reason", "outcome", "source", "view", "mode", "dialog", "event", "where", "via", "project", "state", "configSource", "audioState"]);
// Opaque correlation only, not an authentication or cryptographic identifier.
// Never retain arbitrary identifier text; native re-sanitization is idempotent.
function opaqueDiagnosticId(value: string): string {
    if (/^h:[a-f0-9]{16}$/.test(value)) return value;
    let a = 0x811c9dc5, b = 0x9e3779b9;
    for (let i = 0; i < value.length; i++) {
        a = Math.imul(a ^ value.charCodeAt(i), 0x01000193);
        b = Math.imul(b ^ value.charCodeAt(i), 0x85ebca6b);
    }
    return `h:${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}
const SNOWFLAKE_FIELDS = new Set(["channelId", "guildId"]);
const OPAQUE_FIELDS = new Set(["waitingCycleId", "reminderId", "snapshotRevision"]);
export function diagnosticRoute(path: string): string {
    if (["/me", "/snapshot", "/oauth/token", "/oauth/device_authorization", "/oauth/revoke", "/device-requests/cancel", "/sync/events", "/tickets/assigned", "/notification-settings", "/personal", "/folders", "/trash", "/preferences"].includes(path)) return path;
    const m = /^\/(personal|folders|trash)\/[^/?#]+(?:\/(restore))?$/.exec(path);
    return m ? `/${m[1]}/:id${m[2] ? "/restore" : ""}` : "unknown";
}
export function diagnosticData(input: Record<string, unknown>): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(input).slice(0, 80)) {
        if (NUMBERS.has(key) && typeof value === "number" && Number.isFinite(value)) out[key] = Math.round(Math.max(-1e9, Math.min(1e9, value)) * 100) / 100;
        else if (TIMES.has(key) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000) out[key] = value;
        else if (BOOLS.has(key) && typeof value === "boolean") out[key] = value;
        else if (STRINGS.has(key) && typeof value === "string") out[key] = WORDS.has(value) ? value : "unknown";
        else if (key === "route" && typeof value === "string") out[key] = diagnosticRoute(value);
        else if (SNOWFLAKE_FIELDS.has(key) && typeof value === "string" && /^[1-9]\d{16,19}$/.test(value)
            && BigInt(value) <= 18446744073709551615n) out[key] = value;
        else if ((key === "ticketId" || OPAQUE_FIELDS.has(key)) && typeof value === "string"
            && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)) {
            out[key] = key === "ticketId" && /^(?:[0-9]{1,20}|[a-z]{1,16}:[0-9]{1,20}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)
                ? value : opaqueDiagnosticId(value);
        }
    }
    return out;
}
type Entry = { seq: number; time: number; event: string; data: ReturnType<typeof diagnosticData>; };
export interface JournalStorage { read(): string | null; write(value: string): void; }
export interface JournalStartOptions { campaign?: string; durationMs?: number; continuous?: boolean; }
export function diagnosticOptOut(saved: Record<string, any>): boolean {
    if (typeof saved.optedOut === "boolean") return saved.optedOut;
    if (saved.continuous === true) return saved.enabled !== true;
    const toggles = (Array.isArray(saved.events) ? saved.events : [])
        .filter((e: any) => e && Number.isSafeInteger(e.seq) && ["recorder.enabled", "recorder.disabled"].includes(e.event));
    const last = toggles.reduce((a: any, b: any) => !a || b.seq > a.seq ? b : a, null);
    if (last) return last.event === "recorder.disabled";
    // Old schema had no explicit preference. An early until=0 save proves opt-out;
    // normal four-day expiry must not disable the new ongoing logging policy.
    return saved.until === 0 && Number.isSafeInteger(saved.campaignUntil) && Number.isSafeInteger(saved.savedAt)
        && saved.savedAt > 0 && saved.savedAt < saved.campaignUntil;
}
function newSessionId() {
    const crypto = (globalThis as { crypto?: { randomUUID?(): string } }).crypto;
    return crypto?.randomUUID?.().replace(/-/g, "")
        ?? Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}
// Campaign IDs are static application configuration, never user input or credentials.
const CAMPAIGN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EVENT = /^(?:request|http|auth|stream|panel|runtime|user|ui|debug|recorder|environment|settings)(?:\.[a-z_]{1,24})?$/;
export class DiagnosticJournal {
    private entries: Entry[] = [];
    private sequence = 0;
    private dropped = 0;
    private until = 0;
    private campaign: string | null = null;
    private campaignUntil = 0;
    private savedAt = 0;
    private retention = DIAGNOSTIC_TTL;
    private continuous = false;
    private enabled = false;
    private optedOut = false;
    private sessionId = "";
    private clearGeneration = 0;
    private unflushed = 0;
    private running = false;
    private storage?: JournalStorage;
    private timer?: ReturnType<typeof setTimeout>;
    private expiry?: ReturnType<typeof setTimeout>;
    storageFailed = false;
    constructor(private now: () => number = Date.now) {}
    get active() { return this.running && (this.continuous ? this.enabled && !this.optedOut : this.until > this.now()); }
    get size() { return this.entries.length; }
    get expiresAt() { return this.until; }
    get campaignEndsAt() { return this.campaignUntil; }
    start(storage: JournalStorage, options: JournalStartOptions = {}) {
        if (this.running) return;
        const campaign = typeof options.campaign === "string" && CAMPAIGN.test(options.campaign) ? options.campaign : null;
        const duration = options.durationMs === undefined ? DIAGNOSTIC_CAMPAIGN_DURATION
            : Number.isSafeInteger(options.durationMs) && options.durationMs > 0
                ? Math.min(options.durationMs, DIAGNOSTIC_CAMPAIGN_DURATION) : 0;
        const memory = this.campaign || this.continuous ? this.snapshot() : null;
        this.continuous = options.continuous === true;
        this.retention = campaign ? DIAGNOSTIC_CAMPAIGN_DURATION : DIAGNOSTIC_TTL;
        this.storage = storage;
        this.running = true;
        let saved: any = null, readable = true;
        try {
            const raw = storage.read();
            if (raw !== null) {
                if (typeof raw !== "string" || raw.length > MAX_BYTES) throw Error("Invalid journal");
                saved = JSON.parse(raw);
                if (!saved || saved.schema !== 1 || typeof saved !== "object" || Array.isArray(saved)) throw Error("Invalid journal");
            }
        } catch { saved = null; readable = false; this.storageFailed = true; }
        // Preserve a consumed campaign in this instance even if a failed write
        // left storage empty. Across fresh instances an unreadable store fails closed.
        const diskSavedAt = Number.isSafeInteger(saved?.savedAt) ? saved.savedAt : 0;
        if (memory && (!saved || memory.savedAt > diskSavedAt
            || (memory.savedAt === diskSavedAt && (memory.continuous ? memory.optedOut : memory.until === 0)))) saved = memory;
        this.until = 0;
        if (saved) {
            this.entries = (Array.isArray(saved.events) ? saved.events : []).slice(-DIAGNOSTIC_LIMIT)
                .filter((e: Entry) => e && Number.isSafeInteger(e.seq) && e.seq > 0 && Number.isSafeInteger(e.time)
                    && e.time <= this.now() && typeof e.event === "string" && EVENT.test(e.event)
                    && e.data && typeof e.data === "object" && !Array.isArray(e.data))
                .map((e: Entry) => ({ seq: e.seq, time: e.time, event: e.event, data: diagnosticData(e.data) }));
            this.sequence = Math.max(0, ...this.entries.map(e => e.seq));
            if (Number.isSafeInteger(saved.sequence) && saved.sequence >= this.sequence) this.sequence = saved.sequence;
            this.dropped = Number.isSafeInteger(saved.dropped) && saved.dropped >= 0 ? saved.dropped : 0;
            this.savedAt = Number.isSafeInteger(saved.savedAt) && saved.savedAt >= 0 ? saved.savedAt : 0;
        }
        this.sessionId = typeof saved?.sessionId === "string" && /^[a-f0-9]{32}$/.test(saved.sessionId)
            ? saved.sessionId : this.sessionId || newSessionId();
        this.clearGeneration = Number.isSafeInteger(saved?.clearGeneration) && saved.clearGeneration >= 0 ? saved.clearGeneration : this.clearGeneration;
        this.optedOut = saved ? diagnosticOptOut(saved) : false;
        const hasCampaign = saved && !(saved.campaign === null && saved.campaignUntil === 0)
            && ("campaign" in saved || "campaignUntil" in saved);
        if (this.continuous) {
            this.campaign = campaign; this.campaignUntil = 0;
            this.optedOut ||= !readable;
            this.enabled = !this.optedOut;
        } else if (hasCampaign) {
            const validId = typeof saved.campaign === "string" && CAMPAIGN.test(saved.campaign);
            // When opted in, only the configured ID is exported, never arbitrary
            // text from the stored campaign field. A changed ID does not reset time.
            this.campaign = campaign ?? (memory && memory.campaign === saved.campaign ? memory.campaign : "unknown");
            this.campaignUntil = Number.isSafeInteger(saved.campaignUntil) && saved.campaignUntil >= 0
                && saved.campaignUntil <= this.now() + DIAGNOSTIC_CAMPAIGN_DURATION ? saved.campaignUntil : 0;
            if (readable && validId && (!campaign || saved.campaign === campaign)
                && Number.isSafeInteger(saved.until) && saved.until > this.now()
                && saved.until <= this.campaignUntil && saved.until <= this.now() + this.retention) this.until = saved.until;
        } else if (campaign) {
            this.campaign = campaign;
            // Missing data and valid legacy schema-1 data migrate once. Corrupt,
            // inaccessible or partial campaign state must not silently renew consent.
            this.campaignUntil = readable && (!saved || Array.isArray(saved.events)) && duration > 0 ? this.now() + duration : 0;
            this.until = this.campaignUntil;
        } else {
            this.campaign = null; this.campaignUntil = 0;
            if (readable && Number.isSafeInteger(saved?.until) && saved.until > this.now()
                && saved.until <= this.now() + DIAGNOSTIC_TTL) this.until = saved.until;
        }
        this.prune();
        this.armExpiry();
        if (this.active) this.record("runtime.start", { restored: !!saved }, true);
        else if (this.continuous || this.campaign || (saved?.until > 0 && saved.until <= this.now())) this.flush();
    }
    enable(on: boolean) {
        if (this.continuous) {
            if (!on) this.record("recorder.disabled");
            this.optedOut = !on;
            this.enabled = on;
            if (on) this.record("recorder.enabled");
            this.armExpiry(); this.flush(); return;
        }
        this.optedOut = !on;
        if (on) {
            this.until = this.campaign ? (this.campaignUntil > this.now() ? Math.min(this.campaignUntil, this.now() + this.retention) : 0) : this.now() + DIAGNOSTIC_TTL;
            this.record("recorder.enabled");
        } else {
            this.record("recorder.disabled"); this.until = 0;
        }
        this.armExpiry(); this.flush();
    }
    private armExpiry() {
        clearTimeout(this.expiry); this.expiry = undefined;
        if (!this.continuous && this.active) this.expiry = setTimeout(() => {
            this.expiry = undefined;
            if (this.until > this.now()) { this.armExpiry(); return; }
            this.until = 0; this.flush();
        }, Math.max(1, this.until - this.now()));
    }
    record(event: string, data: Record<string, unknown> = {}, urgent = false, passive = false): number {
        if (!this.active) return 0;
        if (this.continuous && event === "debug" && ["key", "keydown", "keyup", "input", "search", "wheel"].includes(String(data.event))) return 0;
        const entry = { seq: ++this.sequence, time: this.now(), event: EVENT.test(event) ? event : "debug", data: diagnosticData(data) };
        this.entries.push(entry);
        while (this.entries.length > DIAGNOSTIC_LIMIT) { this.entries.shift(); this.dropped++; }
        this.unflushed++;
        // Observer telemetry can describe this journal's own persistence cost.
        // Keep it in sequence/history, but let ordinary events, export or stop
        // flush it instead of creating an idle save -> longtask -> save loop.
        if (passive && !urgent) return entry.seq;
        if (urgent || (this.continuous && this.unflushed >= 100)) this.flush();
        else this.timer ??= setTimeout(() => { this.timer = undefined; this.flush(); }, this.continuous ? 1000 : 5000);
        return entry.seq;
    }
    private prune() {
        if (this.continuous) return;
        // Campaign evidence is an exportable report, not a rolling cache. Anchor
        // its bounded four-day window to the persisted deadline even after expiry.
        // In particular, opening the client days later must not erase the report.
        const campaignEnd = this.campaign && this.campaignUntil > 0 ? this.campaignUntil : null;
        const end = campaignEnd === null ? this.now() : Math.min(this.now(), campaignEnd);
        const start = campaignEnd === null ? this.now() - this.retention : campaignEnd - DIAGNOSTIC_CAMPAIGN_DURATION;
        this.entries = this.entries.filter(e => e.time >= start && e.time <= end);
    }
    snapshot() {
        this.prune();
        return { schema: 1, until: this.until, campaign: this.campaign, campaignUntil: this.campaignUntil,
            continuous: this.continuous, enabled: this.continuous ? this.enabled : this.until > this.now(), optedOut: this.optedOut,
            sessionId: this.sessionId, sequence: this.sequence, clearGeneration: this.clearGeneration,
            savedAt: this.savedAt, dropped: this.dropped, events: this.entries.map(e => ({ ...e, data: { ...e.data } })) };
    }
    flush() {
        clearTimeout(this.timer); this.timer = undefined;
        this.unflushed = 0;
        if (!this.storage) return;
        if (this.until > 0 && this.until <= this.now()) {
            this.until = 0; clearTimeout(this.expiry); this.expiry = undefined;
        }
        this.prune();
        this.savedAt = this.now();
        let payload = JSON.stringify(this.snapshot());
        while (payload.length > MAX_BYTES && this.entries.length) {
            const removed = Math.min(100, this.entries.length);
            this.entries.splice(0, removed); this.dropped += removed;
            payload = JSON.stringify(this.snapshot());
        }
        try { this.storage.write(payload); this.storageFailed = false; }
        catch { this.storageFailed = true; } // Recording must never break login, requests or cleanup.
    }
    clear() { this.entries = []; this.dropped = 0; this.clearGeneration++; this.flush(); }
    stop() {
        this.record("runtime.stop", {}, true); this.flush();
        this.running = false; clearTimeout(this.expiry); this.expiry = undefined;
        // Keep the stateless persistence adapter so the host's disabled-plugin
        // settings can still clear an old report. No timers or listeners remain.
    }
}
export const diagnosticJournal = new DiagnosticJournal();
