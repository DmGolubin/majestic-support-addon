// SPDX-License-Identifier: GPL-3.0-or-later
// Bounded, coalesced local-file persistence. Disk/network failures never escape
// into plugin actions. No timers run while the journal is idle.
export interface DiagnosticFileStatus {
    path: string;
    initializing: boolean;
    fileError: boolean;
    localError: boolean;
    lastSavedAt: number;
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
    const status: DiagnosticFileStatus = { path: "", initializing: true, fileError: false, localError: false, lastSavedAt: 0 };
    let pending: string | null = null, writing = false, finishing = false, retryAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
        if (writing || pending === null || timer || now() < retryAt) return;
        if (finishing) { pump(); return; }
        timer = setTimeout(() => { timer = undefined; pump(); }, 1000);
    };
    const pump = () => {
        if (writing || pending === null || now() < retryAt) return;
        const report = pending; pending = null; writing = true;
        void Promise.resolve().then(() => options.save(report)).then(result => {
            status.path = result.path; status.fileError = false; status.lastSavedAt = now(); retryAt = 0;
        }).catch(() => {
            status.fileError = true; retryAt = now() + 30_000;
            // Keep the newest snapshot; never queue an unbounded backlog.
            pending ??= report;
        }).finally(() => { writing = false; schedule(); });
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
            const localOptOut = localStamp >= 0 && JSON.parse(local!).until === 0;
            return localStamp > fileStamp || (localStamp === fileStamp && localOptOut)
                ? local : fileStamp >= 0 ? file : local;
        },
        write(state: string) {
            try { options.localWrite(state); status.localError = false; } catch { status.localError = true; }
            try { pending = options.report(state); } catch { status.fileError = true; return; }
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
