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
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); });
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
}
interface Runtime {
    startTicketSound(): () => void;
    setTicketSound(patch: Partial<core.TicketSoundOptions>): void;
    chooseTicketSound(file: File): Promise<void>;
    resetTicketSound(): void;
    testTicketSound(): Promise<void>;
    playTicketReminder(current?: () => boolean): Promise<boolean>;
    ticketSoundState: { get(): SoundState; };
}
const file = (name = "ping.mp3", bytes = [1, 2, 3, 4]) => new File([new Uint8Array(bytes)], name, { type: "audio/mpeg" });
const record = (name = "saved.wav") => ({ version: 1, name, data: "AQIDBA==" });

async function harness(initial: unknown = core.defaultTicketSound(), initialAudioState = "running", initialSound: unknown = null) {
    const saved = new Map<string, unknown>([[KEY, initial], [AUDIO_KEY, initialSound]]);
    const storage = {
        get: vi.fn(async (key: string) => saved.get(key)),
        set: vi.fn(async (key: string, value: unknown) => { saved.set(key, value); }),
    };
    const decode = vi.fn(async (_bytes: ArrayBuffer) => ({ duration: 1 }));
    const bufferStart = vi.fn();
    const oscillatorStart = vi.fn();
    const gainValue = vi.fn();
    const resume = vi.fn(async () => {});
    const sources: { stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; }[] = [];
    const contexts: FakeAudioContext[] = [];
    const toast = vi.fn();
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
            FluxDispatcher: { subscribe: vi.fn(), unsubscribe: vi.fn() },
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
    return { ...exports, stop, restart, storage, decode, contexts, sources, bufferStart, oscillatorStart, gainValue, resume, toast, saved: (key = KEY) => saved.get(key) };
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
            expect(Object.keys(value as object).sort()).toEqual(Object.keys(core.defaultTicketSound()).sort());
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
        expect(h.storage.set).toHaveBeenCalledOnce();
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
        expect(h.saved()).toEqual({ ...core.defaultTicketSound(), volume: 81 });
        expect(h.saved(AUDIO_KEY)).toBeNull();
        await h.restart();
        expect(h.ticketSoundState.get()).toMatchObject({ customName: "", loadingSound: false, options: { volume: 81 } });
    });

    it("drains queued resets after stop while ignoring stale error publication", async () => {
        const h = await harness();
        const pending = deferred<void>();
        h.storage.set.mockReturnValueOnce(pending.promise);
        const importing = h.chooseTicketSound(file());
        await flush();
        h.resetTicketSound();
        h.stop();
        pending.reject(new Error("late save error"));
        await importing;
        await flush();
        expect(h.storage.set).toHaveBeenCalledTimes(2);
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
