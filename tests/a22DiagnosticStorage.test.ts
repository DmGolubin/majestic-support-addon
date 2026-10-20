import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeFS, ERROR, NOW, payload, report, storageModule as api } from "./a22DiagnosticStorageHarness";

const temporary: string[] = [];
afterEach(() => {
    for (const dir of temporary.splice(0)) {
        // Only remove this test's canonical mkdtemp directory.
        if (!resolve(dir).startsWith(fs.realpathSync(tmpdir()) + sep) || !dir.includes("stx-a22-")) throw Error("Unsafe cleanup");
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
function fixture(bridged = false, overrides: Record<string, unknown> = {}) {
    const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "stx-a22-"))); temporary.push(base);
    const root = join(base, "diagnostics");
    const hostFS = bridged ? bridgeFS(overrides) : { ...fs, ...overrides };
    return { base, root, path: join(root, api.DIAGNOSTIC_FILE_NAME), hostFS,
        make: () => api.createDiagnosticFileStorage({ root, fs: hostFS }) };
}

describe("A22 legacy compatibility and bounded restart state", () => {
    it.each([false, true])("roundtrips and resumes with %s bridged filesystem", async bridged => {
        const f = fixture(bridged), store = f.make();
        expect(await store.load()).toEqual({ path: f.path, state: null });
        expect(fs.existsSync(f.root)).toBe(false);
        expect(await store.save(report())).toEqual({ path: f.path });
        const disk = fs.readFileSync(f.path, "utf8");
        expect(disk.trim().split("\n")).toHaveLength(2);
        expect(disk).toContain("] request.start ");
        expect(JSON.parse((await f.make().load()).state)).toEqual(api.sanitizeDiagnosticReport(report()).journal);
        expect(fs.readdirSync(f.root)).toEqual([api.DIAGNOSTIC_STATE_NAME, api.DIAGNOSTIC_FILE_NAME]);
        expect(Buffer.byteLength(disk)).toBeLessThanOrEqual(api.DIAGNOSTIC_FILE_MAX_BYTES);
    });
    it("bounds restart report including metadata, preserving newest events and legacy deadline", async () => {
        const f = fixture(), p = payload();
        p.journal.events = Array.from({ length: 2000 }, (_, i) => ({ seq: i + 1, time: NOW, event: "request.failure", data: {
            route: "/notification-settings", method: "GET", status: 429, durationMs: 12345, retryAfterMs: 12345,
            requestId: 12345, attempt: 12345, count: 12345, elapsedMs: 12345, templates: 12345, personal: 12345,
            folders: 12345, favoriteCount: 12345, recentCount: 12345, bindCount: 12345, resultCount: 12345, matched: 12345
        } }));
        expect(Buffer.byteLength(JSON.stringify(p))).toBeGreaterThan(512 * 1024);
        await f.make().save(JSON.stringify(p));
        const raw = fs.readFileSync(join(f.root, api.DIAGNOSTIC_STATE_NAME), "utf8"), saved = JSON.parse(raw).report;
        expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(512 * 1024);
        expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(2 * 1024 * 1024);
        expect(fs.statSync(f.path).size).toBeLessThanOrEqual(api.DIAGNOSTIC_FILE_MAX_BYTES);
        expect(saved.journal.dropped).toBeGreaterThan(p.journal.dropped);
        expect(saved.journal.events.at(-1).seq).toBe(2000);
        expect(saved.journal.campaignUntil).toBe(p.journal.campaignUntil);
        expect(saved.journal.until).toBe(p.journal.until);
    });
    it("preserves legacy campaign and savedAt; empty delta does not implicitly clear history", async () => {
        const f = fixture();
        const p = payload(); p.recording = false; p.journal.until = 0; p.journal.campaignUntil = NOW - 1;
        await f.make().save(JSON.stringify(p));
        let saved = JSON.parse((await f.make().load()).state);
        expect(saved).toMatchObject({ campaign: "mvp-file-2026-10", campaignUntil: NOW - 1, until: 0, savedAt: NOW });
        p.journal.savedAt += 42; p.journal.events = []; p.journal.dropped = 0;
        await f.make().save(JSON.stringify(p));
        saved = JSON.parse((await f.make().load()).state);
        expect(saved).toMatchObject({ campaignUntil: NOW - 1, until: 0, savedAt: NOW + 42, dropped: 0 });
        expect(saved.events).toHaveLength(1);
    });
    it("serializes concurrent callers in order, including a final opt-out", async () => {
        const f = fixture(), store = f.make();
        const off = payload(); off.recording = false; off.journal.until = 0;
        off.journal.savedAt = NOW + 1;
        await Promise.all([store.save(report()), store.load(), store.save(JSON.stringify(off))]);
        expect(JSON.parse((await store.load()).state).until).toBe(0);
        expect(JSON.parse(fs.readFileSync(join(f.root, api.DIAGNOSTIC_STATE_NAME), "utf8")).report.recording).toBe(false);
    });
    it.each(["{broken", "{}", JSON.stringify({ journal: { schema: 999 } })])(
        "corrupt legacy JSON fails closed and is archived without being lost %#", async content => {
            const f = fixture(); fs.mkdirSync(f.root); fs.writeFileSync(f.path, content);
            const saved = await f.make().load();
            expect(saved.path).toBe(f.path);
            expect(JSON.parse(saved.state)).toMatchObject({ schema: 1, continuous: true, enabled: false, optedOut: true,
                campaignUntil: 0, until: 0, events: [], dropped: 0 });
            expect(JSON.parse(saved.state).savedAt).toBeGreaterThan(0);
            await f.make().save(report());
            expect(fs.readFileSync(join(f.root, api.DIAGNOSTIC_LEGACY_NAME), "utf8")).toBe(content);
            expect(JSON.parse((await f.make().load()).state).campaign).toBe("mvp-file-2026-10");
        });
    it.each([null, {}, "", "{}", "[]", "not JSON", "x".repeat(1024 * 1024 + 1)])(
        "rejects invalid payload without touching disk %#", async input => {
            const f = fixture();
            await expect(f.make().save(input)).rejects.toThrow(ERROR);
            expect(fs.existsSync(f.root)).toBe(false);
        });
    it("measures UTF-8 bytes, not only JS characters", async () => {
        const f = fixture();
        const p = payload({ unused: "界".repeat(400000) });
        const text = JSON.stringify(p);
        expect(text.length).toBeLessThan(1024 * 1024);
        await expect(f.make().save(text)).rejects.toThrow(ERROR);
        expect(fs.existsSync(f.root)).toBe(false);
    });
    it("revalidates and redacts loaded reports, not just saved reports", async () => {
        const f = fixture(); fs.mkdirSync(f.root);
        const p = payload();
        Object.assign(p.journal.events[0].data, { token: "private-message", message: "private-message" });
        fs.writeFileSync(f.path, JSON.stringify(p));
        expect((await f.make().load()).state).not.toContain("private-message");
    });
    it("keeps prior report on rename failure, removes only its own temp, queue recovers", async () => {
        let fail = false;
        const f = fixture(false, { renameSync: (from: string, to: string) => {
            if (fail) throw new Error("C:/private/secret-token");
            fs.renameSync(from, to);
        } });
        const store = f.make(); await store.save(report());
        const before = fs.readFileSync(f.path, "utf8"); fail = true;
        const p = payload(); p.journal.until = 0;
        await expect(store.save(JSON.stringify(p))).rejects.toThrow(ERROR);
        expect(fs.readFileSync(f.path, "utf8")).toBe(before);
        expect(fs.readdirSync(f.root)).toEqual([api.DIAGNOSTIC_STATE_NAME, api.DIAGNOSTIC_FILE_NAME]);
        fail = false; await store.save(JSON.stringify(p));
        expect(JSON.parse((await store.load()).state).until).toBe(0);
    });
    it("does not overwrite an existing temporary candidate", async () => {
        const f = fixture(); fs.mkdirSync(f.root);
        const nonce = "a".repeat(32), candidate = join(f.root, `.SupportTemplates-diagnostics-${nonce}.tmp`);
        fs.writeFileSync(candidate, "preserve");
        const store = api.createDiagnosticFileStorage({ root: f.root, fs: f.hostFS, randomId: () => nonce });
        await expect(store.save(report())).rejects.toThrow(ERROR);
        expect(fs.readFileSync(candidate, "utf8")).toBe("preserve");
        expect(fs.existsSync(f.path)).toBe(false);
    });
    it("checks authorization again at the head of the queue before disk I/O", async () => {
        const f = fixture();
        const authorize = vi.fn(() => { throw Error("navigation"); });
        await expect(f.make().save(report(), authorize)).rejects.toThrow(ERROR);
        expect(authorize).toHaveBeenCalledOnce();
        expect(fs.existsSync(f.root)).toBe(false);
    });
    it.each(["readFileSync", "writeFileSync", "renameSync", "realpathSync"])("unsupported %s is a generic rejection", async method => {
        const f = fixture(true, { [method]: undefined });
        await expect(f.make().load()).rejects.toThrow(ERROR);
        await expect(f.make().save(report())).rejects.toThrow(ERROR);
        expect(fs.existsSync(f.root)).toBe(false);
    });
    it("is passive after an off snapshot; no timers or background event logging", async () => {
        const f = fixture(), timer = vi.spyOn(globalThis, "setTimeout");
        const p = payload(); p.recording = false; p.journal.until = 0;
        await f.make().save(JSON.stringify(p));
        expect(timer).not.toHaveBeenCalled(); timer.mockRestore();
        expect(JSON.parse((await f.make().load()).state).events).toHaveLength(1);
    });
});

describe("A22 redaction and schema", () => {
    it("preserves safe snapshots and all bounded debug performance fields", () => {
        const p = payload(), out = api.sanitizeDiagnosticReport(JSON.stringify(p));
        expect(out.snapshot.connection).toEqual(p.snapshot.connection);
        expect(out.snapshot.ui).toEqual(p.snapshot.ui);
        expect(out.snapshot.settings).toEqual(p.snapshot.settings);
        expect(out.snapshot.environment).toEqual(p.snapshot.environment);
        expect(out.snapshot.debug).toMatchObject(p.snapshot.debug);
    });
    it("drops arbitrary metadata, raw tokens/messages, paths, nested secrets and debug categories", () => {
        const p = payload({ product: "raw-secret", version: "raw-secret", build: "C:/raw-secret",
            distribution: "raw-secret", exportedAt: "raw-secret", path: "C:/raw-secret", coverage: "raw-secret" });
        for (const group of Object.values(p.snapshot)) Object.assign(group, { message: "raw-secret", token: "raw-secret", path: "raw-secret" });
        Object.assign(p.snapshot.debug.options, { message: "raw-secret" });
        Object.assign(p.snapshot.debug.window, { query: "raw-secret" });
        Object.assign(p.snapshot.debug.performance.categories, { "raw-secret": { ms: 1, n: 1 } });
        Object.assign(p.snapshot.debug.load, { token: "raw-secret" });
        Object.assign(p.journal.events[0].data, { route: "/personal/raw-secret", code: "raw-secret", body: "raw-secret" });
        p.journal.events.push({ seq: 2, time: NOW, event: "raw-secret", data: { method: "GET", route: "/me", status: 200 } });
        const out = api.sanitizeDiagnosticReport(JSON.stringify(p)), text = JSON.stringify(out);
        expect(text).not.toContain("raw-secret");
        expect(out.journal.events).toHaveLength(1);
        expect(out.journal.dropped).toBe(1);
        expect(out.journal.events[0].data.route).toBe("/personal/:id");
    });
    it("bounds debug numbers and strips non-booleans", () => {
        const p = payload();
        Object.assign(p.snapshot.debug.performance, { totalMs: 1e30, windowMs: -500, measured: "true" });
        p.snapshot.debug.performance.categories.keys = { ms: -3, n: 1e30 };
        const out = api.sanitizeDiagnosticReport(JSON.stringify(p));
        expect(out.snapshot.debug.performance).toMatchObject({ totalMs: 1e9, windowMs: 0, measured: false,
            categories: { keys: { ms: 0, n: 1e9 } } });
    });
    it("caps events to 2000, counts removals and rejects arbitrary event names", () => {
        const p = payload();
        p.journal.events = Array.from({ length: 2005 }, (_, seq) => ({ ...p.journal.events[0], seq }));
        const out = api.sanitizeDiagnosticReport(JSON.stringify(p));
        expect(out.journal.events).toHaveLength(2000); expect(out.journal.events[0].seq).toBe(5);
        expect(out.journal.dropped).toBe(5);
    });
    it.each(["campaign", "campaignUntil", "savedAt", "until", "events", "dropped", "schema"])(
        "rejects malformed required journal %s", key => {
            const p = payload(); (p.journal as any)[key] = "raw-secret";
            expect(() => api.sanitizeDiagnosticReport(JSON.stringify(p))).toThrow(ERROR);
        });
    it.each(["source", "a1234567", "a1234567+working · 2026-10-20T12:34:56.000Z", "BetterDiscord a1234567"])(
        "retains known safe build format %s", build => {
            expect(api.sanitizeDiagnosticReport(JSON.stringify(payload({ build }))).build).toBe(build);
        });
    it("profile roots hash canonical userData and normalize Windows casing", () => {
        const a = api.diagnosticProfileRoot("C:\\Data", "C:\\Users\\Test\\Discord", "win32");
        const b = api.diagnosticProfileRoot("C:\\Data", "c:\\users\\test\\discord\\", "win32");
        expect(a).toBe(b); expect(a).not.toContain("Users");
        expect(a).not.toBe(api.diagnosticProfileRoot("C:\\Data", "C:\\Users\\Test\\DiscordCanary", "win32"));
        expect(a).toMatch(/\\diagnostics\\[a-f0-9]{64}$/);
        expect(() => api.diagnosticProfileRoot("relative", "relative", "win32")).toThrow(ERROR);
    });
});

describe("A22 fixed destination integrity", () => {
    it.each([false, true])("refuses directory destination with bridge=%s", async bridged => {
        const f = fixture(bridged); fs.mkdirSync(f.path, { recursive: true });
        await expect(f.make().load()).rejects.toThrow(ERROR);
        await expect(f.make().save(report())).rejects.toThrow(ERROR);
        expect(fs.statSync(f.path).isDirectory()).toBe(true);
    });
    it.each([false, true])("rejects redirected diagnostics directory with bridge=%s", async bridged => {
        const f = fixture(bridged), elsewhere = join(f.base, "elsewhere"); fs.mkdirSync(elsewhere);
        fs.symlinkSync(elsewhere, f.root, process.platform === "win32" ? "junction" : "dir");
        await expect(f.make().load()).rejects.toThrow(ERROR);
        await expect(f.make().save(report())).rejects.toThrow(ERROR);
        expect(fs.readdirSync(elsewhere)).toEqual([]);
    });
    it.each([false, true])("rejects redirected final filename with bridge=%s", async bridged => {
        const f = fixture(bridged), elsewhere = join(f.base, "elsewhere"); fs.mkdirSync(elsewhere); fs.mkdirSync(f.root);
        fs.symlinkSync(elsewhere, f.path, process.platform === "win32" ? "junction" : "dir");
        await expect(f.make().load()).rejects.toThrow(ERROR);
        await expect(f.make().save(report())).rejects.toThrow(ERROR);
        expect(fs.readdirSync(elsewhere)).toEqual([]);
    });
    it("rejects native dangling destination link rather than treating it as missing", async () => {
        const f = fixture(); fs.mkdirSync(f.root);
        fs.symlinkSync(join(f.base, "missing"), f.path, process.platform === "win32" ? "junction" : "dir");
        await expect(f.make().load()).rejects.toThrow(ERROR);
        await expect(f.make().save(report())).rejects.toThrow(ERROR);
    });
    it("rejects a non-directory ancestor without overwriting it", async () => {
        const f = fixture(); fs.writeFileSync(f.root, "private");
        await expect(f.make().save(report())).rejects.toThrow(ERROR);
        expect(fs.readFileSync(f.root, "utf8")).toBe("private");
    });
    it("rejects hard-linked destination without modifying the other file", async () => {
        const f = fixture(); fs.mkdirSync(f.root);
        const other = join(f.base, "owned-by-someone-else"); fs.writeFileSync(other, "private");
        fs.linkSync(other, f.path);
        await expect(f.make().load()).rejects.toThrow(ERROR);
        await expect(f.make().save(report())).rejects.toThrow(ERROR);
        expect(fs.readFileSync(other, "utf8")).toBe("private");
    });
    it("rejects ancestor redirection introduced during staging, no commit elsewhere", async () => {
        const f = fixture(); fs.mkdirSync(f.root);
        const moved = join(f.base, "moved"), other = join(f.base, "other"); fs.mkdirSync(other);
        const hostile = { ...fs, writeFileSync: (...args: any[]) => {
            (fs.writeFileSync as any)(...args);
            fs.renameSync(f.root, moved);
            fs.symlinkSync(other, f.root, process.platform === "win32" ? "junction" : "dir");
        } };
        await expect(api.createDiagnosticFileStorage({ root: f.root, fs: hostile }).save(report())).rejects.toThrow(ERROR);
        expect(fs.readdirSync(other)).toEqual([]);
        expect(fs.existsSync(join(moved, api.DIAGNOSTIC_FILE_NAME))).toBe(false);
    });
    it("never uses a renderer-supplied path or a fallback file", async () => {
        const f = fixture(), escape = join(dirname(f.root), "should-not-exist");
        await f.make().save(JSON.stringify(payload({ path: escape, filename: escape, root: escape })));
        expect(fs.existsSync(escape)).toBe(false);
        expect(fs.readdirSync(f.root)).toEqual([api.DIAGNOSTIC_STATE_NAME, api.DIAGNOSTIC_FILE_NAME]);
    });
});
