import { File } from "node:buffer";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as core from "../src/core/ticketSound";

const code = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/ticketSound.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const KEY = "SupportTemplates_ticketSound_v1";
const AUDIO_KEY = "SupportTemplates_ticketSoundAudio_v1";
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); vi.restoreAllMocks(); vi.useRealTimers(); });
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

interface SoundState {
    options: core.TicketSoundOptions;
    loaded: boolean;
    error: string;
    testing: boolean;
    customName: string;
    loadingSound: boolean;
    playing: boolean;
    playbackStatus: string;
    canReset: boolean;
    reminderAudio: Record<core.ReminderSoundProject, { customName: string; loadingSound: boolean; canReset: boolean; error: string; }>;
    channelAudio: Record<string, { customName: string; loadingSound: boolean; canReset: boolean; error: string; }>;
}
interface Runtime {
    startTicketSound(): () => void;
    setTicketSound(patch: Partial<core.TicketSoundOptions>): void;
    setReminderTicketSound(project: core.ReminderSoundProject, patch: Partial<core.ReminderSoundOptions>): void;
    chooseReminderSound(file: File, project: core.ReminderSoundProject): Promise<void>;
    resetReminderSound(project: core.ReminderSoundProject): void;
    testReminderSound(project: core.ReminderSoundProject): Promise<void>;
    reminderSoundPolicy(project: core.ReminderSoundProject): { enabled: boolean; revision: string; };
    setChannelTicketSound(id: string, patch: Partial<core.ChannelTicketSoundOptions>): void;
    chooseTicketSound(file: File, parentId?: string): Promise<void>;
    resetTicketSound(parentId?: string): void;
    testTicketSound(parentId?: string): Promise<void>;
    prepareTicketSound(): void;
    stopTicketSoundPlayback(): void;
    stopTicketReminderSound(): void;
    playTicketReminder(current?: () => boolean, context?: core.TicketSoundContext): Promise<boolean>;
    ticketSoundState: { get(): SoundState; };
}
const file = (name = "ping.mp3", bytes = [1, 2, 3, 4]) => new File([new Uint8Array(bytes)], name, { type: "audio/mpeg" });
const record = (name = "saved.wav") => ({ version: 1, name, data: "AQIDBA==" });

async function harness(initial: unknown = core.defaultTicketSound(), initialAudioState = "running", initialSound: unknown = null, channelAudio: Record<string, unknown> = {}, reminderAudio: Record<string, unknown> = {}) {
    const saved = new Map<string, unknown>([[KEY, initial], [AUDIO_KEY, initialSound]]);
    for (const [id, sound] of Object.entries(channelAudio)) saved.set(`${AUDIO_KEY}_channel_${id}`, sound);
    for (const [project, sound] of Object.entries(reminderAudio)) saved.set(`${AUDIO_KEY}_reminder_${project}`, sound);
    const storage = {
        get: vi.fn(async (key: string) => saved.get(key)),
        set: vi.fn(async (key: string, value: unknown) => { saved.set(key, value); }),
    };
    const decode = vi.fn(async (_bytes: ArrayBuffer) => ({ duration: 1 }));
    const bufferStart = vi.fn();
    const oscillatorStart = vi.fn();
    const gainValue = vi.fn();
    const resume = vi.fn(async () => {});
    const sources: { stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onended?: (() => void) | null; }[] = [];
    const contexts: FakeAudioContext[] = [];
    const toast = vi.fn();
    const dispatcher = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    class FakeAudioContext {
        state = initialAudioState;
        currentTime = 0;
        destination = {};
        resume = resume;
        close = vi.fn(async () => { this.state = "closed"; });
        decodeAudioData = decode;
        constructor() { contexts.push(this); }
        createBufferSource() {
            const source = { buffer: null, connect: vi.fn(), disconnect: vi.fn(), start: bufferStart, stop: vi.fn() };
            sources.push(source);
            return source;
        }
        createOscillator() {
            const source = { frequency: { value: 0 }, connect: vi.fn(), disconnect: vi.fn(), start: oscillatorStart, stop: vi.fn() };
            sources.push(source);
            return source;
        }
        createGain() {
            return { gain: { setValueAtTime: gainValue, exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
        }
    }
    const dependencies: Record<string, unknown> = {
        "@webpack/common": {
            ChannelStore: { getChannel: vi.fn() },
            SelectedChannelStore: { getChannelId: vi.fn() },
            FluxDispatcher: dispatcher,
        },
        "../core/ticketSound": core,
        "../platform": { storage, toast },
        "./observable": {
            createObservable<T extends object>(initial: T) {
                let state = initial;
                return { get: () => state, set: (patch: Partial<T>) => { state = { ...state, ...patch }; } };
            },
        },
    };
    const exports = {} as Runtime;
    runInNewContext(code, {
        exports,
        require: (id: string) => {
            if (!(id in dependencies)) throw new Error(`Unexpected import: ${id}`);
            return dependencies[id];
        },
        AudioContext: FakeAudioContext,
        document: { hasFocus: () => false },
        btoa: (binary: string) => Buffer.from(binary, "binary").toString("base64"),
        atob: (base64: string) => Buffer.from(base64, "base64").toString("binary"),
    });
    const stop = exports.startTicketSound();
    cleanups.push(stop);
    await flush();
    const restart = async () => {
        stop();
        const nextStop = exports.startTicketSound();
        cleanups.push(nextStop);
        await flush();
        return nextStop;
    };
    return { ...exports, stop, restart, storage, decode, contexts, sources, bufferStart, oscillatorStart, gainValue, resume, toast,
        thread: (event: unknown) => dispatcher.subscribe.mock.calls.at(-1)![1](event), saved: (key = KEY) => saved.get(key) };
}

describe("custom ticket audio", () => {
    it("rejects malformed persisted records and bounds encoded data", () => {
        for (const value of [null, "https://example.invalid", {}, { ...record(), version: 2 }, { ...record(), name: 1 }]) {
            expect(core.readCustomTicketSound(value)).toBeNull();
        }
        for (const data of ["", "AQI", "====", "A===", "AA=A", "AQI\n", "AA==AAAA", "A".repeat(Math.ceil(core.MAX_TICKET_SOUND_BYTES / 3) * 4)]) {
            expect(core.readCustomTicketSound({ ...record(), data })).toBeNull();
        }
        expect(core.readCustomTicketSound(record("  ping\u0000\u202e.wav  "))).toEqual(record("ping.wav"));
    });

    it.each(["mp3", "wav", "ogg", "m4a", "flac"])("decodes and persists local %s bytes without playing them", async ext => {
        const h = await harness();
        await h.chooseTicketSound(file(`ping.${ext.toUpperCase()}`));
        expect(h.ticketSoundState.get()).toMatchObject({ customName: `ping.${ext.toUpperCase()}`, loadingSound: false, error: "" });
        expect(h.decode).toHaveBeenCalledOnce();
        expect(Array.from(new Uint8Array(h.decode.mock.calls[0][0]))).toEqual([1, 2, 3, 4]);
        expect(h.storage.set).toHaveBeenCalledWith(AUDIO_KEY, record(`ping.${ext.toUpperCase()}`));
        expect(h.bufferStart).not.toHaveBeenCalled();
        expect(h.oscillatorStart).not.toHaveBeenCalled();
        expect(h.resume).not.toHaveBeenCalled();
    });

    it("restores persisted bytes after restart and preserves all options", async () => {
        const h = await harness();
        h.setTicketSound({ volume: 64, quietWhenVisible: false });
        await h.chooseTicketSound(file());
        h.setTicketSound({ cooldownMs: 12000 });
        await flush();
        await h.restart();
        expect(h.ticketSoundState.get()).toMatchObject({ loaded: true, customName: "ping.mp3", options: { volume: 64, cooldownMs: 12000, quietWhenVisible: false } });
        expect(h.decode).toHaveBeenCalledTimes(2);
        expect(await h.playTicketReminder()).toBe(true);
        expect(h.bufferStart).toHaveBeenCalledOnce();
        expect(h.gainValue).toHaveBeenCalledWith(0.64, 0);
        expect(h.oscillatorStart).not.toHaveBeenCalled();
        expect(h.toast).not.toHaveBeenCalled();
    });

    it("writes only small options records for volume changes, never the audio bytes", async () => {
        const h = await harness();
        await h.chooseTicketSound(file());
        h.storage.set.mockClear();
        for (const volume of [31, 32, 33, 34]) h.setTicketSound({ volume });
        await flush();
        expect(h.storage.set).toHaveBeenCalledTimes(4);
        for (const [key, value] of h.storage.set.mock.calls) {
            expect(key).toBe(KEY);
            expect(Object.keys(value as object).sort()).toEqual(Object.keys(core.readTicketSound(core.defaultTicketSound())).sort());
        }
        expect(h.saved(AUDIO_KEY)).toEqual(record("ping.mp3"));
    });

    it("keeps audio and options save errors independent", async () => {
        const h = await harness();
        h.storage.set.mockRejectedValueOnce(new Error("audio write"));
        await h.chooseTicketSound(file());
        h.setTicketSound({ volume: 61 });
        await flush();
        expect(h.ticketSoundState.get().error).toContain("Не удалось сохранить звук");
        h.storage.set.mockRejectedValueOnce(new Error("options write"));
        h.setTicketSound({ volume: 62 });
        await flush();
        expect(h.ticketSoundState.get().error).toContain("Не удалось сохранить настройки");
        expect(h.ticketSoundState.get().error).toContain("Не удалось сохранить звук");
        await h.chooseTicketSound(file());
        expect(h.ticketSoundState.get().error).toBe("Не удалось сохранить настройки. Повторите изменение.");
        h.setTicketSound({ volume: 63 });
        await flush();
        expect(h.ticketSoundState.get().error).toBe("");
    });

    it("retains options when reading the separate audio record fails", async () => {
        const h = await harness({ ...core.defaultTicketSound(), volume: 73 });
        h.storage.get.mockResolvedValueOnce(h.saved()).mockRejectedValueOnce(new Error("audio read"));
        await h.restart();
        expect(h.ticketSoundState.get()).toMatchObject({ loaded: true, options: { volume: 73 }, customName: "" });
        expect(h.ticketSoundState.get().error).toContain("Не удалось прочитать сохранённый звук");
        h.setTicketSound({ volume: 74 });
        await flush();
        expect(h.ticketSoundState.get().error).toContain("Не удалось прочитать сохранённый звук");
        h.resetTicketSound();
        await flush();
        expect(h.ticketSoundState.get().error).toBe("");
    });

    it.each([
        ["empty", () => file("empty.mp3", [])],
        ["large", () => new File([new Uint8Array(core.MAX_TICKET_SOUND_BYTES + 1)], "large.mp3")],
        ["unsupported", () => file("page.html")],
    ])("rejects %s files before reading/decoding", async (_label, makeFile) => {
        const h = await harness();
        const input = makeFile();
        const read = vi.spyOn(input, "arrayBuffer");
        await expect(h.chooseTicketSound(input)).resolves.toBeUndefined();
        expect(h.ticketSoundState.get()).toMatchObject({ loadingSound: false, customName: "" });
        expect(h.ticketSoundState.get().error).not.toBe("");
        expect(read).not.toHaveBeenCalled();
        expect(h.decode).not.toHaveBeenCalled();
        expect(h.storage.set).not.toHaveBeenCalled();
    });

    it.each([0, -1, 30.01, Infinity, NaN])("rejects decoded duration %s without replacing the previous selection", async duration => {
        const h = await harness();
        await h.chooseTicketSound(file("first.wav"));
        h.decode.mockResolvedValueOnce({ duration });
        await h.chooseTicketSound(file("bad.mp3"));
        expect(h.ticketSoundState.get()).toMatchObject({ customName: "first.wav", loadingSound: false });
        expect(h.ticketSoundState.get().error).toContain("30 секунд");
        expect(h.storage.set.mock.calls.filter(([key]) => key === AUDIO_KEY)).toHaveLength(1);
    });

    it("accepts the exact size and duration limits", async () => {
        const h = await harness();
        h.decode.mockResolvedValueOnce({ duration: 30 });
        await h.chooseTicketSound(new File([new Uint8Array(core.MAX_TICKET_SOUND_BYTES)], "max.flac"));
        expect(h.ticketSoundState.get()).toMatchObject({ customName: "max.flac", error: "" });
        expect(core.readCustomTicketSound(h.saved(AUDIO_KEY))).not.toBeNull();
    });

    it("reports read and decode failures without rejecting or playing audio", async () => {
        const h = await harness();
        const input = file();
        vi.spyOn(input, "arrayBuffer").mockRejectedValueOnce(new Error("read failed"));
        await expect(h.chooseTicketSound(input)).resolves.toBeUndefined();
        expect(h.ticketSoundState.get().error).not.toBe("");
        h.decode.mockRejectedValueOnce(new Error("invalid audio"));
        await expect(h.chooseTicketSound(file())).resolves.toBeUndefined();
        expect(h.ticketSoundState.get()).toMatchObject({ customName: "", loadingSound: false });
        expect(h.ticketSoundState.get().error).toContain("MP3");
        expect(h.storage.set).not.toHaveBeenCalled();
        expect(h.bufferStart).not.toHaveBeenCalled();
    });

    it("keeps failed-save warnings through playback and invalid imports, then clears them on a durable reset", async () => {
        const h = await harness();
        h.storage.set.mockRejectedValueOnce(new Error("quota"));
        await expect(h.chooseTicketSound(file())).resolves.toBeUndefined();
        expect(h.ticketSoundState.get().error).toContain("Не удалось сохранить звук");
        await h.testTicketSound();
        expect(h.ticketSoundState.get().error).toContain("Не удалось сохранить звук");
        await h.chooseTicketSound(file("bad.html"));
        expect(h.ticketSoundState.get().error).toContain("Не удалось сохранить звук");
        h.resetTicketSound();
        await flush();
        expect(h.ticketSoundState.get()).toMatchObject({ customName: "", error: "", loadingSound: false });
        expect(h.saved()).toEqual(core.defaultTicketSound());
        expect(h.saved(AUDIO_KEY)).toBeNull();
        await h.restart();
        await h.testTicketSound();
        expect(h.oscillatorStart).toHaveBeenCalledTimes(3);
    });

    it("reports failed resets and allows retry", async () => {
        const h = await harness();
        await h.chooseTicketSound(file());
        h.storage.set.mockRejectedValueOnce(new Error("write"));
        h.resetTicketSound();
        await flush();
        expect(h.ticketSoundState.get()).toMatchObject({ customName: "" });
        expect(h.ticketSoundState.get().error).toContain("Не удалось сохранить звук");
        h.resetTicketSound();
        await flush();
        expect(h.ticketSoundState.get().error).toBe("");
        expect(h.saved()).toEqual(core.defaultTicketSound());
        expect(h.saved(AUDIO_KEY)).toBeNull();
    });

    it("serializes a reset after an in-flight custom save", async () => {
        const h = await harness();
        const pending = deferred<void>();
        const save = h.storage.set.getMockImplementation()!;
        h.storage.set.mockImplementationOnce(async (key, value) => { await pending.promise; await save(key, value); });
        const importing = h.chooseTicketSound(file());
        await flush();
        expect(h.ticketSoundState.get().loadingSound).toBe(true);
        h.resetTicketSound();
        h.setTicketSound({ volume: 81 });
        pending.resolve();
        await importing;
        await flush();
        expect(h.saved()).toEqual({ ...core.readTicketSound(core.defaultTicketSound()), volume: 81 });
        expect(h.saved(AUDIO_KEY)).toBeNull();
        await h.restart();
        expect(h.ticketSoundState.get()).toMatchObject({ customName: "", loadingSound: false, options: { volume: 81 } });
    });

    it("drains queued resets after stop while ignoring stale error publication", async () => {
        const h = await harness(undefined, "running", null, Object.fromEntries(core.defaultTicketSound().channelIds.map(id => [id, null])), { majestic: null, "russia-online": null });
        const pending = deferred<void>();
        h.storage.set.mockReturnValueOnce(pending.promise);
        const importing = h.chooseTicketSound(file());
        await flush();
        h.resetTicketSound();
        h.stop();
        pending.reject(new Error("late save error"));
        await importing;
        await flush();
        expect(h.storage.set.mock.calls.filter(([key]) => key === AUDIO_KEY)).toHaveLength(2);
        expect(h.storage.set).toHaveBeenLastCalledWith(AUDIO_KEY, null);
        expect(h.saved(AUDIO_KEY)).toBeNull();
        expect(h.ticketSoundState.get()).toMatchObject({ loaded: false, customName: "", loadingSound: false, error: "" });
    });

    it.each(["https://example.invalid/audio.mp3", "data:audio/mp3;base64,AQID", "javascript:alert(1)", "file:///tmp/a.wav"])("rejects stored URL %s before creating audio", async data => {
        const h = await harness(undefined, "running", { ...record(), data });
        expect(h.contexts).toHaveLength(0);
        expect(h.ticketSoundState.get()).toMatchObject({ loaded: true, customName: "", loadingSound: false });
        expect(h.ticketSoundState.get().error).toContain("сохранённый звук");
    });

    it("rechecks stored duration and reports corrupted stored audio", async () => {
        const h = await harness();
        h.storage.get.mockResolvedValueOnce(core.defaultTicketSound()).mockResolvedValueOnce(record());
        h.decode.mockResolvedValueOnce({ duration: 31 });
        await h.restart();
        expect(h.ticketSoundState.get()).toMatchObject({ loaded: true, customName: "", loadingSound: false });
        expect(h.ticketSoundState.get().error).toContain("сохранённый звук");
    });

    it.each(["reset", "stop", "replace"])("ignores a late file read after %s", async action => {
        const h = await harness();
        const pending = deferred<ArrayBuffer>();
        const input = file("late.mp3");
        vi.spyOn(input, "arrayBuffer").mockReturnValueOnce(pending.promise);
        const importing = h.chooseTicketSound(input);
        expect(h.ticketSoundState.get().loadingSound).toBe(true);
        if (action === "reset") h.resetTicketSound();
        if (action === "stop") h.stop();
        if (action === "replace") await h.chooseTicketSound(file("new.wav"));
        pending.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
        await importing;
        await flush();
        expect(h.ticketSoundState.get().customName).toBe(action === "replace" ? "new.wav" : "");
        expect(h.ticketSoundState.get().loadingSound).toBe(false);
        expect(h.decode).toHaveBeenCalledTimes(action === "replace" ? 1 : 0);
        if (action === "stop") expect(h.storage.set).not.toHaveBeenCalled();
    });

    it.each(["reset", "stop", "replace"])("ignores a late decode after %s", async action => {
        const h = await harness();
        const pending = deferred<{ duration: number; }>();
        h.decode.mockReturnValueOnce(pending.promise);
        const importing = h.chooseTicketSound(file("late.mp3"));
        await flush();
        if (action === "reset") h.resetTicketSound();
        if (action === "stop") h.stop();
        if (action === "replace") await h.chooseTicketSound(file("new.wav"));
        pending.resolve({ duration: 1 });
        await importing;
        await flush();
        expect(h.ticketSoundState.get().customName).toBe(action === "replace" ? "new.wav" : "");
        expect(h.ticketSoundState.get().loadingSound).toBe(false);
        expect(h.bufferStart).not.toHaveBeenCalled();
        if (action === "stop") expect(h.storage.set).not.toHaveBeenCalled();
    });

    it("does not restore late persisted audio over a restarted runtime", async () => {
        const h = await harness();
        const pending = deferred<{ duration: number; }>();
        h.storage.get.mockResolvedValueOnce(core.defaultTicketSound()).mockResolvedValueOnce(record("old.wav"));
        h.decode.mockReturnValueOnce(pending.promise);
        const stopLoading = await h.restart();
        expect(h.ticketSoundState.get().loadingSound).toBe(true);
        stopLoading();
        cleanups.push(h.startTicketSound());
        await flush();
        pending.resolve({ duration: 1 });
        await flush();
        expect(h.ticketSoundState.get()).toMatchObject({ loaded: true, customName: "", loadingSound: false });
        expect(h.bufferStart).not.toHaveBeenCalled();
    });
});

describe("ticket reminder audio receipts", () => {
    it("uses standard audio despite disabled new-ticket alerts and never toasts", async () => {
        const h = await harness();
        expect(h.ticketSoundState.get().options.enabled).toBe(false);
        expect(await h.playTicketReminder()).toBe(true);
        expect(h.oscillatorStart).toHaveBeenCalledTimes(3);
        expect(h.resume).not.toHaveBeenCalled();
        expect(h.toast).not.toHaveBeenCalled();
    });

    it("returns false while muted, stopped, or an import is pending", async () => {
        const h = await harness();
        h.setTicketSound({ volume: 0 });
        expect(await h.playTicketReminder()).toBe(false);
        expect(h.contexts).toHaveLength(0);
        h.setTicketSound({ volume: 50 });
        const pending = deferred<ArrayBuffer>();
        const input = file();
        vi.spyOn(input, "arrayBuffer").mockReturnValueOnce(pending.promise);
        const importing = h.chooseTicketSound(input);
        expect(await h.playTicketReminder()).toBe(false);
        h.stop();
        pending.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
        await importing;
        expect(await h.playTicketReminder()).toBe(false);
        expect(h.bufferStart).not.toHaveBeenCalled();
        expect(h.oscillatorStart).not.toHaveBeenCalled();
    });

    it.each(["suspended", "closed", "interrupted"])("returns false for a %s context without resuming", async state => {
        const h = await harness(undefined, state);
        expect(await h.playTicketReminder()).toBe(false);
        expect(h.resume).not.toHaveBeenCalled();
        expect(h.oscillatorStart).not.toHaveBeenCalled();
        expect(h.toast).not.toHaveBeenCalled();
    });

    it("checks the receipt guard immediately before scheduling", async () => {
        const h = await harness();
        const current = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
        expect(await h.playTicketReminder(current)).toBe(false);
        expect(current).toHaveBeenCalledTimes(2);
        expect(h.oscillatorStart).not.toHaveBeenCalled();
        expect(await h.playTicketReminder(() => false)).toBe(false);
        expect(h.toast).not.toHaveBeenCalled();
    });

    it("returns false and stops partial playback on a scheduling error", async () => {
        const h = await harness();
        h.oscillatorStart.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("device"); });
        expect(await h.playTicketReminder()).toBe(false);
        expect(h.ticketSoundState.get().error).toContain("Не удалось воспроизвести");
        expect(h.sources).toHaveLength(2);
        for (const source of h.sources) expect(source.disconnect).toHaveBeenCalled();
        expect(h.toast).not.toHaveBeenCalled();
    });

    it("stops active custom audio and ignores late test resumes after shutdown", async () => {
        const h = await harness();
        await h.chooseTicketSound(file());
        expect(await h.playTicketReminder()).toBe(true);
        const pending = deferred<void>();
        h.resume.mockReturnValueOnce(pending.promise);
        const testing = h.testTicketSound();
        h.stop();
        pending.resolve();
        await testing;
        expect(h.bufferStart).toHaveBeenCalledOnce();
        expect(h.sources[0].stop).toHaveBeenCalledOnce();
        expect(h.contexts[0].close).toHaveBeenCalledOnce();
        expect(h.ticketSoundState.get().testing).toBe(false);
    });
});

describe("A23 sound playback and cancellation", () => {
    const thread = () => ({ channel: { id: String(BigInt(Date.now() + 1000 - 1420070400000) << 22n),
        parent_id: "696711470783922247", guild_id: "530693013622489088" }, newlyCreated: true });

    it("unlocks audio in the enable gesture so the next new ticket can play", async () => {
        const h = await harness(undefined, "suspended");
        h.resume.mockImplementation(async () => { h.contexts[0].state = "running"; });
        h.setChannelTicketSound("696711470783922247", { enabled: true });
        expect(h.resume).toHaveBeenCalledOnce();
        await flush();
        h.thread(thread());
        await flush();
        expect(h.oscillatorStart).toHaveBeenCalledTimes(3);
        expect(h.ticketSoundState.get().error).toBe("");
    });

    it("does not queue suspended automatic playback or replay after toggling", async () => {
        const events = vi.spyOn(core, "recordTicketSoundDiagnostic");
        const h = await harness({ ...core.defaultTicketSound(), enabled: true }, "suspended");
        const event = thread();
        h.thread(event);
        expect(h.resume).not.toHaveBeenCalled();
        expect(h.oscillatorStart).not.toHaveBeenCalled();
        expect(events).toHaveBeenCalledWith("skipped", expect.objectContaining({ code: "sound_suspended" }));
        h.resume.mockImplementation(async () => { h.contexts[0].state = "running"; });
        h.setTicketSound({ enabled: false }); h.setTicketSound({ enabled: true });
        await flush();
        h.thread(event);
        expect(h.oscillatorStart).not.toHaveBeenCalled();
        expect(events).toHaveBeenCalledWith("skipped", expect.objectContaining({ code: "sound_duplicate" }));
    });

    it.each(["mute", "disable", "stop", "replace"] as const)("cancels pending test playback on %s even if settings later recover", async action => {
        const h = await harness({ ...core.defaultTicketSound(), enabled: true });
        const pending = deferred<void>();
        h.resume.mockReturnValueOnce(pending.promise);
        const testing = h.testTicketSound();
        if (action === "mute") { h.setTicketSound({ volume: 0 }); h.setTicketSound({ volume: 50 }); }
        if (action === "disable") { h.setTicketSound({ enabled: false }); h.setTicketSound({ enabled: true }); }
        if (action === "stop") h.stop();
        if (action === "replace") await h.chooseTicketSound(file());
        pending.resolve(); await testing;
        expect(h.oscillatorStart).not.toHaveBeenCalled();
        expect(h.bufferStart).not.toHaveBeenCalled();
        expect(h.ticketSoundState.get().testing).toBe(false);
    });

    it("custom test uses the selected buffer and volume and exposes completion feedback", async () => {
        const h = await harness();
        h.setTicketSound({ volume: 42 });
        await h.chooseTicketSound(file("private-name.wav"));
        await h.testTicketSound();
        expect(h.bufferStart).toHaveBeenCalledOnce();
        expect(h.oscillatorStart).not.toHaveBeenCalled();
        expect(h.gainValue).toHaveBeenCalledWith(0.42, 0);
        expect(h.ticketSoundState.get()).toMatchObject({ playing: true, testing: false });
        expect(h.ticketSoundState.get().playbackStatus).toContain("Воспроизводится свой звук");
        h.sources[0].onended?.();
        expect(h.ticketSoundState.get().playing).toBe(false);
        expect(h.ticketSoundState.get().playbackStatus).toContain("Тест завершён");
    });

    it.each(["mute", "disable", "reset", "stop"] as const)("stops already playing custom audio on %s", async action => {
        const h = await harness({ ...core.defaultTicketSound(), enabled: true });
        await h.chooseTicketSound(file()); await h.testTicketSound();
        if (action === "mute") h.setTicketSound({ volume: 0 });
        if (action === "disable") h.setTicketSound({ enabled: false });
        if (action === "reset") h.resetTicketSound();
        if (action === "stop") h.stopTicketSoundPlayback();
        expect(h.sources[0].stop).toHaveBeenCalledOnce();
        expect(h.ticketSoundState.get().playing).toBe(false);
    });

    it("volume zero keeps all playback modes silent and explains manual testing", async () => {
        const h = await harness({ ...core.defaultTicketSound(), enabled: true, volume: 0 });
        h.thread(thread());
        await h.testTicketSound();
        expect(await h.playTicketReminder()).toBe(false);
        h.prepareTicketSound();
        expect(h.contexts).toHaveLength(0);
    });

    it("retains reset retry after a failed reset so stale saved custom bytes can be cleared", async () => {
        const h = await harness();
        await h.chooseTicketSound(file());
        h.storage.set.mockRejectedValueOnce(Error("storage failed"));
        h.resetTicketSound(); await flush();
        expect(h.ticketSoundState.get()).toMatchObject({ customName: "", canReset: true });
        h.resetTicketSound(); await flush();
        expect(h.ticketSoundState.get().canReset).toBe(false);
        expect(h.saved(AUDIO_KEY)).toBeNull();
    });

    it("logs static playback and custom-load codes, never filenames, bytes or raw errors", async () => {
        const events = vi.spyOn(core, "recordTicketSoundDiagnostic");
        const h = await harness();
        await h.chooseTicketSound(file("SECRET_NAME.wav"));
        await h.testTicketSound();
        h.resume.mockRejectedValueOnce(Error("SECRET_ERROR data:audio/wav;base64,AQIDBA=="));
        await h.testTicketSound();
        expect(h.ticketSoundState.get().playing).toBe(false);
        expect(h.ticketSoundState.get().playbackStatus).not.toContain("Воспроизводится");
        const input = file("PRIVATE.wav");
        vi.spyOn(input, "arrayBuffer").mockRejectedValueOnce(Error("SECRET_PATH"));
        await h.chooseTicketSound(input);
        const log = JSON.stringify(events.mock.calls);
        expect(log).not.toMatch(/SECRET|PRIVATE|AQIDBA|data:audio/);
        expect(events).toHaveBeenCalledWith("played", expect.objectContaining({ mode: "test", success: true }));
        expect(events).toHaveBeenCalledWith("error", expect.objectContaining({ code: "sound_playback" }));
        expect(events).toHaveBeenCalledWith("error", expect.objectContaining({ code: "sound_read" }));
        expect(h.ticketSoundState.get().error).not.toContain("SECRET");
    });

    it("times out a never-resolving resume without leaving test UI busy", async () => {
        const h = await harness();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        h.resume.mockReturnValueOnce(new Promise<void>(() => {}));
        const testing = h.testTicketSound();
        await vi.advanceTimersByTimeAsync(5001);
        await testing;
        expect(h.ticketSoundState.get()).toMatchObject({ testing: false, playing: false });
        expect(h.ticketSoundState.get().error).toContain("Не удалось воспроизвести");
        expect(h.oscillatorStart).not.toHaveBeenCalled();
    });

    it("continues cleanup if a source disconnect or AudioContext close throws", async () => {
        const h = await harness();
        await h.testTicketSound();
        h.sources[0].disconnect.mockImplementation(() => { throw Error("disposed"); });
        h.contexts[0].close.mockImplementation(() => { throw Error("disposed"); });
        expect(h.stop).not.toThrow();
        for (const source of h.sources) expect(source.disconnect).toHaveBeenCalled();
        expect(h.ticketSoundState.get().loaded).toBe(false);
    });
    it("stopping reminder delivery stops only reminder audio, leaving an explicit test alone", async () => {
        const h = await harness();
        await h.chooseTicketSound(file());
        await h.testTicketSound();
        await h.playTicketReminder();
        h.stopTicketReminderSound();
        expect(h.sources[0].stop).not.toHaveBeenCalled();
        expect(h.sources[1].stop).toHaveBeenCalledOnce();
        expect(h.ticketSoundState.get().playing).toBe(true);
    });
});

describe("A24 independent parent-channel audio", () => {
    const [mj, ro] = core.defaultTicketSound().channelIds;
    const key = (id: string) => `${AUDIO_KEY}_channel_${id}`;
    let sequence = 0;
    const threadFor = (parentId: string) => ({ channel: {
        id: String((BigInt(Date.now() + 1000 - 1420070400000) << 22n) + BigInt(++sequence)),
        parent_id: parentId, guild_id: parentId === mj ? "530693013622489088" : "1089530150540034181",
    }, newlyCreated: true });
    const enabled = () => ({ ...core.defaultTicketSound(), enabled: true, quietWhenVisible: false });

    it.each([mj, ro])("A29 new tickets in %s remain sound-only without a toast or reminder card", async parentId => {
        const h = await harness(enabled());
        const event = threadFor(parentId);
        h.thread(event); await flush();
        expect(h.oscillatorStart).toHaveBeenCalledTimes(3);
        expect(h.toast).not.toHaveBeenCalled();
        // The runtime's strict imports also prohibit adding a notification-store side effect.
        h.thread(event); await flush();
        expect(h.oscillatorStart).toHaveBeenCalledTimes(3);
        expect(h.toast).not.toHaveBeenCalled();
    });

    it("materializes missing install preferences before the first personal volume edit", async () => {
        const h = await harness(null);
        h.setTicketSound({ volume: 81 }); await flush(); await h.restart();
        expect(h.ticketSoundState.get().options.volume).toBe(81);
        for (const id of [mj, ro]) expect(core.channelTicketSound(h.ticketSoundState.get().options, id).volume).toBe(30);
    });

    it("migrates preferences once and keeps later reminder volume independent", async () => {
        const h = await harness({ ...enabled(), volume: 42, cooldownMs: 7000 });
        h.setTicketSound({ volume: 0 });
        h.setChannelTicketSound(mj, { volume: 13, cooldownMs: 1000, enabled: false });
        await flush(); await h.restart();
        const options = h.ticketSoundState.get().options;
        expect(options.volume).toBe(0);
        expect(core.channelTicketSound(options, mj)).toMatchObject({ volume: 13, cooldownMs: 1000, enabled: false });
        expect(core.channelTicketSound(options, ro)).toMatchObject({ volume: 42, cooldownMs: 7000, enabled: true });
        h.thread(threadFor(mj)); h.thread(threadFor(ro));
        expect(h.oscillatorStart).toHaveBeenCalledTimes(3);
        expect(h.gainValue).toHaveBeenCalledWith(0.3 * 0.42, 0);
        expect(await h.playTicketReminder()).toBe(false);
    });

    it("plays both parents in the same burst with independent cooldowns", async () => {
        const h = await harness(enabled());
        h.thread(threadFor(mj)); h.thread(threadFor(ro));
        expect(h.oscillatorStart).toHaveBeenCalledTimes(6);
        h.thread(threadFor(mj)); h.thread(threadFor(ro));
        expect(h.oscillatorStart).toHaveBeenCalledTimes(6);
    });

    it("persists independent custom files and standard reset without touching reminder audio", async () => {
        const h = await harness(enabled(), "running", record("legacy.wav"));
        await h.chooseTicketSound(file("majestic.wav"), mj);
        await h.chooseTicketSound(file("russia.ogg", [5, 6, 7, 8]), ro);
        expect(h.saved(key(mj))).toEqual(record("majestic.wav"));
        expect(h.saved(key(ro))).toMatchObject({ name: "russia.ogg", data: "BQYHCA==" });
        expect(h.saved(AUDIO_KEY)).toEqual(record("legacy.wav"));
        h.resetTicketSound(mj); await flush(); await h.restart();
        expect(h.ticketSoundState.get().channelAudio[mj].customName).toBe("");
        expect(h.ticketSoundState.get().channelAudio[ro].customName).toBe("russia.ogg");
        h.thread(threadFor(mj)); h.thread(threadFor(ro));
        expect(h.oscillatorStart).toHaveBeenCalledTimes(3);
        expect(h.bufferStart).toHaveBeenCalledOnce();
        expect(await h.playTicketReminder()).toBe(true);
        expect(h.bufferStart).toHaveBeenCalledTimes(2);
    });

    it("freezes inherited audio before changing global personal-reminder audio", async () => {
        const h = await harness(enabled(), "running", record("legacy.wav"));
        await h.chooseTicketSound(file("reminder.wav", [5, 6, 7, 8]));
        await h.restart();
        expect(h.ticketSoundState.get().customName).toBe("reminder.wav");
        for (const id of [mj, ro]) {
            expect(h.saved(key(id))).toEqual(record("legacy.wav"));
            expect(h.ticketSoundState.get().channelAudio[id].customName).toBe("legacy.wav");
        }
    });

    it("does not overwrite a queued channel selection with its legacy migration snapshot", async () => {
        const h = await harness(enabled(), "running", record("legacy.wav"));
        const pending = deferred<void>();
        const realSet = h.storage.set.getMockImplementation()!;
        h.storage.set.mockImplementationOnce(async (key, value) => { await pending.promise; await realSet(key, value); });
        const choosing = h.chooseTicketSound(file("new-channel.wav"), mj);
        await flush();
        const reminder = h.chooseTicketSound(file("new-reminder.wav"));
        await flush();
        pending.resolve(); await Promise.all([choosing, reminder]);
        await h.restart();
        expect(h.saved(key(mj))).toEqual(record("new-channel.wav"));
        expect(h.ticketSoundState.get().channelAudio[mj].customName).toBe("new-channel.wav");
        expect(h.ticketSoundState.get().channelAudio[ro].customName).toBe("legacy.wav");
    });

    it.each(["disable", "zero", "reset"] as const)("%s stops only its parent's active sound, leaving other channel/reminder playing", async action => {
        const h = await harness(enabled(), "running", record());
        h.thread(threadFor(mj)); h.thread(threadFor(ro)); await h.playTicketReminder();
        expect(h.sources).toHaveLength(3);
        if (action === "disable") h.setChannelTicketSound(mj, { enabled: false });
        if (action === "zero") h.setChannelTicketSound(mj, { volume: 0 });
        if (action === "reset") h.resetTicketSound(mj);
        expect(h.sources[0].stop).toHaveBeenCalledOnce();
        expect(h.sources[1].stop).not.toHaveBeenCalled();
        expect(h.sources[2].stop).not.toHaveBeenCalled();
    });

    it("cancels a pending same-channel preview on mute even if immediately unmuted", async () => {
        const h = await harness(enabled());
        const pending = deferred<void>(); h.resume.mockReturnValueOnce(pending.promise);
        const testing = h.testTicketSound(mj);
        h.setChannelTicketSound(mj, { enabled: false }); h.setChannelTicketSound(mj, { enabled: true });
        pending.resolve(); await testing;
        expect(h.oscillatorStart).not.toHaveBeenCalled();
        expect(h.ticketSoundState.get().testing).toBe(false);
    });

    it("does not cancel another channel's pending preview when reminder or other parent is muted", async () => {
        const h = await harness(enabled());
        const pending = deferred<void>(); h.resume.mockReturnValueOnce(pending.promise);
        const testing = h.testTicketSound(ro);
        h.setChannelTicketSound(mj, { volume: 0 }); h.setTicketSound({ volume: 0 });
        expect(h.ticketSoundState.get().testing).toBe(true);
        pending.resolve(); await testing;
        expect(h.oscillatorStart).toHaveBeenCalledTimes(3);
    });

    it("explicitly previews a disabled zero-volume custom channel at 30% without enabling it", async () => {
        const events = vi.spyOn(core, "recordTicketSoundDiagnostic");
        const h = await harness(enabled(), "running", null, { [mj]: record("PRIVATE.wav") });
        h.setChannelTicketSound(mj, { enabled: false, volume: 0 });
        const before = structuredClone(h.ticketSoundState.get().options);
        h.thread(threadFor(mj)); expect(h.bufferStart).not.toHaveBeenCalled();
        await h.testTicketSound(mj);
        expect(h.bufferStart).toHaveBeenCalledOnce();
        expect(h.gainValue).toHaveBeenCalledWith(0.3, 0);
        expect(h.ticketSoundState.get().options).toEqual(before);
        expect(h.ticketSoundState.get().playbackStatus).toContain("30%, настройки не изменены");
        expect(events).toHaveBeenCalledWith("played", expect.objectContaining({ configSource: "preview", channelId: mj, volume: 30, enabled: false, audioState: "running", phase: "start" }));
        expect(JSON.stringify(events.mock.calls)).not.toMatch(/PRIVATE|AQIDBA/);
    });

    it("preserves other channel after an invalid upload and offers reset retry after failed save", async () => {
        const h = await harness(enabled(), "running", record());
        await h.chooseTicketSound(file("wrong.txt"), mj);
        expect(h.ticketSoundState.get().channelAudio[mj].error).toContain("MP3");
        expect(h.ticketSoundState.get().channelAudio[ro].error).toBe("");
        h.storage.set.mockRejectedValueOnce(Error("PRIVATE"));
        h.resetTicketSound(mj); await flush();
        expect(h.ticketSoundState.get().channelAudio[mj]).toMatchObject({ canReset: true, customName: "" });
        h.resetTicketSound(mj); await flush();
        expect(h.ticketSoundState.get().channelAudio[mj]).toMatchObject({ canReset: false, error: "" });
        expect(h.saved(key(mj))).toBeNull();
    });

    it("logs selected context, per-channel config, actual scheduled start and completion", async () => {
        const events = vi.spyOn(core, "recordTicketSoundDiagnostic");
        const h = await harness(enabled(), "running", record());
        const event = threadFor(mj); h.thread(event);
        const data = { ticketId: event.channel.id, channelId: mj, guildId: event.channel.guild_id, configSource: "channel", audioState: "running", volume: 30 };
        expect(events).toHaveBeenCalledWith("input", expect.objectContaining(data));
        expect(events).toHaveBeenCalledWith("played", expect.objectContaining({ ...data, success: true, phase: "start" }));
        h.sources[0].onended?.();
        expect(events).toHaveBeenCalledWith("result", expect.objectContaining({ ...data, phase: "ended" }));
        const context = { ticketId: "regional:42", channelId: null, guildId: null, project: "russia-online" as const, cycle: 3, waitingCycleId: "opaque", reminderId: null };
        expect(await h.playTicketReminder(() => true, context)).toBe(true);
        expect(events).toHaveBeenCalledWith("played", expect.objectContaining({ ...context, configSource: "personal", mode: "reminder", enabled: true }));
        for (const [, data] of events.mock.calls.filter(([, data]) => data.mode === "reminder"))
            expect(data.enabled).toBe(true);
    });

    it("logs suspension and start exceptions without recording false start success", async () => {
        const events = vi.spyOn(core, "recordTicketSoundDiagnostic");
        const h = await harness(enabled(), "suspended");
        h.thread(threadFor(mj));
        expect(events).toHaveBeenCalledWith("skipped", expect.objectContaining({ channelId: mj, code: "sound_suspended", audioState: "suspended", success: false }));
        expect(events.mock.calls.filter(([event]) => event === "played")).toHaveLength(0);
        h.contexts[0].state = "running";
        h.oscillatorStart.mockImplementationOnce(() => { throw Error("SECRET"); });
        await h.testTicketSound(ro);
        expect(events).toHaveBeenCalledWith("error", expect.objectContaining({ channelId: ro, code: "sound_playback", configSource: "preview" }));
        expect(events.mock.calls.filter(([event]) => event === "played")).toHaveLength(0);
        expect(JSON.stringify(events.mock.calls)).not.toContain("SECRET");
    });
});

describe("A26 personal reminder projects", () => {
    const mj = "majestic" as const, ro = "russia-online" as const;
    const context = (project: core.ReminderSoundProject) => ({ project, ticketId: `${project}:42`, channelId: "696711470783922247", guildId: "530693013622489088" });
    const key = (project: string) => `${AUDIO_KEY}_reminder_${project}`;

    it("seeds both projects from global volume/audio but never the unrelated global new-ticket toggle", async () => {
        const h = await harness({ ...core.defaultTicketSound(), enabled: false, volume: 84 }, "running", record("legacy.wav"));
        for (const project of [mj, ro]) {
            expect(core.reminderTicketSound(h.ticketSoundState.get().options, project)).toEqual({ enabled: true, volume: 84 });
            expect(h.ticketSoundState.get().reminderAudio[project].customName).toBe("legacy.wav");
            expect(h.reminderSoundPolicy(project).enabled).toBe(true);
        }
        const channels = structuredClone(h.ticketSoundState.get().options.channels);
        h.setReminderTicketSound(mj, { enabled: false, volume: 21 }); await flush(); await h.restart();
        expect(core.reminderTicketSound(h.ticketSoundState.get().options, mj)).toEqual({ enabled: false, volume: 21 });
        expect(core.reminderTicketSound(h.ticketSoundState.get().options, ro)).toEqual({ enabled: true, volume: 84 });
        expect(h.ticketSoundState.get().options.channels).toEqual(channels);
        expect(await h.playTicketReminder(undefined, context(mj))).toBe(false);
        expect(await h.playTicketReminder(undefined, context(ro))).toBe(true);
        expect(h.gainValue).toHaveBeenLastCalledWith(0.84, 0);
    });

    it("keeps fresh defaults independent when the first edit changes one reminder project", async () => {
        const h = await harness(null);
        h.setReminderTicketSound(mj, { volume: 17 }); await flush(); await h.restart();
        expect(core.reminderTicketSound(h.ticketSoundState.get().options, ro).volume).toBe(30);
        for (const id of core.defaultTicketSound().channelIds) expect(core.channelTicketSound(h.ticketSoundState.get().options, id).volume).toBe(30);
        expect(h.ticketSoundState.get().options.volume).toBe(30);
    });

    it("persists independent project audio/reset and preserves inherited legacy audio after a global replacement", async () => {
        const h = await harness(undefined, "running", record("legacy.wav"));
        await h.chooseReminderSound(file("mj.wav", [5, 6, 7, 8]), mj);
        await h.chooseTicketSound(file("new-legacy.wav"));
        await h.restart();
        expect(h.saved(key(mj))).toMatchObject({ name: "mj.wav", data: "BQYHCA==" });
        expect(h.saved(key(ro))).toEqual(record("legacy.wav"));
        expect(h.ticketSoundState.get().reminderAudio[mj].customName).toBe("mj.wav");
        expect(h.ticketSoundState.get().reminderAudio[ro].customName).toBe("legacy.wav");
        h.resetReminderSound(mj); await flush(); await h.restart();
        expect(h.saved(key(mj))).toBeNull();
        expect(h.ticketSoundState.get().reminderAudio[mj].customName).toBe("");
        expect(h.ticketSoundState.get().reminderAudio[ro].customName).toBe("legacy.wav");
        await h.playTicketReminder(undefined, context(mj)); await h.playTicketReminder(undefined, context(ro));
        expect(h.oscillatorStart).toHaveBeenCalledTimes(3);
        expect(h.bufferStart).toHaveBeenCalledOnce();
    });

    it("routes project traces to local configuration and never logs internal scope keys or filenames", async () => {
        const events = vi.spyOn(core, "recordTicketSoundDiagnostic");
        const h = await harness(undefined, "running", record("SECRET.wav"));
        h.setReminderTicketSound(ro, { enabled: false, volume: 0 });
        expect(await h.playTicketReminder(undefined, context(ro))).toBe(false);
        await h.testReminderSound(ro);
        expect(h.gainValue).toHaveBeenLastCalledWith(0.3, 0);
        expect(core.reminderTicketSound(h.ticketSoundState.get().options, ro)).toEqual({ enabled: false, volume: 0 });
        expect(events).toHaveBeenCalledWith("played", expect.objectContaining({ project: ro, configSource: "preview", enabled: false, volume: 30, audioState: "running" }));
        h.setReminderTicketSound(mj, { volume: 65 });
        await h.playTicketReminder(undefined, context(mj));
        expect(events).toHaveBeenCalledWith("played", expect.objectContaining({ ...context(mj), configSource: "personal", enabled: true, volume: 65 }));
        expect(JSON.stringify(events.mock.calls)).not.toMatch(/SECRET|AQIDBA|reminder:majestic|reminder:russia-online/);
    });

    it.each(["disable", "zero", "replace", "reset"] as const)("%s stops only the edited project's active audio", async action => {
        const h = await harness({ ...core.defaultTicketSound(), enabled: true }, "running", record());
        await h.playTicketReminder(undefined, context(mj)); await h.playTicketReminder(undefined, context(ro));
        await h.testTicketSound(core.defaultTicketSound().channelIds[0]);
        if (action === "disable") h.setReminderTicketSound(mj, { enabled: false });
        if (action === "zero") h.setReminderTicketSound(mj, { volume: 0 });
        if (action === "replace") await h.chooseReminderSound(file("replace.wav"), mj);
        if (action === "reset") h.resetReminderSound(mj);
        expect(h.sources[0].stop).toHaveBeenCalledOnce();
        expect(h.sources[1].stop).not.toHaveBeenCalled();
        expect(h.sources[2].stop).not.toHaveBeenCalled();
    });

    it.each(["project-edit", "global-off"] as const)("cancels pending resume on %s and clears test busy state", async action => {
        const h = await harness(); const pending = deferred<void>();
        h.resume.mockReturnValueOnce(pending.promise);
        const testing = h.testReminderSound(mj);
        if (action === "project-edit") { h.setReminderTicketSound(mj, { enabled: false }); h.setReminderTicketSound(mj, { enabled: true }); }
        else h.stopTicketReminderSound();
        pending.resolve(); await testing;
        expect(h.oscillatorStart).not.toHaveBeenCalled();
        expect(h.ticketSoundState.get().testing).toBe(false);
    });

    it("keeps another project's pending resume valid and invalidates policy while importing", async () => {
        const h = await harness(); const pending = deferred<void>(); h.resume.mockReturnValueOnce(pending.promise);
        const testing = h.testReminderSound(ro);
        h.setReminderTicketSound(mj, { volume: 0 }); pending.resolve(); await testing;
        expect(h.oscillatorStart).toHaveBeenCalledTimes(3);
        const decode = deferred<{ duration: number }>(); h.decode.mockReturnValueOnce(decode.promise);
        const selecting = h.chooseReminderSound(file(), ro); await flush();
        expect(h.reminderSoundPolicy(ro).enabled).toBe(false);
        h.resetReminderSound(ro); decode.resolve({ duration: 1 }); await selecting; await flush();
        expect(h.ticketSoundState.get().reminderAudio[ro]).toMatchObject({ loadingSound: false, customName: "" });
        expect(h.saved(key(ro))).toBeNull();
    });

    it("exposes scoped load/save errors and supports reset retry", async () => {
        const h = await harness(undefined, "running", null, {}, { majestic: { version: 99 }, "russia-online": record("ro.wav") });
        expect(h.ticketSoundState.get().reminderAudio[mj].error).not.toBe("");
        expect(h.ticketSoundState.get().reminderAudio[ro].error).toBe("");
        h.storage.set.mockRejectedValueOnce(Error("PRIVATE")); h.resetReminderSound(mj); await flush();
        expect(h.ticketSoundState.get().reminderAudio[mj].canReset).toBe(true);
        h.resetReminderSound(mj); await flush();
        expect(h.ticketSoundState.get().reminderAudio[mj]).toMatchObject({ canReset: false, error: "" });
    });
});
