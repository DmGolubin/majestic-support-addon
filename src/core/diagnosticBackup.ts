// SPDX-License-Identifier: GPL-3.0-or-later
// One latest pending snapshot and one in-flight write; shared across recorder restarts.
const LIMIT = 512 * 1024; // Same serialized-character bound as DiagnosticJournal.
const INTERVAL = 5000;
const RETRY_DELAY = 30000;
export interface DiagnosticBackup {
    readonly failed: boolean;
    read(): Promise<string | null>;
    write(value: string, urgent?: boolean): void;
    finish(): void;
    retry(): void;
}
export function createDiagnosticBackup(options: {
    read(): Promise<unknown>;
    write(value: string): Promise<void>;
    beforeWrite?(): Promise<void>;
    now?(): number;
}): DiagnosticBackup {
    const now = options.now ?? Date.now;
    let latest: string | null = null, pending: string | null = null;
    let writing = false, finishing = false, urgent = false;
    let readFailed = false, writeFailed = false, inputFailed = false;
    let retryAt = 0, revision = 0, pendingRevision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { clearTimeout(timer); timer = undefined; };
    const schedule = () => {
        if (writing || pending === null || timer || now() < retryAt) return;
        if (finishing) { void pump(); return; }
        const delay = urgent ? 0 : INTERVAL;
        timer = setTimeout(() => { timer = undefined; void pump(); }, delay);
    };
    async function pump() {
        if (writing || pending === null || now() < retryAt) return;
        writing = true;
        let value: string | null = null;
        try {
            // Select AFTER waiting: a drag may replace an old snapshot with an opt-out.
            // Finish/stop deliberately use this same gate.
            await options.beforeWrite?.();
            value = pending; pending = null; urgent = false;
            const writtenRevision = pendingRevision;
            if (value === null) return;
            await options.write(value);
            readFailed = writeFailed = false;
            if (writtenRevision === revision) inputFailed = false;
            retryAt = 0;
        } catch {
            writeFailed = true;
            pending ??= value; // Never replace a newer pending opt-out/clear with a failed old write.
            retryAt = now() + RETRY_DELAY;
        } finally {
            writing = false;
            schedule();
        }
    }
    return {
        get failed() { return readFailed || writeFailed || inputFailed; },
        async read() {
            finishing = false;
            // Restart while a write is queued/in-flight must not restore the older disk copy.
            if (latest !== null) return latest;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                const value = await Promise.race([
                    Promise.resolve().then(options.read),
                    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error("Backup read timed out")), 1500); }),
                ]);
                if (value !== undefined && value !== null) {
                    if (typeof value !== "string" || value.length > LIMIT) throw Error("Invalid backup");
                    const parsed = JSON.parse(value);
                    if (parsed?.schema !== 1 || !Array.isArray(parsed.events) || parsed.events.length > 2000
                        || !Number.isSafeInteger(parsed.savedAt) || parsed.savedAt < 0) throw Error("Invalid backup");
                }
                readFailed = false;
                return value == null ? null : value as string;
            } catch {
                readFailed = true;
                return null;
            } finally { clearTimeout(timeout); }
        },
        write(value, important = false) {
            revision++;
            if (value.length > LIMIT) { inputFailed = true; return; }
            latest = pending = value; pendingRevision = revision;
            if (important) { urgent = true; cancel(); }
            schedule();
        },
        finish() { finishing = true; retryAt = 0; cancel(); void pump(); },
        retry() { retryAt = 0; urgent = true; cancel(); schedule(); },
    };
}
