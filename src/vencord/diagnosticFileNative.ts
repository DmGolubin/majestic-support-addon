// SPDX-License-Identifier: GPL-3.0-or-later
// Host-owned fixed destination. No renderer path is ever accepted.
import { createHash, randomBytes } from "crypto";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "path";

import { diagnosticData } from "./core/diagnosticJournal";

export const DIAGNOSTIC_FILE_NAME = "SupportTemplates-diagnostics.txt";
export const DIAGNOSTIC_FILE_MAX_BYTES = 512 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
export const DIAGNOSTIC_STORAGE_ERROR = "Diagnostic storage operation failed.";
const fail = () => new Error(DIAGNOSTIC_STORAGE_ERROR);
const EVENT = /^(?:request|http|auth|stream|panel|runtime|user|ui|debug|recorder|environment|settings)(?:\.[a-z_]{1,24})?$/;
const CAMPAIGN = "mvp-file-2026-10";
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

/** Parse and reconstruct, never persist caller objects or free-form strings. */
export function sanitizeDiagnosticReport(report: unknown) {
    if (typeof report !== "string" || report.length > MAX_INPUT_BYTES
        || Buffer.byteLength(report, "utf8") > MAX_INPUT_BYTES) throw fail();
    let raw: Record<string, any>;
    try { raw = object(JSON.parse(report)); } catch { throw fail(); }
    const j = object(raw.journal);
    // Expired campaigns and until=0 are meaningful. Never extend or reset them here.
    if (j.schema !== 1 || j.campaign !== CAMPAIGN || !timestamp(j.campaignUntil)
        || !timestamp(j.savedAt) || !timestamp(j.until) || !integer(j.dropped)
        || !Array.isArray(j.events)) throw fail();
    let discarded = Math.max(0, j.events.length - 2000);
    const events = j.events.slice(-2000).flatMap((value: unknown) => {
        const e = object(value);
        if (!integer(e.seq) || !timestamp(e.time) || typeof e.event !== "string" || !EVENT.test(e.event)
            || !e.data || typeof e.data !== "object" || Array.isArray(e.data)) { discarded++; return []; }
        return [{ seq: e.seq, time: e.time, event: e.event, data: diagnosticData(e.data) }];
    });
    const snapshot = object(raw.snapshot);
    const version = typeof raw.version === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:canary|alpha|beta|rc)\.\d{1,6})?$/.test(raw.version)
        ? raw.version : "unknown";
    // Source / released build identifiers only; no arbitrary paths, messages or tokens.
    const build = typeof raw.build === "string" && /^(?:source|(?:BetterDiscord )?[a-f0-9]{7,40}(?:\+working)?(?: · \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)?)$/.test(raw.build)
        ? raw.build : "unknown";
    const exportedAt = typeof raw.exportedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.exportedAt)
        && Number.isFinite(Date.parse(raw.exportedAt)) ? raw.exportedAt : null;
    return {
        product: "SupportTemplates", version, build,
        distribution: ["betterdiscord", "vencord", "standalone"].includes(raw.distribution) ? raw.distribution : "unknown",
        exportedAt, recording: raw.recording === true, storageFailed: raw.storageFailed === true,
        snapshot: {
            connection: diagnosticData(object(snapshot.connection)), ui: diagnosticData(object(snapshot.ui)),
            settings: diagnosticData(object(snapshot.settings)), environment: diagnosticData(object(snapshot.environment)),
            debug: debugSnapshot(snapshot.debug)
        },
        journal: { schema: 1, campaign: CAMPAIGN, campaignUntil: j.campaignUntil, savedAt: j.savedAt, until: j.until,
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
    writeFileSync(path: string, data: string, options: { flag: string; mode: number; }): void;
    renameSync(from: string, to: string): void;
    unlinkSync(path: string): void;
}

export function createDiagnosticFileStorage(deps: {
    root: string; fs: DiagnosticFileSystem; platform?: string; randomId?: () => string;
}) {
    if (typeof deps.root !== "string" || !isAbsolute(deps.root)) throw fail();
    const fs = deps.fs;
    const root = resolve(deps.root), path = join(root, DIAGNOSTIC_FILE_NAME);
    const platform = deps.platform ?? process.platform;
    const normalized = (p: string) => platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
    const randomId = deps.randomId ?? (() => randomBytes(16).toString("hex"));
    // Corruption must not look like first use and silently renew a consumed campaign.
    const tombstone = () => JSON.stringify({ schema: 1, campaign: CAMPAIGN, campaignUntil: 0,
        savedAt: Date.now(), until: 0, dropped: 0, events: [] });
    let queue: Promise<unknown> = Promise.resolve();
    const serialize = <T>(action: () => T): Promise<T> => {
        const task = queue.then(action).catch(() => { throw fail(); });
        queue = task.catch(() => {});
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
    return {
        load(authorize: () => void = () => {}): Promise<{ path: string; state: string | null; }> {
            return serialize(() => {
                authorize();
                capabilities(); safeDirectories();
                const info = safeFile(path);
                if (!info) return { path, state: null };
                if (info.size > DIAGNOSTIC_FILE_MAX_BYTES) return { path, state: tombstone() };
                const bytes = Buffer.from(fs.readFileSync(path));
                safeDirectories(); safeFile(path);
                if (bytes.length > DIAGNOSTIC_FILE_MAX_BYTES) return { path, state: tombstone() };
                // Corrupt regular files do not prevent a later fresh snapshot.
                try { return { path, state: JSON.stringify(sanitizeDiagnosticReport(bytes.toString("utf8")).journal) }; }
                catch { return { path, state: tombstone() }; }
            });
        },
        save(report: string, authorize: () => void = () => {}): Promise<{ path: string; }> {
            // Validate and snapshot before queuing. No file is touched on bad input.
            let text: string;
            try {
                const clean = sanitizeDiagnosticReport(report);
                text = JSON.stringify(clean) + "\n";
                // The bound includes the report envelope and performance snapshot,
                // not only the journal. Keep the latest evidence and fixed deadline.
                while (Buffer.byteLength(text, "utf8") > DIAGNOSTIC_FILE_MAX_BYTES && clean.journal.events.length) {
                    const removed = Math.min(100, clean.journal.events.length);
                    clean.journal.events.splice(0, removed);
                    clean.journal.dropped = Math.min(Number.MAX_SAFE_INTEGER, clean.journal.dropped + removed);
                    text = JSON.stringify(clean) + "\n";
                }
                if (Buffer.byteLength(text, "utf8") > DIAGNOSTIC_FILE_MAX_BYTES) throw fail();
            } catch { return Promise.reject(fail()); }
            return serialize(() => {
                authorize();
                capabilities(); safeDirectories(); safeFile(path);
                fs.mkdirSync(root, { recursive: true, mode: 0o700 });
                safeDirectories();
                const nonce = randomId();
                if (!/^[a-f0-9]{32}$/.test(nonce)) throw fail();
                const temporary = join(root, `.SupportTemplates-diagnostics-${nonce}.tmp`);
                let created = false;
                try {
                    // wx never truncates an old or attacker-controlled temporary file.
                    fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600 }); created = true;
                    safeDirectories(); safeFile(temporary); safeFile(path);
                    fs.renameSync(temporary, path); created = false;
                    // Never fall back to direct write/truncate if rename fails.
                } finally {
                    if (created) {
                        try { safeDirectories(); safeFile(temporary); fs.unlinkSync(temporary); } catch { /* No unsafe cleanup. */ }
                    }
                }
                return { path };
            });
        }
    };
}
