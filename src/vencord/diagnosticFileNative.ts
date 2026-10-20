// SPDX-License-Identifier: GPL-3.0-or-later
// Host-owned fixed destination. No renderer path is ever accepted.
import { createHash, randomBytes } from "crypto";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "path";

import { diagnosticData } from "./core/diagnosticJournal";

export const DIAGNOSTIC_FILE_NAME = "main.log";
export const DIAGNOSTIC_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const DIAGNOSTIC_ARCHIVES = 9;
export const DIAGNOSTIC_STATE_NAME = "SupportTemplates-diagnostics.state.json";
export const DIAGNOSTIC_LEGACY_NAME = "main.legacy.log";
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
export const DIAGNOSTIC_STORAGE_ERROR = "Diagnostic storage operation failed.";
const fail = () => new Error(DIAGNOSTIC_STORAGE_ERROR);
const EVENT = /^(?:request|http|auth|stream|panel|runtime|user|ui|debug|recorder|environment|settings|sound|performance)(?:\.[a-z_]{1,24})?$/;
const CAMPAIGN = "mvp-file-2026-10";
const SESSION = /^[a-f0-9]{32}$/;
const ID = /^(?:[a-f0-9]{32}|legacy-[a-f0-9]{64})$/;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, any> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is number => integer(value) && value <= 8640000000000000;
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(1e9, Math.max(0, value)) * 100) / 100 : 0;

/** Only fixed numeric/boolean debug fields survive, even if a compromised caller
 * bypasses debugFileSnapshot. No raw debug logs or arbitrary category names. */
function debugSnapshot(input: unknown) {
    const d = object(input), options = object(d.options), load = object(d.load),
        p = object(d.performance), categories = object(p.categories), long = object(p.longTasks);
    return {
        options: { debug: options.debug === true, debugVerbose: options.debugVerbose === true },
        window: d.window == null ? null : diagnosticData(object(d.window)),
        load: d.load == null ? null : { total: numeric(load.total), storeLoad: numeric(load.storeLoad), mount: numeric(load.mount) },
        performance: {
            measured: p.measured === true, totalMs: numeric(p.totalMs), windowMs: numeric(p.windowMs),
            categories: Object.fromEntries(["keys", "inline", "render", "search", "debug"].map(key => {
                if (typeof categories[key] === "number") return [key, numeric(categories[key])];
                const c = object(categories[key]);
                return [key, { ms: numeric(c.ms), n: numeric(c.n) }];
            })),
            longTasksMeasured: p.longTasksMeasured === true,
            longTasks: { count: numeric(long.count), maxMs: numeric(long.maxMs), pluginMs: numeric(long.pluginMs) }
        }
    };
}

function metadata(raw: Record<string, any>) {
    return {
        product: "SupportTemplates",
        version: typeof raw.version === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:canary|alpha|beta|rc)\.\d{1,6})?$/.test(raw.version) ? raw.version : "unknown",
        build: typeof raw.build === "string" && /^(?:source|(?:BetterDiscord )?[a-f0-9]{7,40}(?:\+working)?(?: · \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)?)$/.test(raw.build) ? raw.build : "unknown",
        distribution: ["betterdiscord", "vencord", "standalone"].includes(raw.distribution) ? raw.distribution : "unknown"
    };
}
function cleanSnapshot(input: unknown) {
    const snapshot = object(input);
    return {
        connection: diagnosticData(object(snapshot.connection)), ui: diagnosticData(object(snapshot.ui)),
        settings: diagnosticData(object(snapshot.settings)), environment: diagnosticData(object(snapshot.environment)),
        debug: debugSnapshot(snapshot.debug)
    };
}

/** Parse and reconstruct, never persist caller objects or free-form strings. */
export function sanitizeDiagnosticReport(report: unknown) {
    if (typeof report !== "string" || report.length > MAX_INPUT_BYTES
        || Buffer.byteLength(report, "utf8") > MAX_INPUT_BYTES) throw fail();
    let raw: Record<string, any>;
    try { raw = object(JSON.parse(report)); } catch { throw fail(); }
    const j = object(raw.journal);
    const continuous = j.continuous === true;
    // Legacy .29 reports remain readable during the continuous-mode migration.
    if (j.schema !== 1 || (!continuous && (j.campaign !== CAMPAIGN || !timestamp(j.campaignUntil) || !timestamp(j.until)))
        || (continuous && (typeof j.enabled !== "boolean" || typeof j.optedOut !== "boolean" || !SESSION.test(j.sessionId)
            || !integer(j.sequence) || !integer(j.clearGeneration)))
        || !timestamp(j.savedAt) || !integer(j.dropped)
        || !Array.isArray(j.events)) throw fail();
    let discarded = Math.max(0, j.events.length - 2000);
    const events = j.events.slice(-2000).flatMap((value: unknown) => {
        const e = object(value);
        if (!integer(e.seq) || !timestamp(e.time) || typeof e.event !== "string" || !EVENT.test(e.event)
            || !e.data || typeof e.data !== "object" || Array.isArray(e.data)) { discarded++; return []; }
        return [{ seq: e.seq, time: e.time, event: e.event, data: diagnosticData(e.data) }];
    });
    const exportedAt = typeof raw.exportedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.exportedAt)
        && Number.isFinite(Date.parse(raw.exportedAt)) ? raw.exportedAt : null;
    return {
        ...metadata(raw),
        exportedAt, recording: raw.recording === true, storageFailed: raw.storageFailed === true,
        snapshot: cleanSnapshot(raw.snapshot),
        journal: { schema: 1, ...(continuous
            ? { continuous: true, enabled: j.enabled, optedOut: j.optedOut, sessionId: j.sessionId,
                sequence: j.sequence, clearGeneration: j.clearGeneration, until: 0, campaign: null, campaignUntil: 0 }
            : { campaign: CAMPAIGN, campaignUntil: j.campaignUntil, until: j.until,
                ...(typeof j.optedOut === "boolean" ? { optedOut: j.optedOut } : {}),
                ...(typeof j.sessionId === "string" && SESSION.test(j.sessionId) ? { sessionId: j.sessionId } : {}) }), savedAt: j.savedAt,
            deliveryLost: integer(j.deliveryLost) ? j.deliveryLost : 0,
            dropped: Math.min(Number.MAX_SAFE_INTEGER, j.dropped + discarded), events }
    };
}

/** Canonical userData comes from app.getPath in the trusted main process. */
export function diagnosticProfileRoot(base: string, userData: string, platform: string): string {
    const paths = platform === "win32" ? win32 : posix;
    if (!paths.isAbsolute(base) || !paths.isAbsolute(userData)) throw fail();
    let profile = paths.normalize(userData);
    if (profile !== paths.parse(profile).root) profile = profile.replace(/[\\/]+$/, "");
    if (platform === "win32") profile = profile.toLowerCase();
    return paths.join(base, "diagnostics", createHash("sha256").update(profile).digest("hex"));
}

interface Info {
    size: number;
    nlink?: number;
    mtimeMs?: number;
    ctimeMs?: number;
    ino?: number;
    dev?: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink?(): boolean;
}
/** Deliberately limited to the synchronous surface exposed by standard BD.
 * lstat is optional and must not be the only protection: BD may alias it to stat. */
export interface DiagnosticFileSystem {
    existsSync(path: string): boolean;
    statSync(path: string): Info;
    lstatSync?(path: string): Info;
    realpathSync(path: string): string;
    mkdirSync(path: string, options: { recursive: true; mode: number; }): unknown;
    readFileSync(path: string): Uint8Array;
    writeFileSync(path: string, data: string | Uint8Array, options: { flag: string; mode: number; }): void;
    renameSync(from: string, to: string): void;
    unlinkSync(path: string): void;
}

type Report = ReturnType<typeof sanitizeDiagnosticReport>;
interface Checkpoint {
    schema: 2; report: Report | null; cursors: Record<string, number>; generations: Record<string, number>;
    nextArchive: number; snapshotHash: string; clearedAt: number;
}
interface Transaction {
    schema: 3; mode: "append" | "rotate" | "legacy" | "clear"; size: number; hash: string;
    tailHash?: boolean; slot: number; text: string; next: Checkpoint;
}
// Different adapters in the same process still serialize against the same root.
const queues = new Map<string, Promise<unknown>>();
function stamp(time: number) {
    const date = new Date(time), pad = (v: number) => String(v).padStart(2, "0");
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function row(time: number, event: string, body: Record<string, unknown>, clearGeneration = 0) {
    return `[${stamp(time)}] ${event} ${JSON.stringify({ ...body, clearGeneration, timeUtc: new Date(time).toISOString() })}\n`;
}
/** Revalidate persisted transaction text before it is replayed. Never trust a WAL
 * to contain redacted data simply because an earlier version wrote it. */
function parseLine(line: string) {
    const match = /^\[(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2})\] ([a-z_.]+) (.+)$/.exec(line);
    if (!match || !EVENT.test(match[2])) throw fail();
    const raw = object(JSON.parse(match[3]));
    let clean: Record<string, unknown>;
    if (match[2] === "runtime.snapshot" && raw.snapshot) {
        clean = { ...metadata(raw), recording: raw.recording === true, snapshot: cleanSnapshot(raw.snapshot) };
        if (raw.sessionId !== undefined) {
            if (typeof raw.sessionId !== "string" || !SESSION.test(raw.sessionId)) throw fail();
            clean.sessionId = raw.sessionId;
        }
    } else if (match[2] === "recorder.gap" && raw.deliveryLost !== undefined) {
        if (!integer(raw.deliveryLost)) throw fail();
        clean = { ...metadata(raw), deliveryLost: raw.deliveryLost };
    } else {
        if (typeof raw.sessionId !== "string" || !ID.test(raw.sessionId) || !integer(raw.seq)) throw fail();
        clean = { ...metadata(raw), sessionId: raw.sessionId, seq: raw.seq, data: diagnosticData(object(raw.data)) };
    }
    // Old local-only lines remain readable during migration. New lines always
    // carry an ISO UTC value derived from the numeric event time.
    if (raw.clearGeneration !== undefined) {
        if (!integer(raw.clearGeneration)) throw fail();
        clean.clearGeneration = raw.clearGeneration;
    }
    if (raw.timeUtc !== undefined) {
        if (typeof raw.timeUtc !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.timeUtc)
            || !Number.isFinite(Date.parse(raw.timeUtc)) || new Date(raw.timeUtc).toISOString() !== raw.timeUtc) throw fail();
        clean.timeUtc = raw.timeUtc;
    }
    if (JSON.stringify(clean) !== match[3]) throw fail();
    return raw;
}
function validateText(text: unknown): asserts text is string {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_INPUT_BYTES || text && !text.endsWith("\n")) throw fail();
    for (const line of text.split("\n").slice(0, -1)) parseLine(line);
}
function boundedReport(report: Report) {
    while (Buffer.byteLength(JSON.stringify(report)) > MAX_REPORT_BYTES && report.journal.events.length) {
        const count = Math.min(100, report.journal.events.length);
        report.journal.events.splice(0, count); report.journal.dropped += count;
    }
    if (Buffer.byteLength(JSON.stringify(report)) > MAX_REPORT_BYTES) throw fail();
    return report;
}

export function createDiagnosticFileStorage(deps: {
    root: string; fs: DiagnosticFileSystem; platform?: string; randomId?: () => string;
}) {
    if (typeof deps.root !== "string" || !isAbsolute(deps.root)) throw fail();
    const fs = deps.fs;
    const root = resolve(deps.root), path = join(root, DIAGNOSTIC_FILE_NAME);
    const statePath = join(root, DIAGNOSTIC_STATE_NAME), legacyPath = join(root, DIAGNOSTIC_LEGACY_NAME);
    const archives = Array.from({ length: DIAGNOSTIC_ARCHIVES }, (_, i) => join(root, `main.${i + 1}.log`));
    const oldPath = join(root, "SupportTemplates-diagnostics.txt");
    const oldLogs = [
        ...archives.map((target, i) => [join(root, `SupportTemplates-diagnostics.${i + 1}.txt`), target]),
        [join(root, "SupportTemplates-diagnostics.legacy.txt"), legacyPath], [oldPath, path]
    ];
    const platform = deps.platform ?? process.platform;
    const normalized = (p: string) => platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
    const randomId = deps.randomId ?? (() => randomBytes(16).toString("hex"));
    const TAIL_BYTES = 64 * 1024;
    type LogCache = { signature: string; size: number; tail: Buffer; legacy: boolean; };
    let logCache: LogCache | undefined;
    let stateCache: { signature: string; value: Checkpoint; } | undefined;
    const tombstone = () => JSON.stringify({ schema: 1, continuous: true, enabled: false, optedOut: true,
        sessionId: randomBytes(16).toString("hex"), sequence: 0, clearGeneration: 0, campaign: null, campaignUntil: 0,
        savedAt: Date.now(), until: 0, dropped: 0, events: [], deliveryLost: 0 });
    const serialize = <T>(action: () => T): Promise<T> => {
        const key = normalized(root);
        const task = (queues.get(key) ?? Promise.resolve()).then(action).catch(() => {
            logCache = undefined; stateCache = undefined; throw fail();
        });
        const settled = task.catch(() => {});
        queues.set(key, settled);
        void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
        return task;
    };
    function capabilities() {
        if (!["existsSync", "statSync", "realpathSync", "mkdirSync", "readFileSync", "writeFileSync", "renameSync", "unlinkSync"]
            .every(key => typeof (fs as unknown as Record<string, unknown>)[key] === "function")) throw fail();
    }
    function inspect(target: string): Info | null {
        // Real native lstat catches dangling links too. A bridged Error may lose code.
        if (fs.lstatSync) {
            try { if (fs.lstatSync(target).isSymbolicLink?.()) throw fail(); }
            catch (e) {
                if ((e as { code?: string; })?.code !== "ENOENT") {
                    if (fs.existsSync(target) || (e as Error)?.message === DIAGNOSTIC_STORAGE_ERROR) throw fail();
                    // The canonical comparison and exclusive create/rename remain mandatory.
                }
            }
        }
        if (!fs.existsSync(target)) return null;
        if (normalized(fs.realpathSync(target)) !== normalized(target)) throw fail();
        return fs.statSync(target);
    }
    function safeDirectories() {
        // Check every ancestor before mkdir, and again before commit; reject junctions.
        for (let current = root;; current = dirname(current)) {
            const info = inspect(current);
            if (info && !info.isDirectory()) throw fail();
            if (dirname(current) === current) break;
        }
    }
    function safeFile(target: string) {
        const info = inspect(target);
        if (info && (!info.isFile() || (info.nlink !== undefined && info.nlink !== 1))) throw fail();
        return info;
    }
    function signature(info: Info | null): string {
        if (!info) return "missing";
        // Hosts without reliable stat metadata use the validated recovery path.
        return [info.mtimeMs, info.ctimeMs, info.ino, info.dev].every(v => typeof v === "number" && Number.isFinite(v))
            ? `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}:${info.dev}` : "";
    }
    function rememberLog(data: Buffer): LogCache {
        return logCache = { signature: signature(safeFile(path)), size: data.length,
            tail: Buffer.from(data.subarray(-TAIL_BYTES)), legacy: data.subarray(0, 4096).toString("utf8").trimStart().startsWith("{") };
    }
    function log(): LogCache {
        safeDirectories();
        const current = signature(safeFile(path));
        if (current && logCache?.signature === current) return logCache;
        return rememberLog(read(path, DIAGNOSTIC_FILE_MAX_BYTES) ?? Buffer.alloc(0));
    }
    function commit(next: Checkpoint) {
        atomic(statePath, JSON.stringify(next));
        stateCache = { signature: signature(safeFile(statePath)), value: next };
    }
    function read(target: string, max: number): Buffer | null {
        safeDirectories();
        const info = safeFile(target);
        if (!info) return null;
        if (info.size > max) throw fail();
        const data = Buffer.from(fs.readFileSync(target));
        safeDirectories(); safeFile(target);
        if (data.length > max) throw fail();
        return data;
    }
    function atomic(target: string, text: string | Uint8Array, max = MAX_STATE_BYTES, exclusive = false) {
        if (Buffer.byteLength(text) > max) throw fail();
        safeDirectories(); safeFile(target);
        if (exclusive && safeFile(target)) throw fail();
        const nonce = randomId();
        if (!/^[a-f0-9]{32}$/.test(nonce)) throw fail();
        const temporary = join(root, `.SupportTemplates-diagnostics-${nonce}.tmp`);
        let created = false;
        try {
            fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600 }); created = true;
            safeDirectories(); safeFile(temporary); safeFile(target);
            if (exclusive && safeFile(target)) throw fail();
            fs.renameSync(temporary, target); created = false;
        } finally {
            if (created) { try { safeDirectories(); safeFile(temporary); fs.unlinkSync(temporary); } catch {} }
        }
    }
    function migrateLogs() {
        safeDirectories();
        if (safeFile(path)) return;
        // Copy archives first, active log last. An interrupted copy can retry,
        // and a pending old WAL replays against identical bytes at the new names.
        // Original .txt files are immutable backups, outside future rotation.
        for (const [source, target] of oldLogs) {
            safeFile(source); safeFile(target);
        }
        for (const [source, target] of oldLogs) {
            if (safeFile(target)) continue;
            const bytes = read(source, DIAGNOSTIC_FILE_MAX_BYTES);
            if (bytes) atomic(target, bytes, DIAGNOSTIC_FILE_MAX_BYTES, true);
        }
    }
    function remove(target: string) {
        safeDirectories();
        if (safeFile(target)) fs.unlinkSync(target);
    }
    function empty(): Checkpoint {
        return { schema: 2, report: null, cursors: {}, generations: {}, nextArchive: 1, snapshotHash: "", clearedAt: 0 };
    }
    function checkpoint(raw: any): Checkpoint {
        if (raw?.schema !== 2 || !integer(raw.nextArchive) || raw.nextArchive < 1 || raw.nextArchive > DIAGNOSTIC_ARCHIVES
            || !timestamp(raw.clearedAt) || typeof raw.snapshotHash !== "string" || !/^(?:[a-f0-9]{64})?$/.test(raw.snapshotHash)) throw fail();
        const counters = (input: unknown) => {
            const out: Record<string, number> = {}, entries = Object.entries(object(input));
            if (entries.length > 4096) throw fail();
            for (const [key, value] of entries) {
                if (!ID.test(key) || !integer(value)) throw fail();
                out[key] = value;
            }
            return out;
        };
        return { schema: 2, report: raw.report === null ? null : boundedReport(sanitizeDiagnosticReport(JSON.stringify(raw.report))),
            cursors: counters(raw.cursors), generations: counters(raw.generations),
            nextArchive: raw.nextArchive, snapshotHash: raw.snapshotHash, clearedAt: raw.clearedAt };
    }
    function transaction(raw: any): Transaction {
        if (raw?.schema !== 3 || !["append", "rotate", "legacy", "clear"].includes(raw.mode)
            || !integer(raw.size) || raw.size > DIAGNOSTIC_FILE_MAX_BYTES || !/^[a-f0-9]{64}$/.test(raw.hash)
            || !integer(raw.slot) || raw.slot < 1 || raw.slot > DIAGNOSTIC_ARCHIVES) throw fail();
        validateText(raw.text);
        return { schema: 3, mode: raw.mode, size: raw.size, hash: raw.hash, tailHash: raw.tailHash === true,
            slot: raw.slot, text: raw.text, next: checkpoint(raw.next) };
    }
    function archivedOriginal(target: string, tx: Transaction) {
        const data = read(target, DIAGNOSTIC_FILE_MAX_BYTES);
        return data !== null && data.length === tx.size && hash(data) === tx.hash;
    }
    function finish(tx: Transaction, baseline?: LogCache) {
        // Check ALL deletion/rotation destinations before changing any of them.
        safeDirectories();
        for (const target of [path, statePath, legacyPath, ...archives]) safeFile(target);
        const text = Buffer.from(tx.text);
        if (tx.mode === "append" && baseline?.signature && baseline.signature === signature(safeFile(path))) {
            if (baseline.size + text.length > DIAGNOSTIC_FILE_MAX_BYTES) throw fail();
            if (!safeFile(path)) fs.writeFileSync(path, "", { flag: "wx", mode: 0o600 });
            safeDirectories(); safeFile(path);
            if (text.length) fs.writeFileSync(path, text, { flag: "a", mode: 0o600 });
            safeDirectories();
            const after = safeFile(path);
            if (!after || after.size !== baseline.size + text.length) throw fail();
            logCache = { signature: signature(after), size: after.size, legacy: false,
                tail: Buffer.from(Buffer.concat([baseline.tail, text]).subarray(-TAIL_BYTES)) };
            commit(tx.next);
            return tx.next;
        }
        if (tx.mode === "clear") {
            for (const target of [path, legacyPath, ...archives]) remove(target);
        } else if (tx.mode === "legacy" || tx.mode === "rotate") {
            const target = tx.mode === "legacy" ? legacyPath : archives[tx.slot - 1];
            let current = read(path, DIAGNOSTIC_FILE_MAX_BYTES);
            if (current && current.length === tx.size && hash(current) === tx.hash) {
                if (tx.mode === "legacy" && safeFile(target)) throw fail(); // Never overwrite another legacy archive.
                // Legacy occupies one archive slot. Evict it only when all other
                // eight slots are occupied and the ninth normal slot is needed.
                if (tx.mode === "rotate" && tx.slot === DIAGNOSTIC_ARCHIVES && safeFile(legacyPath)) {
                    if (!archives.slice(0, -1).every(p => !!safeFile(p))) throw fail();
                    remove(legacyPath);
                }
                safeDirectories(); safeFile(path); safeFile(target);
                fs.renameSync(path, target);
                current = null;
            }
            if (!archivedOriginal(target, tx)) throw fail();
        }
        let current = read(path, DIAGNOSTIC_FILE_MAX_BYTES);
        const base = tx.mode === "append" ? tx.size : 0;
        if (!current) {
            if (base) throw fail();
            // Exclusive creation prevents following a dangling destination link.
            fs.writeFileSync(path, "", { flag: "wx", mode: 0o600 });
            current = Buffer.alloc(0);
        }
        if (current.length < base || current.length > base + text.length || base + text.length > DIAGNOSTIC_FILE_MAX_BYTES
            || (base && hash(current.subarray(tx.tailHash ? Math.max(0, base - TAIL_BYTES) : 0, base)) !== tx.hash)
            || !current.subarray(base).equals(text.subarray(0, current.length - base))) throw fail();
        const remainder = text.subarray(current.length - base);
        if (remainder.length) {
            safeDirectories(); safeFile(path);
            // Genuine append: never rename/truncate a healthy active text log.
            fs.writeFileSync(path, remainder, { flag: "a", mode: 0o600 });
        }
        const verified = read(path, DIAGNOSTIC_FILE_MAX_BYTES);
        if (!verified || verified.length !== base + text.length || !verified.subarray(base).equals(text)) throw fail();
        rememberLog(verified);
        commit(tx.next);
        return tx.next;
    }
    function stored(): Checkpoint | null {
        const current = signature(safeFile(statePath));
        if (current && stateCache?.signature === current) return stateCache.value;
        const raw = read(statePath, MAX_STATE_BYTES);
        if (!raw) return null;
        const parsed = JSON.parse(raw.toString("utf8"));
        const value = parsed.schema === 3 ? finish(transaction(parsed)) : checkpoint(parsed);
        stateCache = { signature: signature(safeFile(statePath)), value };
        return value;
    }
    function reconstruct(): Checkpoint {
        const state = empty();
        const ages = new Map<string, number>();
        for (const target of [...archives, path]) {
            const data = read(target, DIAGNOSTIC_FILE_MAX_BYTES);
            if (!data || data.toString("utf8").trimStart().startsWith("{")) continue;
            const text = data.toString("utf8");
            if (text && !text.endsWith("\n")) throw fail(); // An unjournaled partial line needs explicit clear.
            for (const line of text.split("\n").slice(0, -1)) {
                const parsed = parseLine(line);
                if (!ages.has(target) && typeof parsed.timeUtc === "string") ages.set(target, Date.parse(parsed.timeUtc));
                if (typeof parsed.sessionId === "string") {
                    if (integer(parsed.seq)) state.cursors[parsed.sessionId] = Math.max(state.cursors[parsed.sessionId] ?? 0, parsed.seq);
                    if (integer(parsed.clearGeneration))
                        state.generations[parsed.sessionId] = Math.max(state.generations[parsed.sessionId] ?? 0, parsed.clearGeneration);
                }
            }
        }
        const missing = archives.findIndex(p => !safeFile(p));
        if (missing >= 0) state.nextArchive = missing + 1;
        else {
            const dated = archives.map((p, i) => ({ slot: i + 1, time: safeFile(p)?.mtimeMs ?? ages.get(p) }));
            // Without an ordering signal, fail closed instead of guessing which
            // archive is oldest and potentially discarding the newest history.
            if (dated.some(v => typeof v.time !== "number" || !Number.isFinite(v.time))) throw fail();
            dated.sort((a, b) => a.time! - b.time! || a.slot - b.slot);
            state.nextArchive = dated[0].slot;
        }
        return state;
    }
    function completeHistory(journal: Report["journal"]): boolean {
        if (!("sequence" in journal) || !integer(journal.sequence) || !journal.sessionId
            || journal.clearGeneration !== 0 || journal.sequence === 0 || journal.sequence > 10_000) return false;
        // Optional reconciliation must never scan the whole rotated history on
        // startup. Exceeding either budget retains the warning, not a guess.
        let remaining = 4 * 1024 * 1024;
        const deadline = Date.now() + 150;
        const sequences = new Set<number>();
        try {
            for (const target of [...archives, path]) {
                if (Date.now() > deadline) return false;
                const size = safeFile(target)?.size ?? 0;
                if (size > remaining) return false;
                remaining -= size;
                const data = read(target, remaining + size);
                if (!data) continue;
                const text = data.toString("utf8");
                if (!text.endsWith("\n")) return false;
                for (const line of text.split("\n").slice(0, -1)) {
                    if (Date.now() > deadline) return false;
                    const event = parseLine(line);
                    if (!integer(event.seq)) continue;
                    // A cumulative loss counter spanning other sessions cannot
                    // be disproved just by checking this session's healthy tail.
                    if (event.sessionId !== journal.sessionId) return false;
                    if (event.seq > 0 && event.seq <= journal.sequence) sequences.add(event.seq);
                }
            }
            return sequences.size === journal.sequence;
        } catch { return false; }
    }
    return {
        directory(authorize: () => void = () => {}): Promise<string> {
            return serialize(() => {
                authorize(); capabilities(); safeDirectories();
                fs.mkdirSync(root, { recursive: true, mode: 0o700 });
                safeDirectories(); authorize();
                return root;
            });
        },
        load(authorize: () => void = () => {}): Promise<{ path: string; state: string | null; }> {
            return serialize(() => {
                authorize();
                capabilities(); safeDirectories();
                migrateLogs();
                // Unsafe paths are never interpreted as missing/corrupt state.
                for (const target of [path, statePath, legacyPath, ...archives]) safeFile(target);
                try {
                    const state = stored();
                    if (state?.report) {
                        const journal = state.report.journal;
                        const cursor = journal.sessionId ? state.cursors[journal.sessionId] ?? 0 : 0;
                        // Allocated sequence is not proof of loss: pending deltas
                        // may still arrive or be recovered from localStorage.
                        const complete = journal.deliveryLost > 0 && completeHistory(journal);
                        return { path, state: JSON.stringify({ ...journal,
                            deliveryLost: complete ? 0 : journal.deliveryLost, ...(journal.sessionId ? { deliveryCursor: cursor } : {}),
                            ...(complete ? { deliveryVerifiedThrough: cursor } : {}) }) };
                    }
                    const legacy = read(path, DIAGNOSTIC_FILE_MAX_BYTES);
                    if (legacy?.toString("utf8").trimStart().startsWith("{"))
                        return { path, state: JSON.stringify(sanitizeDiagnosticReport(legacy.toString("utf8")).journal) };
                    return { path, state: legacy || safeFile(statePath) || archives.some(p => safeFile(p)) || safeFile(legacyPath) ? tombstone() : null };
                } catch { return { path, state: tombstone() }; }
            });
        },
        save(report: string, authorize: () => void = () => {}): Promise<{ path: string; }> {
            // Validate and snapshot before queuing. No file is touched on bad input.
            let clean: Report;
            try {
                clean = boundedReport(sanitizeDiagnosticReport(report));
            } catch { return Promise.reject(fail()); }
            return serialize(() => {
                authorize();
                capabilities(); safeDirectories();
                migrateLogs();
                for (const target of [path, statePath, legacyPath, ...archives]) safeFile(target);
                fs.mkdirSync(root, { recursive: true, mode: 0o700 });
                safeDirectories();
                let state: Checkpoint;
                // A malformed state can be rebuilt from intact bounded log lines.
                // Valid pending transactions must finish before considering new input.
                const stateSignature = signature(safeFile(statePath));
                const cached = stateSignature && stateCache?.signature === stateSignature ? stateCache.value : undefined;
                const rebuild = () => {
                    try { return reconstruct(); } catch {
                        // An explicit clear may remove a corrupt/oversized owned
                        // regular log. Path/link guards above still run first.
                        if (!("clearGeneration" in clean.journal) || !(clean.journal.clearGeneration! > 0)) throw fail();
                        return empty();
                    }
                };
                const oversized = (safeFile(statePath)?.size ?? 0) > MAX_STATE_BYTES;
                const disk = cached || oversized ? null : read(statePath, MAX_STATE_BYTES);
                if (cached) state = cached;
                else if (disk) {
                    let parsed: any;
                    try { parsed = JSON.parse(disk.toString("utf8")); } catch {}
                    // A valid pending operation must recover successfully; a disk
                    // failure is never interpreted as permission to clear history.
                    if (parsed?.schema === 3) state = finish(transaction(parsed));
                    else if (parsed?.schema === 2) {
                        try { state = checkpoint(parsed); } catch { state = rebuild(); }
                    } else state = rebuild();
                } else state = rebuild();
                const journal = clean.journal, sid = journal.sessionId as string | undefined;
                const generation = "clearGeneration" in journal ? journal.clearGeneration ?? 0 : 0;
                const clear = !!sid && generation > (state.generations[sid] ?? 0);
                if (sid && generation < (state.generations[sid] ?? 0) || journal.savedAt < state.clearedAt) return { path };
                const baseline = clear ? undefined : log();
                const next: Checkpoint = clear ? empty() : { ...state, cursors: { ...state.cursors }, generations: { ...state.generations } };
                if (clear) {
                    next.clearedAt = journal.savedAt; next.nextArchive = 1;
                    // Sequence survives explicit clear. Its discarded prefix is
                    // intentional, not an undelivered crash gap.
                    if (sid && "sequence" in journal) next.cursors[sid] = journal.events.length
                        ? Math.max(0, Math.min(...journal.events.map(e => e.seq)) - 1) : journal.sequence ?? 0;
                }
                if (sid) next.generations[sid] = generation;
                const meta = metadata(clean);
                let text = "";
                const added: typeof journal.events = [];
                for (const event of [...journal.events].sort((a, b) => a.seq - b.seq)) {
                    const id = sid ?? `legacy-${hash(JSON.stringify(event))}`;
                    if (event.seq <= (next.cursors[id] ?? -1)) continue;
                    text += row(event.time, event.event, { ...meta, sessionId: id, seq: event.seq, data: event.data }, generation);
                    next.cursors[id] = event.seq; added.push(event);
                }
                // Never advance this cursor from journal.sequence: renderer sends
                // delta batches of 100 while sequence already describes later work.
                const lost = journal.deliveryLost;
                if (lost !== (clear ? 0 : state.report?.journal.deliveryLost ?? 0))
                    text += row(journal.savedAt, "recorder.gap", { ...meta, deliveryLost: lost }, generation);
                const snapshot = { ...meta, recording: clean.recording, snapshot: clean.snapshot, ...(sid ? { sessionId: sid } : {}) };
                const snapshotHash = hash(JSON.stringify(snapshot));
                if (next.snapshotHash !== snapshotHash) text += row(journal.savedAt, "runtime.snapshot", snapshot, generation);
                next.snapshotHash = snapshotHash;
                const previous = !clear && state.report && state.report.journal.sessionId === sid ? state.report.journal.events : [];
                const merged = new Map(previous.map(e => [e.seq, e]));
                for (const e of added) merged.set(e.seq, e);
                // Restart/control state merges deltas; it is not just the last batch.
                next.report = boundedReport({ ...clean, journal: { ...journal, events: [...merged.values()].sort((a, b) => a.seq - b.seq).slice(-2000) } });
                for (const counters of [next.cursors, next.generations])
                    for (const key of Object.keys(counters).slice(0, -4096)) delete counters[key];
                const legacy = baseline?.legacy === true;
                const rotate = !clear && !legacy && baseline!.size + Buffer.byteLength(text) > DIAGNOSTIC_FILE_MAX_BYTES;
                const mode = clear ? "clear" : legacy ? "legacy" : rotate ? "rotate" : "append";
                if (mode === "rotate") next.nextArchive = state.nextArchive % DIAGNOSTIC_ARCHIVES + 1;
                if (mode === "append" && !text) {
                    // Control-only updates neither read nor rewrite the active log.
                    commit(next);
                    return { path };
                }
                const old = mode === "legacy" || mode === "rotate" ? read(path, DIAGNOSTIC_FILE_MAX_BYTES)! : null;
                const tx: Transaction = { schema: 3, mode, size: baseline?.size ?? 0,
                    hash: hash(old ?? baseline?.tail ?? Buffer.alloc(0)), tailHash: mode === "append",
                    slot: state.nextArchive, text, next };
                validateText(text);
                // Durable intent precedes append/rotation. A partial append is
                // recovered by matching its bytes, then appending only its suffix.
                atomic(statePath, JSON.stringify(tx));
                finish(tx, mode === "append" ? baseline : undefined);
                return { path };
            });
        }
    };
}
