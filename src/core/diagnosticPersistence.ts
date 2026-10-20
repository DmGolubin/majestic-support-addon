// SPDX-License-Identifier: GPL-3.0-or-later
// Bounded, coalesced local-file persistence. Disk/network failures never escape
// into plugin actions. No timers run while the journal is idle.
import { diagnosticOptOut } from "./diagnosticJournal";

export interface DiagnosticFileStatus {
    path: string;
    initializing: boolean;
    fileError: boolean;
    localError: boolean;
    lastSavedAt: number;
    deliveryLost: number;
}
export function createDiagnosticPersistence(options: {
    localRead(): string | null;
    localWrite(value: string): void;
    load(): Promise<{ path: string; state: string | null; }>;
    save(report: string): Promise<{ path: string; }>;
    report(state: string): string;
    now?: () => number;
}) {
    const now = options.now ?? Date.now;
    const status: DiagnosticFileStatus = { path: "", initializing: true, fileError: false, localError: false, lastSavedAt: 0, deliveryLost: 0 };
    let pending: string | null = null, writing = false, finishing = false, retryAt = 0;
    type Saved = { continuous: boolean; sessionId: string; clearGeneration: number; events: { seq: number; [key: string]: unknown }[]; [key: string]: unknown };
    let latest: Saved | null = null, stream = "", seen = 0, dirty = false;
    let queue: Saved["events"] = [];
    const hasWork = () => pending !== null || dirty || queue.length > 0;
    const boundQueue = () => {
        // Bounded independently of the journal ring and the one in-flight batch.
        // Backpressure cannot silently turn an append log into latest-snapshot logging.
        let bytes = queue.reduce((n, e) => n + JSON.stringify(e).length, 0);
        while (queue.length > 2000 || bytes > 512 * 1024) {
            bytes -= JSON.stringify(queue.shift()!).length;
            status.deliveryLost++;
        }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
        if (writing || !hasWork() || timer || now() < retryAt) return;
        if (finishing) { pump(); return; }
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
            try { local = options.localRead(); } catch { status.localError = true; }
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                const loaded = await Promise.race([
                    Promise.resolve().then(() => options.load()),
                    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Diagnostic storage timeout")), 1500); })
                ]);
                status.path = loaded.path; file = loaded.state;
            } catch { status.fileError = true; retryAt = now() + 30_000; }
            finally { clearTimeout(timeout); status.initializing = false; }
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
            const selected = localStamp > fileStamp || (localStamp === fileStamp && localOptOut)
                ? local : fileStamp >= 0 ? file : local;
            try {
                const lost = JSON.parse(selected ?? "null")?.deliveryLost;
                if (Number.isSafeInteger(lost) && lost > 0) status.deliveryLost = lost;
            } catch {}
            return selected;
        },
        write(state: string) {
            try {
                const data = JSON.parse(state) as Saved;
                if (data.continuous && /^[a-f0-9]{32}$/.test(data.sessionId) && Number.isSafeInteger(data.clearGeneration)) {
                    const nextStream = `${data.sessionId}:${data.clearGeneration}`;
                    if (stream !== nextStream) { queue = []; seen = 0; stream = nextStream; }
                    const events = data.events.filter(e => Number.isSafeInteger(e.seq) && e.seq > seen).sort((a, b) => a.seq - b.seq);
                    for (const event of events) {
                        if (event.seq <= seen) continue;
                        if (seen > 0 && event.seq > seen + 1) status.deliveryLost += event.seq - seen - 1;
                        seen = event.seq; queue.push(event);
                    }
                    latest = { ...data, events: [] }; dirty = true; pending = null;
                    boundQueue();
                    state = JSON.stringify({ ...data, deliveryLost: status.deliveryLost });
                } else pending = options.report(state);
            } catch { status.fileError = true; return; }
            try { options.localWrite(state); status.localError = false; } catch { status.localError = true; }
            schedule();
        },
        finish() {
            finishing = true;
            clearTimeout(timer); timer = undefined;
            pump();
        },
        retry() { retryAt = 0; schedule(); },
    };
}
