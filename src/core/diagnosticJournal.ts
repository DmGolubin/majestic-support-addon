// SPDX-License-Identifier: GPL-3.0-or-later
// Deliberately independent of Discord, the network and credentials. Only explicitly
// allowlisted metadata reaches persistence; neither bodies nor error messages do.
export const DIAGNOSTIC_LIMIT = 2000;
export const DIAGNOSTIC_TTL = 24 * 60 * 60 * 1000;
const MAX_BYTES = 512 * 1024;
const WORDS = new Set(("idle connecting pending loading ready offline error live retrying " +
    "GET POST PATCH DELETE start stop success failure cancelled aborted timeout request_timeout " +
    "network_error transport_error invalid_response response_too_large redirect_not_allowed " +
    "authorization_pending slow_down access_denied expired_token invalid_request invalid_client " +
    "invalid_grant invalid_scope invalid_token session_revoked plugin_disabled unauthorized forbidden " +
    "insufficient_scope rate_limited not_found version_required version_conflict idempotency_conflict " +
    "name_exists ticket_state_unavailable service_unavailable http_error not_authenticated " +
    "refresh_uncertain connection_mismatch account_mismatch upgrade_required stale_library vault_error invalid_options invalid_path unknown " +
    "user discord_logout account_changed permissions.changed token.expired snapshot.updated session.revoked library.changed resync.required tickets.changed tickets.unavailable " +
    "refresh expired rejected_access restore login logout cancel reload resume pagehide online offline " +
    "visible hidden personal general tickets all fav recent confirm fields bind mj ro off " +
    "storage_unavailable no_saved_session invalid_saved_session no_vault startup runtime recording enabled disabled cleared ui panel sync " +
    "window management insert insertText favorite bind compose input storage.get storage.set settings lifecycle cleanup session heartbeat key channel cancel error dialog-open dialog-close dialog-supersede insert-start compose-add guard inline inline-accept search geometry longtask keydown keyup wheel resize").split(/\s+/));
const NUMBERS = new Set(("requestId status durationMs retryAfterMs count items queryLength composeCount " +
    "width height winW previewW avail tipW selIdx ms total storeLoad mount failures attempt " +
    "elapsedMs templates personal folders favoriteCount recentCount bindCount volume " +
    "resultCount matched inserted requested steps generation expiresIn").split(/\s+/));
const BOOLS = new Set(("on verbose ready persistent online visible windowOpen management previewOpen " +
    "peek success hasEditor hadWindow hadDialog serverChanged cancelled debug debugVerbose " +
    "soundEnabled enabled dirty busy active restored authenticated ok noGreeting already").split(/\s+/));
const STRINGS = new Set(["phase", "previous", "sync", "method", "code", "reason", "outcome", "source", "view", "mode", "dialog", "event", "where", "via"]);
export function diagnosticRoute(path: string): string {
    if (["/me", "/snapshot", "/oauth/token", "/oauth/device_authorization", "/oauth/revoke", "/device-requests/cancel", "/sync/events", "/tickets/assigned", "/notification-settings", "/personal", "/folders", "/trash", "/preferences"].includes(path)) return path;
    const m = /^\/(personal|folders|trash)\/[^/?#]+(?:\/(restore))?$/.exec(path);
    return m ? `/${m[1]}/:id${m[2] ? "/restore" : ""}` : "unknown";
}
export function diagnosticData(input: Record<string, unknown>): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(input).slice(0, 80)) {
        if (NUMBERS.has(key) && typeof value === "number" && Number.isFinite(value)) out[key] = Math.round(Math.max(-1e9, Math.min(1e9, value)) * 100) / 100;
        else if (BOOLS.has(key) && typeof value === "boolean") out[key] = value;
        else if (STRINGS.has(key) && typeof value === "string") out[key] = WORDS.has(value) ? value : "unknown";
        else if (key === "route" && typeof value === "string") out[key] = diagnosticRoute(value);
    }
    return out;
}
type Entry = { seq: number; time: number; event: string; data: ReturnType<typeof diagnosticData>; };
export interface JournalStorage { read(): string | null; write(value: string): void; }
const EVENT = /^(?:request|http|auth|stream|panel|runtime|user|ui|debug|recorder|environment|settings)(?:\.[a-z_]{1,24})?$/;
export class DiagnosticJournal {
    private entries: Entry[] = [];
    private sequence = 0;
    private dropped = 0;
    private until = 0;
    private running = false;
    private storage?: JournalStorage;
    private timer?: ReturnType<typeof setTimeout>;
    private expiry?: ReturnType<typeof setTimeout>;
    storageFailed = false;
    constructor(private now: () => number = Date.now) {}
    get active() { return this.running && this.until > this.now(); }
    get size() { return this.entries.length; }
    get expiresAt() { return this.until; }
    start(storage: JournalStorage) {
        if (this.running) return;
        this.storage = storage;
        this.running = true;
        try {
            const raw = storage.read();
            if (raw && raw.length <= MAX_BYTES) {
                const saved = JSON.parse(raw);
                if (saved.schema === 1 && Array.isArray(saved.events)) {
                    this.entries = saved.events.slice(-DIAGNOSTIC_LIMIT).filter((e: Entry) => e && Number.isSafeInteger(e.seq) && Number.isSafeInteger(e.time)
                        && e.time <= this.now() && e.time >= this.now() - DIAGNOSTIC_TTL && typeof e.event === "string" && EVENT.test(e.event)
                        && e.data && typeof e.data === "object" && !Array.isArray(e.data))
                        .map((e: Entry) => ({ seq: e.seq, time: e.time, event: e.event, data: diagnosticData(e.data) }));
                    this.sequence = Math.max(0, ...this.entries.map(e => e.seq));
                    this.dropped = Number.isSafeInteger(saved.dropped) && saved.dropped >= 0 ? saved.dropped : 0;
                    this.until = Number.isSafeInteger(saved.until) && saved.until <= this.now() + DIAGNOSTIC_TTL ? saved.until : 0;
                }
            }
        } catch { this.storageFailed = true; }
        this.armExpiry();
        this.record("runtime.start", { restored: this.active }, true);
    }
    enable(on: boolean) {
        if (on) { this.until = this.now() + DIAGNOSTIC_TTL; this.record("recorder.enabled", {}, true); }
        else { this.record("recorder.disabled", {}, true); this.until = 0; }
        this.armExpiry(); this.flush();
    }
    private armExpiry() {
        clearTimeout(this.expiry); this.expiry = undefined;
        if (this.active) this.expiry = setTimeout(() => { this.until = 0; this.expiry = undefined; this.flush(); }, Math.max(1, this.until - this.now()));
    }
    record(event: string, data: Record<string, unknown> = {}, urgent = false): number {
        if (!this.active) return 0;
        const entry = { seq: ++this.sequence, time: this.now(), event: EVENT.test(event) ? event : "debug", data: diagnosticData(data) };
        this.entries.push(entry);
        while (this.entries.length > DIAGNOSTIC_LIMIT) { this.entries.shift(); this.dropped++; }
        if (urgent) this.flush();
        else this.timer ??= setTimeout(() => { this.timer = undefined; this.flush(); }, 5000);
        return entry.seq;
    }
    private prune() {
        this.entries = this.entries.filter(e => e.time >= this.now() - DIAGNOSTIC_TTL);
    }
    snapshot() {
        this.prune();
        return { schema: 1, until: this.until, dropped: this.dropped, events: this.entries.map(e => ({ ...e, data: { ...e.data } })) };
    }
    flush() {
        clearTimeout(this.timer); this.timer = undefined;
        if (!this.storage) return;
        this.prune();
        let payload = JSON.stringify(this.snapshot());
        while (payload.length > MAX_BYTES && this.entries.length) {
            const removed = Math.min(100, this.entries.length);
            this.entries.splice(0, removed); this.dropped += removed;
            payload = JSON.stringify(this.snapshot());
        }
        try { this.storage.write(payload); this.storageFailed = false; }
        catch { this.storageFailed = true; } // Recording must never break login, requests or cleanup.
    }
    clear() { this.entries = []; this.dropped = 0; this.flush(); }
    stop() {
        this.record("runtime.stop", {}, true); this.flush();
        this.running = false; clearTimeout(this.expiry); this.expiry = undefined;
        // Keep the stateless persistence adapter so the host's disabled-plugin
        // settings can still clear an old report. No timers or listeners remain.
    }
}
export const diagnosticJournal = new DiagnosticJournal();
