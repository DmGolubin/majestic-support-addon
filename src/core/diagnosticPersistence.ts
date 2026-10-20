// SPDX-License-Identifier: GPL-3.0-or-later
// Bounded, coalesced local-file persistence. Disk/network failures never escape
// into plugin actions. No timers run while the journal is idle.
import { diagnosticOptOut } from "./diagnosticJournal";
import { DiagnosticBackup } from "./diagnosticBackup";

export const DIAGNOSTIC_QUEUE_LIMIT = 10_000;
const QUEUE_BYTES = 4 * 1024 * 1024;
export interface DiagnosticFileStatus {
    path: string;
    initializing: boolean;
    fileError: boolean;
    localError: boolean;
    lastSavedAt: number;
    deliveryLost: number;
}
export function createDiagnosticPersistence(options: {
    localRead?(): string | null;
    localWrite?(value: string): void;
    backup?: DiagnosticBackup;
    load(): Promise<{ path: string; state: string | null; }>;
    save(report: string): Promise<{ path: string; }>;
    report(state: string): string;
    now?: () => number;
}) {
    const now = options.now ?? Date.now;
    let localError = false, backupControl = "";
    const status: DiagnosticFileStatus = { path: "", initializing: true, fileError: false,
        get localError() { return options.backup?.failed ?? localError; }, lastSavedAt: 0, deliveryLost: 0 };
    let pending: string | null = null, writing = false, finishing = false, retryAt = 0;
    type Saved = { continuous: boolean; sessionId: string; clearGeneration: number; events: { seq: number; [key: string]: unknown }[]; [key: string]: unknown };
    let latest: Saved | null = null, stream = "", seen = 0, dirty = false, historyThrough = 0;
    let historyKnown = false, historyStream = "";
    let queue: Saved["events"] = [];
    const hasWork = () => pending !== null || dirty || queue.length > 0;
    const boundQueue = () => {
        // Bounded independently of the journal ring and the one in-flight batch.
        // Backpressure cannot silently turn an append log into latest-snapshot logging.
        let bytes = queue.reduce((n, e) => n + JSON.stringify(e).length, 0);
        while (queue.length > DIAGNOSTIC_QUEUE_LIMIT || bytes > QUEUE_BYTES) {
            bytes -= JSON.stringify(queue.shift()!).length;
            status.deliveryLost++;
        }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
        if (writing || !hasWork() || timer || now() < retryAt) return;
        if (finishing || queue.length >= 100) { pump(); return; }
        timer = setTimeout(() => { timer = undefined; pump(); }, 1000);
    };
    const pump = () => {
        if (writing || !hasWork() || now() < retryAt) return;
        const batch = latest ? queue.splice(0, 100) : [];
        const batchStream = stream;
        let report: string;
        try {
            report = latest ? options.report(JSON.stringify({ ...latest, events: batch, deliveryLost: status.deliveryLost })) : pending!;
        } catch {
            queue.unshift(...batch); status.fileError = true; retryAt = now() + 30_000; return;
        }
        pending = null; dirty = false; writing = true;
        void Promise.resolve().then(() => options.save(report)).then(result => {
            status.path = result.path; status.fileError = false; status.lastSavedAt = now(); retryAt = 0;
        }).catch(() => {
            status.fileError = true; retryAt = now() + 30_000;
            if (latest) {
                // An explicit clear supersedes earlier batches. Ordinary updates
                // must retain failed deltas; native dedupe makes retries safe.
                if (batchStream === stream) {
                    queue = [...batch, ...queue].sort((a, b) => a.seq - b.seq);
                    boundQueue(); dirty = true;
                }
            } else pending ??= report;
        }).finally(() => {
            writing = false;
            // Drain an existing backlog without adding a second of latency per batch.
            if (latest && hasWork() && now() >= retryAt) pump(); else schedule();
        });
    };
    return {
        status,
        async read() {
            let local: string | null = null, file: string | null = null;
            const localRead = (async () => {
                try { local = options.backup ? await options.backup.read() : options.localRead?.() ?? null; }
                catch { localError = true; }
            })();
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                const loaded = await Promise.race([
                    Promise.resolve().then(() => options.load()),
                    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Diagnostic storage timeout")), 1500); })
                ]);
                status.path = loaded.path; file = loaded.state;
            } catch { status.fileError = true; retryAt = now() + 30_000; }
            finally { clearTimeout(timeout); }
            await localRead;
            status.initializing = false;
            // A failed file write must not revive an older opt-in after reload.
            const stamp = (raw: string | null) => {
                try {
                    if (!raw || raw.length > 512 * 1024) return -1;
                    const data = JSON.parse(raw);
                    if (data.schema !== 1 || !Array.isArray(data.events)) return -1;
                    return Number.isSafeInteger(data.savedAt) && data.savedAt <= now() ? data.savedAt : 0;
                } catch { return -1; }
            };
            const localStamp = stamp(local), fileStamp = stamp(file);
            const localOptOut = localStamp >= 0 && (diagnosticOptOut(JSON.parse(local!))
                || (!JSON.parse(local!).continuous && JSON.parse(local!).until === 0));
            let selected = localStamp > fileStamp || (localStamp === fileStamp && localOptOut)
                ? local : fileStamp >= 0 ? file : local;
            try {
                const data = JSON.parse(selected ?? "null");
                if (data?.continuous) {
                    const native = fileStamp >= 0 ? JSON.parse(file!) : null;
                    const backup = localStamp >= 0 ? JSON.parse(local!) : null;
                    const same = (other: any) => other?.continuous && other.sessionId === data.sessionId
                        && other.clearGeneration === data.clearGeneration;
                    // Restore control state from the newest save, but recover pending
                    // deltas from either copy without reviving an older opt-in.
                    const events = new Map<number, Saved["events"][number]>();
                    for (const source of [native, backup, data]) {
                        if (!same(source)) continue;
                        for (const event of source.events)
                            if (Number.isSafeInteger(event.seq) && event.seq > 0) events.set(event.seq, event);
                        if (Number.isSafeInteger(source.sequence)) data.sequence = Math.max(data.sequence, source.sequence);
                    }
                    data.events = [...events.values()].sort((a, b) => a.seq - b.seq).slice(-2000);
                    historyKnown = same(native) && Number.isSafeInteger(native.deliveryCursor) && native.deliveryCursor >= 0;
                    historyStream = `${data.sessionId}:${data.clearGeneration}`;
                    historyThrough = historyKnown ? native.deliveryCursor : Math.max(0, ...data.events.map((e: { seq: number }) => e.seq));
                    // Only a complete native trace can disprove an old cumulative
                    // warning. A pending cursor tail alone is not evidence of loss.
                    if (same(native) && Number.isSafeInteger(native.deliveryVerifiedThrough)
                        && native.deliveryVerifiedThrough >= data.sequence) data.deliveryLost = 0;
                    selected = JSON.stringify(data);
                    // A union can exceed either individual saved ring. Preserve
                    // opt-out/control metadata instead of making journal.start
                    // reject the entire restore; cursor checks expose lost gaps.
                    while (selected!.length > 512 * 1024 && data.events.length) {
                        data.events.splice(0, 100);
                        selected = JSON.stringify(data);
                    }
                }
                const lost = JSON.parse(selected ?? "null")?.deliveryLost;
                if (Number.isSafeInteger(lost) && lost > 0) status.deliveryLost = lost;
            } catch {}
            return selected;
        },
        write(state: string) {
            let important = false;
            try {
                const data = JSON.parse(state) as Saved;
                const control = JSON.stringify([data.continuous, data.enabled, data.optedOut, data.until, data.clearGeneration]);
                important = control !== backupControl; backupControl = control;
                if (data.continuous && /^[a-f0-9]{32}$/.test(data.sessionId) && Number.isSafeInteger(data.clearGeneration)) {
                    const nextStream = `${data.sessionId}:${data.clearGeneration}`;
                    if (stream !== nextStream) {
                        if (stream || nextStream !== historyStream) { historyThrough = 0; historyKnown = false; }
                        queue = []; seen = 0; stream = nextStream;
                    }
                    const events = data.events.filter(e => Number.isSafeInteger(e.seq) && e.seq > seen).sort((a, b) => a.seq - b.seq);
                    for (const event of events) {
                        if (event.seq <= seen) continue;
                        const deliveredThrough = seen > 0 ? Math.max(seen, historyThrough)
                            : historyKnown ? historyThrough : event.seq - 1;
                        status.deliveryLost += Math.max(0, event.seq - 1 - deliveredThrough);
                        seen = event.seq;
                        // Native-confirmed history need not occupy the retry
                        // queue or be misreported as lost under backpressure.
                        if (!historyKnown || event.seq > historyThrough) queue.push(event);
                    }
                    latest = { ...data, events: [] }; dirty = true; pending = null;
                    boundQueue();
                    state = JSON.stringify({ ...data, deliveryLost: status.deliveryLost });
                } else pending = options.report(state);
            } catch { status.fileError = true; return; }
            if (options.backup) options.backup.write(state, important);
            else try { options.localWrite?.(state); localError = false; } catch { localError = true; }
            schedule();
        },
        finish() {
            finishing = true;
            clearTimeout(timer); timer = undefined;
            pump();
            options.backup?.finish();
        },
        retry() { retryAt = 0; schedule(); options.backup?.retry(); },
    };
}
