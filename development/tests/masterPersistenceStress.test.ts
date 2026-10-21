import { File } from "node:buffer";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as soundCore from "../src/core/ticketSound";
import { createPanelPreferencesStorage } from "../src/core/panelPreferences";
import { Store, STORE_KEY } from "../src/core/state";

// Production runtime + observable, with only Discord/storage/audio dependencies replaced.
const compile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const runtimeCode = compile("../src/vencord/ui/ticketSound.ts");
const observableCode = compile("../src/vencord/ui/observable.ts");
const KEY = "SupportTemplates_ticketSound_v1";
const AUDIO_KEY = "SupportTemplates_ticketSoundAudio_v1";
const ACCOUNT = "123456789012345678";
const PREF_KEY = "SupportTemplates_panel_preferences_v1_" + ACCOUNT;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); });

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function memory(entries: [string, unknown][] = []) {
    const data = new Map(entries.map(([key, value]) => [key, structuredClone(value)]));
    return {
        data,
        get: vi.fn(async (key: string) => structuredClone(data.get(key))),
        set: vi.fn(async (key: string, value: unknown) => { data.set(key, structuredClone(value)); }),
    };
}

interface SoundState {
    options: soundCore.TicketSoundOptions;
    loaded: boolean;
    loadingSound: boolean;
    customName: string;
    error: string;
    testing: boolean;
}
interface Runtime {
    startTicketSound(): () => void;
    setTicketSound(patch: Partial<soundCore.TicketSoundOptions>): void;
    chooseTicketSound(file: File): Promise<void>;
    resetTicketSound(): void;
    retryTicketSoundSettings(): void;
    testTicketSound(): Promise<void>;
    ticketSoundState: { get(): SoundState; };
}
const record = (name = "persisted.wav") => ({ version: 1, name, data: "AQIDBA==" });
const file = (name = "chosen.wav") => new File([new Uint8Array([1, 2, 3, 4])], name);

function harness(storage = memory([[KEY, soundCore.defaultTicketSound()], [AUDIO_KEY, null]]), dispatcher: unknown = { subscribe: vi.fn(), unsubscribe: vi.fn() }) {
    const decode = vi.fn(async (_bytes: ArrayBuffer) => ({ duration: 1 }));
    const contexts: FakeAudio[] = [];
    const sources: { stop: ReturnType<typeof vi.fn>; }[] = [];
    class FakeAudio {
        state = "running";
        currentTime = 0;
        destination = {};
        decodeAudioData = decode;
        resume = vi.fn(async () => {});
        close = vi.fn(async () => { this.state = "closed"; });
        constructor() { contexts.push(this); }
        createBufferSource() {
            const source = { buffer: null, connect() {}, disconnect() {}, start() {}, stop: vi.fn() };
            sources.push(source);
            return source;
        }
        createOscillator() { return { ...this.createBufferSource(), frequency: { value: 0 } }; }
        createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    }
    const common = {
        ChannelStore: { getChannel: vi.fn() }, SelectedChannelStore: { getChannelId: vi.fn() },
        FluxDispatcher: dispatcher,
    };
    const observable = {};
    runInNewContext(observableCode, { exports: observable, require: () => common });
    const deps: Record<string, unknown> = {
        "@webpack/common": common, "../core/ticketSound": soundCore,
        "../platform": { storage, toast: vi.fn() }, "./observable": observable,
    };
    const runtime = {} as Runtime;
    runInNewContext(runtimeCode, {
        exports: runtime,
        require: (id: string) => { if (!(id in deps)) throw new Error(`Unexpected dependency ${id}`); return deps[id]; },
        AudioContext: FakeAudio, btoa, atob,
    });
    let stop = () => {};
    const start = async () => { stop = runtime.startTicketSound(); cleanups.push(stop); await flush(); };
    return { ...runtime, storage, decode, contexts, sources, common, start, stop: () => stop() };
}

describe("Master QA 14: production persistence stress", () => {
    it.each(["healthy", "absent", "missing methods", "throwing methods", "throwing unsubscribe", "throwing method proxy", "throwing export getter"])(
        "start/stop stays idempotent and cleans audio with %s dispatcher", async mode => {
            const failing = () => { throw new Error("dispatcher unavailable"); };
            const subscribe = vi.fn(mode === "throwing methods" ? failing : () => {});
            const unsubscribe = vi.fn(mode === "throwing methods" || mode === "throwing unsubscribe" ? failing : () => {});
            const dispatcher = mode === "absent" ? undefined : mode === "missing methods" ? {}
                : mode === "throwing method proxy" ? new Proxy({}, { get: failing }) : { subscribe, unsubscribe };
            const h = harness(undefined, dispatcher);
            // An explicit undefined otherwise uses the harness default.
            if (mode === "absent") h.common.FluxDispatcher = undefined;
            if (mode === "throwing export getter") Object.defineProperty(h.common, "FluxDispatcher", { get: failing });
            await expect(h.start()).resolves.toBeUndefined();
            expect(h.ticketSoundState.get().loaded).toBe(true);
            await h.chooseTicketSound(file()); await h.testTicketSound();
            // A repeated start retires the old runtime and still completes initialization.
            await expect(h.start()).resolves.toBeUndefined();
            expect(h.ticketSoundState.get()).toMatchObject({ loaded: true, customName: "chosen.wav" });
            await h.testTicketSound();
            expect(() => { h.stop(); h.stop(); }).not.toThrow();
            expect(h.ticketSoundState.get()).toMatchObject({ loaded: false, testing: false });
            expect(h.contexts).toHaveLength(2);
            expect(h.sources).toHaveLength(2);
            for (const context of h.contexts) expect(context.close).toHaveBeenCalledOnce();
            for (const source of h.sources) expect(source.stop).toHaveBeenCalledOnce();
            if (mode === "healthy" || mode === "throwing methods" || mode === "throwing unsubscribe") {
                expect(subscribe).toHaveBeenCalledTimes(2);
                expect(unsubscribe).toHaveBeenCalledTimes(2);
            }
        },
    );

    it("serializes 100 rapid options changes independently of a blocked audio write and reloads the final state", async () => {
        const h = harness(); await h.start();
        const pending = deferred<void>();
        const save = h.storage.set.getMockImplementation()!;
        h.storage.set.mockImplementation(async (key, value) => { if (key === AUDIO_KEY) await pending.promise; await save(key, value); });
        const choosing = h.chooseTicketSound(file()); await flush();
        for (let volume = 1; volume <= 100; volume++) h.setTicketSound({ volume, quietWhenVisible: volume % 2 === 0 });
        await flush();
        expect(h.storage.set.mock.calls.filter(([key]) => key === KEY)).toHaveLength(100);
        expect(h.storage.set.mock.calls.filter(([key]) => key === AUDIO_KEY)).toHaveLength(1);
        expect(h.storage.set.mock.calls.filter(([key]) => key === KEY).map(([, value]) => (value as soundCore.TicketSoundOptions).volume)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
        expect(h.storage.data.get(KEY)).toMatchObject({ volume: 100, quietWhenVisible: true });
        pending.resolve(); await choosing;
        h.stop();
        const reloaded = harness(h.storage); await reloaded.start();
        expect(reloaded.ticketSoundState.get()).toMatchObject({ loaded: true, customName: "chosen.wav", options: { volume: 100 }, error: "" });
        expect(reloaded.decode).toHaveBeenCalledOnce();
    });

    it("audio saves proceed while options are blocked; 100 queued options never overlap", async () => {
        const h = harness(); await h.start();
        const pending = deferred<void>();
        let active = 0, maxActive = 0;
        const save = h.storage.set.getMockImplementation()!;
        h.storage.set.mockImplementation(async (key, value) => {
            if (key === KEY) { active++; maxActive = Math.max(active, maxActive); await pending.promise; }
            await save(key, value);
            if (key === KEY) active--;
        });
        for (let volume = 1; volume <= 100; volume++) h.setTicketSound({ volume });
        await flush();
        await h.chooseTicketSound(file());
        expect(h.storage.data.get(AUDIO_KEY)).toMatchObject({ name: "chosen.wav" });
        expect(h.storage.set.mock.calls.filter(([key]) => key === KEY)).toHaveLength(1);
        pending.resolve(); await flush();
        expect(maxActive).toBe(1);
        expect(h.storage.set.mock.calls.filter(([key]) => key === KEY)).toHaveLength(100);
        expect(h.storage.data.get(KEY)).toMatchObject({ volume: 100 });
    });

    it("recovers through five intermittent failures in 100 rapid options writes", async () => {
        const h = harness(); await h.start();
        const save = h.storage.set.getMockImplementation()!;
        let attempted = 0, failed = 0;
        h.storage.set.mockImplementation(async (key, value) => {
            if (++attempted % 17 === 0) { failed++; throw new Error("synthetic disk failure"); }
            await save(key, value);
        });
        for (let volume = 1; volume <= 100; volume++) h.setTicketSound({ volume });
        await flush();
        expect({ attempted, failed }).toEqual({ attempted: 100, failed: 5 });
        expect(h.storage.data.get(KEY)).toMatchObject({ volume: 100 });
        expect(h.ticketSoundState.get().error).toBe("");
    });

    it("keeps a failed final write visible across a sound test and permits retry", async () => {
        const h = harness(); await h.start();
        const save = h.storage.set.getMockImplementation()!;
        let count = 0;
        h.storage.set.mockImplementation(async (key, value) => { if (++count === 100) throw new Error("quota"); await save(key, value); });
        for (let volume = 1; volume <= 100; volume++) h.setTicketSound({ volume });
        await flush(); await h.testTicketSound();
        expect(h.storage.data.get(KEY)).toMatchObject({ volume: 99 });
        expect(h.ticketSoundState.get().error).toContain("Не удалось сохранить настройки");
        h.setTicketSound({ volume: 100 }); await flush();
        expect(count).toBe(101);
        expect(h.ticketSoundState.get().error).toBe("");
        expect(h.storage.data.get(KEY)).toMatchObject({ volume: 100 });
    });

    it("persists 100 completed choose/reset operations and survives a fresh module reload", async () => {
        const h = harness(); await h.start();
        for (let i = 0; i < 50; i++) {
            await h.chooseTicketSound(file(`sound-${i}.wav`));
            h.resetTicketSound(); await flush();
        }
        expect(h.storage.set.mock.calls.filter(([key]) => key === AUDIO_KEY)).toHaveLength(100);
        expect(h.storage.set.mock.calls.filter(([key]) => key === KEY)).toHaveLength(0);
        expect(h.decode).toHaveBeenCalledTimes(50);
        h.stop();
        const reloaded = harness(h.storage); await reloaded.start();
        expect(reloaded.ticketSoundState.get()).toMatchObject({ customName: "", loaded: true, error: "" });
        expect(reloaded.decode).not.toHaveBeenCalled();
    });

    it("shows a failed audio reset independently of 100 successful options saves", async () => {
        const storage = memory([[KEY, soundCore.defaultTicketSound()], [AUDIO_KEY, record()]]);
        const h = harness(storage); await h.start();
        storage.set.mockRejectedValueOnce(new Error("quota"));
        h.resetTicketSound(); await flush();
        for (let volume = 1; volume <= 100; volume++) h.setTicketSound({ volume });
        await flush();
        expect(h.ticketSoundState.get().error).toContain("Не удалось сохранить звук");
        expect(storage.data.get(AUDIO_KEY)).toEqual(record());
        h.resetTicketSound(); await flush();
        expect(storage.data.get(AUDIO_KEY)).toBeNull();
        expect(h.ticketSoundState.get().error).toBe("");
        expect(storage.set.mock.calls.filter(([key]) => key === KEY)).toHaveLength(100);
        expect(storage.set).toHaveBeenLastCalledWith(AUDIO_KEY, null);
        for (const id of soundCore.defaultTicketSound().channelIds)
            expect(storage.data.get(`${AUDIO_KEY}_channel_${id}`)).toEqual(record());
    });

    it.each([null, "bad JSON", [], { volume: Infinity, enabled: "true", channelIds: ["bad"], cooldownMs: NaN }])(
        "normalizes corrupt options without writing them on load: %j", async value => {
            const storage = memory([[KEY, value]]); const h = harness(storage); await h.start();
            expect(h.ticketSoundState.get().options).toEqual(soundCore.readTicketSound(value));
            expect(storage.set).not.toHaveBeenCalled();
            expect(storage.data.get(KEY)).toEqual(value);
        },
    );

    it.each(["not-base64", "file:///audio.wav", "data:audio/wav;base64,AQIDBA==", "===="])(
        "preserves corrupt audio and falls back without decoding: %s", async data => {
            const value = { ...record(), data };
            const storage = memory([[KEY, soundCore.defaultTicketSound()], [AUDIO_KEY, value]]);
            const h = harness(storage); await h.start();
            expect(h.ticketSoundState.get()).toMatchObject({ loaded: true, customName: "" });
            expect(h.ticketSoundState.get().error).toContain("сохранённый звук");
            expect(h.decode).not.toHaveBeenCalled();
            expect(storage.set).not.toHaveBeenCalled();
            expect(storage.data.get(AUDIO_KEY)).toEqual(value);
        },
    );

    it("ignores a stale decode across stop/start and closes active audio", async () => {
        const h = harness(); await h.start();
        const pending = deferred<{ duration: number; }>();
        h.decode.mockReturnValueOnce(pending.promise);
        const choosing = h.chooseTicketSound(file("stale.wav")); await flush();
        h.stop(); await h.start();
        pending.resolve({ duration: 1 }); await choosing;
        expect(h.storage.set).not.toHaveBeenCalled();
        expect(h.ticketSoundState.get()).toMatchObject({ loaded: true, customName: "", loadingSound: false });
        await h.chooseTicketSound(file("current.wav")); await h.testTicketSound();
        h.stop();
        expect(h.contexts).toHaveLength(2);
        for (const context of h.contexts) expect(context.close).toHaveBeenCalledOnce();
        expect(h.sources).toHaveLength(1);
        expect(h.sources[0].stop).toHaveBeenCalledOnce();
    });

    it("14-01: stop drains all 100 accepted changes before restart reads options", async () => {
        const h = harness(); await h.start();
        const pending = deferred<void>();
        const save = h.storage.set.getMockImplementation()!;
        h.storage.set.mockImplementationOnce(async (key, value) => { await pending.promise; await save(key, value); });
        h.setTicketSound({ volume: 1 }); await flush();
        for (let volume = 2; volume <= 100; volume++) h.setTicketSound({ volume });
        expect(h.ticketSoundState.get().options.volume).toBe(100);
        h.stop(); const restarting = h.start();
        pending.resolve(); await restarting; await flush();
        expect(h.storage.set).toHaveBeenCalledTimes(100);
        expect(h.ticketSoundState.get()).toMatchObject({ loaded: true, options: { volume: 100 }, error: "" });
    });

    it("14-01: reset followed immediately by stop persists standard audio before restart", async () => {
        const storage = memory([[KEY, soundCore.defaultTicketSound()], [AUDIO_KEY, record()]]);
        const h = harness(storage); await h.start();
        h.resetTicketSound();
        expect(h.ticketSoundState.get().customName).toBe("");
        h.stop(); await h.start();
        expect(storage.set.mock.calls.filter(([key]) => key === AUDIO_KEY)).toEqual([[AUDIO_KEY, null]]);
        for (const id of soundCore.defaultTicketSound().channelIds)
            expect(storage.data.get(`${AUDIO_KEY}_channel_${id}`)).toEqual(record());
        expect(storage.data.get(AUDIO_KEY)).toBeNull();
        expect(h.ticketSoundState.get()).toMatchObject({ customName: "", loaded: true, error: "" });
    });

    it("14-02: failed options read blocks writes until explicit retry preserves the saved preferences", async () => {
        const original = { enabled: true, volume: 73, channelIds: ["123456789012345678"], quietWhenVisible: false, cooldownMs: 12000 };
        const storage = memory([[KEY, original], [AUDIO_KEY, null]]);
        storage.get.mockRejectedValueOnce(new Error("transient read failure"));
        const h = harness(storage); await h.start();
        expect(storage.data.get(KEY)).toEqual(original);
        expect(h.ticketSoundState.get()).toMatchObject({ loaded: false });
        expect(h.ticketSoundState.get().error).toContain("Не удалось прочитать настройки");
        h.setTicketSound({ volume: 80 }); await flush();
        expect(storage.set).not.toHaveBeenCalled();
        expect(storage.data.get(KEY)).toEqual(original);
        expect(h.ticketSoundState.get().error).toContain("Не удалось прочитать настройки");
        h.retryTicketSoundSettings(); await flush();
        expect(h.ticketSoundState.get()).toMatchObject({ loaded: true, options: original, error: "" });
        expect(storage.set).not.toHaveBeenCalled();
        h.setTicketSound({ volume: 80 }); await flush();
        const migrated = { ...soundCore.readTicketSound(original), volume: 80 };
        expect(storage.set).toHaveBeenCalledExactlyOnceWith(KEY, migrated);
        expect(h.ticketSoundState.get().error).toBe("");
        h.stop();
        expect(h.ticketSoundState.get().loaded).toBe(false); // Original stop callback remains valid after retry.
        const reloaded = harness(storage); await reloaded.start();
        expect(reloaded.ticketSoundState.get().options).toEqual(migrated);
    });

    it("deduplicates options retries, keeps repeated failure blocked, and ignores completion after stop", async () => {
        const h = harness();
        h.storage.get.mockRejectedValueOnce(new Error("initial read")); await h.start();
        h.storage.get.mockRejectedValueOnce(new Error("retry read"));
        h.retryTicketSoundSettings(); await flush();
        expect(h.ticketSoundState.get().loaded).toBe(false);
        expect(h.ticketSoundState.get().error).toContain("Не удалось прочитать настройки");
        const pending = deferred<unknown>();
        h.storage.get.mockClear();
        h.storage.get.mockReturnValueOnce(pending.promise);
        h.retryTicketSoundSettings(); h.retryTicketSoundSettings(); await flush();
        expect(h.storage.get).toHaveBeenCalledTimes(1);
        expect(h.ticketSoundState.get()).toMatchObject({ loaded: false, error: "" });
        h.setTicketSound({ volume: 99 }); h.resetTicketSound();
        await h.chooseTicketSound(file()); await h.testTicketSound();
        expect(h.storage.set).not.toHaveBeenCalled();
        expect(h.sources).toHaveLength(0);
        h.stop();
        pending.resolve({ ...soundCore.defaultTicketSound(), volume: 99 }); await flush();
        expect(h.ticketSoundState.get().loaded).toBe(false);
        expect(h.ticketSoundState.get().options.volume).toBe(30);
        h.retryTicketSoundSettings(); await flush();
        expect(h.storage.get).toHaveBeenCalledTimes(1);
        await h.start();
        expect(h.ticketSoundState.get()).toMatchObject({ loaded: true, error: "", options: { volume: 30 } });
    });

    it("100 account-preference writes across adapters preserve invocation snapshots and await queued reads", async () => {
        const storage = memory(); const pending = deferred<void>();
        const save = storage.set.getMockImplementation()!;
        storage.set.mockImplementationOnce(async (key, value) => { await pending.promise; await save(key, value); });
        const adapters = [createPanelPreferencesStorage(storage, ACCOUNT), createPanelPreferencesStorage(storage, ACCOUNT)];
        const writes: Promise<void>[] = [];
        for (let i = 1; i <= 100; i++) {
            const source = { favorites: [`faq:majestic:${i}`], usage: { [`faq:majestic:${i}`]: { n: i, last: i } } };
            writes.push(adapters[i % 2].set(STORE_KEY, source));
            source.favorites.length = 0;
        }
        const read = createPanelPreferencesStorage(storage, ACCOUNT).get(STORE_KEY);
        await flush(); expect(storage.set).toHaveBeenCalledTimes(1); expect(storage.get).not.toHaveBeenCalled();
        pending.resolve(); await Promise.all(writes);
        expect(await read).toMatchObject({ favorites: ["faq:majestic:100"], usage: { "faq:majestic:100": { n: 100, last: 100 } } });
        expect(storage.set).toHaveBeenCalledTimes(100);
        for (const [i, [, value]] of storage.set.mock.calls.entries()) expect(value).toMatchObject({ favorites: [`faq:majestic:${i + 1}`] });
    });

    it("Store flush retains 100 accepted preference snapshots across close, rejects later retired writes", async () => {
        const storage = memory();
        const store = new Store(createPanelPreferencesStorage(storage, ACCOUNT), true);
        for (let i = 1; i <= 100; i++) { store.data.previewOpen = i % 2 === 0; store.savePanelPreferences(); }
        store.closePanelPreferences(); store.data.previewOpen = false; store.savePanelPreferences();
        await store.flush();
        expect(storage.set).toHaveBeenCalledTimes(100);
        expect(storage.data.get(PREF_KEY)).toMatchObject({ previewOpen: true });
        expect(await createPanelPreferencesStorage(storage, ACCOUNT).get(STORE_KEY)).toMatchObject({ previewOpen: true });
    });

    it.each([null, "bad JSON", [], { v: 999, favorites: ["faq:majestic:1"] }])(
        "reads malformed account preferences without writing back: %j", async value => {
            const storage = memory([[PREF_KEY, value]]);
            const preferences = createPanelPreferencesStorage(storage, ACCOUNT);
            expect(await preferences.get(STORE_KEY)).toMatchObject({ v: 1, favorites: [], prefix: ";", previewOpen: false });
            expect(storage.data.get(PREF_KEY)).toEqual(value);
            expect(storage.set).not.toHaveBeenCalled();
        },
    );
});
