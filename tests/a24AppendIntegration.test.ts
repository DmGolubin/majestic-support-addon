import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiagnosticJournal } from "../src/core/diagnosticJournal";
import { createDiagnosticPersistence } from "../src/core/diagnosticPersistence";
import { storageModule } from "./a22DiagnosticStorageHarness";

let root: string;
beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "SupportTemplates-a24-append-"));
});
afterEach(() => {
    vi.clearAllTimers(); vi.useRealTimers();
    // This unique mkdtemp directory belongs only to this fixture.
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("SupportTemplates-a24-append-")) throw Error("Unexpected fixture path");
    fs.rmSync(root, { recursive: true, force: true });
});
it("appends timestamped events beyond the memory ring, dedupes on restart, preserves opt-out and explicitly clears", async () => {
    const native = storageModule.createDiagnosticFileStorage({ root, fs });
    let local: string | null = null;
    async function start() {
        const journal = new DiagnosticJournal();
        const disk = createDiagnosticPersistence({
            localRead: () => local, localWrite: raw => { local = raw; }, load: () => native.load(), save: raw => native.save(raw),
            report: raw => JSON.stringify({ product: "SupportTemplates", version: "1.0.1-canary.30", distribution: "standalone",
                build: "source", recording: journal.active, journal: JSON.parse(raw), snapshot: {} }),
        });
        const saved = await disk.read();
        journal.start({ read: () => saved, write: raw => disk.write(raw) }, { continuous: true, campaign: "mvp-file-2026-10" });
        return { journal, disk };
    }
    const h = await start();
    for (let n = 0; n < 26; n++) {
        for (let i = 0; i < 100; i++) h.journal.record("request.success", { route: "/me", status: 200, token: "SECRET" });
        await vi.advanceTimersByTimeAsync(1000);
    }
    h.journal.stop(); h.disk.finish(); await vi.advanceTimersByTimeAsync(0);
    const filename = path.join(root, storageModule.DIAGNOSTIC_FILE_NAME);
    const before = fs.readFileSync(filename, "utf8");
    expect(before.match(/ request.success /g)).toHaveLength(2600);
    expect(before.split("\n")[0]).toMatch(/^\[\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}\] runtime.start /);
    expect(before).not.toContain("SECRET");
    expect(h.journal.size).toBe(2000); expect(h.disk.status.deliveryLost).toBe(0);
    const id = h.journal.snapshot().sessionId, seq = h.journal.snapshot().sequence;
    // Exercise native-only recovery, not just the localStorage fallback.
    local = null;
    const resumed = await start();
    expect(resumed.journal.snapshot()).toMatchObject({ sessionId: id, sequence: seq + 1 });
    resumed.journal.enable(false); resumed.disk.finish(); await vi.advanceTimersByTimeAsync(0);
    const after = fs.readFileSync(filename, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.match(/ request.success /g)).toHaveLength(2600);
    resumed.journal.stop(); local = null;
    const off = await start(); expect(off.journal.active).toBe(false);
    off.journal.clear(); off.disk.finish(); await vi.advanceTimersByTimeAsync(0);
    expect(fs.readFileSync(filename, "utf8")).not.toContain("request.success");
    const saved = JSON.parse((await native.load()).state);
    expect(saved).toMatchObject({ optedOut: true, clearGeneration: 1, sessionId: id });
    expect(saved.sequence).toBeGreaterThan(seq);
});
