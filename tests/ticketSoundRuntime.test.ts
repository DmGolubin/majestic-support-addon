import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as core from "../src/core/ticketSound";

// Execute the production runtime module, replacing only its host dependencies.
const code = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/ticketSound.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const SAVE_ERROR = "Не удалось сохранить настройки. Повторите изменение.";
const AUDIO_ERROR = "Не удалось воспроизвести звук. Проверьте устройство вывода Discord.";
const KEY = "SupportTemplates_ticketSound_v1";
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); });

interface Runtime {
    startTicketSound(): () => void;
    setTicketSound(patch: Partial<core.TicketSoundOptions>): void;
    testTicketSound(): Promise<void>;
    ticketSoundState: { get(): { options: core.TicketSoundOptions; loaded: boolean; error: string; testing: boolean; }; };
}

async function harness() {
    let saved = { ...core.defaultTicketSound(), enabled: true };
    const storage = {
        get: vi.fn(async (key: string) => key === KEY ? saved : undefined),
        set: vi.fn(async (_key: string, options: core.TicketSoundOptions) => { saved = options; }),
    };
    const resume = vi.fn(async () => {});
    const oscillatorStart = vi.fn();
    class FakeAudioContext {
        state = "running";
        currentTime = 0;
        destination = {};
        resume = resume;
        close = vi.fn(async () => {});
        createOscillator() {
            return { frequency: { value: 0 }, connect() {}, disconnect() {}, start: oscillatorStart, stop() {} };
        }
        createGain() {
            return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
        }
    }
    const dependencies: Record<string, unknown> = {
        "@webpack/common": {
            ChannelStore: { getChannel: vi.fn() },
            SelectedChannelStore: { getChannelId: vi.fn() },
            FluxDispatcher: { subscribe: vi.fn(), unsubscribe: vi.fn() },
        },
        "../core/ticketSound": core,
        "../platform": { storage, toast: vi.fn() },
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
    });
    cleanups.push(exports.startTicketSound());
    await flush();
    expect(exports.ticketSoundState.get().loaded).toBe(true);
    return { ...exports, storage, resume, oscillatorStart, saved: () => saved };
}

describe("ticket sound runtime error ownership", () => {
    it("keeps a failed-save warning after a successful sound test", async () => {
        const h = await harness();
        h.storage.set.mockRejectedValueOnce(new Error("write failed"));
        h.setTicketSound({ volume: 75 });
        await flush();
        expect(h.ticketSoundState.get().error).toBe(SAVE_ERROR);

        await h.testTicketSound();

        expect(h.resume).toHaveBeenCalledOnce();
        expect(h.oscillatorStart).toHaveBeenCalledTimes(3);
        expect(h.ticketSoundState.get()).toMatchObject({ error: SAVE_ERROR, testing: false, options: { volume: 75 } });
        expect(h.saved().volume).toBe(30);
        expect(h.storage.set).toHaveBeenCalledTimes(1);
        expect(h.storage.set).toHaveBeenCalledWith(KEY, expect.objectContaining({ volume: 75 }));
    });

    it("clears only the persistence error after a later successful write", async () => {
        const h = await harness();
        h.storage.set.mockRejectedValueOnce(new Error("write failed"));
        h.setTicketSound({ volume: 75 });
        await flush();
        h.resume.mockRejectedValueOnce(new Error("audio failed"));
        await h.testTicketSound();
        expect(h.ticketSoundState.get().error).toBe(`${SAVE_ERROR} ${AUDIO_ERROR}`);

        h.setTicketSound({ volume: 60 });
        expect(h.ticketSoundState.get().error).toBe(`${SAVE_ERROR} ${AUDIO_ERROR}`);
        await flush();

        expect(h.storage.set).toHaveBeenCalledTimes(2);
        expect(h.saved().volume).toBe(60);
        expect(h.ticketSoundState.get().error).toBe(AUDIO_ERROR);
        await h.testTicketSound();
        expect(h.oscillatorStart).toHaveBeenCalledTimes(3);
        expect(h.ticketSoundState.get().error).toBe("");
    });

    it("does not hide an audio error when starting or completing a successful save", async () => {
        const h = await harness();
        h.resume.mockRejectedValueOnce(new Error("audio failed"));
        await h.testTicketSound();
        expect(h.ticketSoundState.get()).toMatchObject({ error: AUDIO_ERROR, testing: false });
        expect(h.oscillatorStart).not.toHaveBeenCalled();

        h.setTicketSound({ quietWhenVisible: false });
        expect(h.ticketSoundState.get().error).toBe(AUDIO_ERROR);
        await flush();

        expect(h.saved().quietWhenVisible).toBe(false);
        expect(h.storage.set).toHaveBeenCalledOnce();
        expect(h.ticketSoundState.get().error).toBe(AUDIO_ERROR);
    });
});
