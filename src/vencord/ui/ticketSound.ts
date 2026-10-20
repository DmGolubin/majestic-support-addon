/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, FluxDispatcher, SelectedChannelStore } from "@webpack/common";

import { CustomTicketSound, defaultTicketSound, MAX_TICKET_SOUND_BYTES, MAX_TICKET_SOUND_SECONDS, readCustomTicketSound, readTicketSound, recordTicketSoundDiagnostic, resumeTicketAudio, ticketSoundFileName, TicketSoundGate, TicketSoundOptions } from "../core/ticketSound";
import { storage, toast } from "../platform";
import { createObservable } from "./observable";

const KEY = "SupportTemplates_ticketSound_v1";
const AUDIO_KEY = "SupportTemplates_ticketSoundAudio_v1";
export const ticketSoundState = createObservable({ options: defaultTicketSound(), loaded: false, error: "", testing: false, playing: false, playbackStatus: "", customName: "", loadingSound: false, canReset: false });
let gate = new TicketSoundGate(Date.now());
let audio: AudioContext | null = null;
let customBuffer: AudioBuffer | null = null;
let lifecycle = 0;
let soundRevision = 0;
let running = false;
let settingsLoading = false;
let writes: Promise<void> = Promise.resolve();
let audioWrites: Promise<void> = Promise.resolve();
let persistenceError = "";
let audioPersistenceError = "";
let playbackError = "";
let customError = "";
let writeRevision = 0;
let audioWriteRevision = 0;
let playbackRevision = 0;
type SoundMode = "ticket" | "test" | "reminder";
const activeSources = new Map<() => void, SoundMode>();
function diagnostic(event: string, mode: SoundMode | "custom", code?: string, success?: boolean, phase?: string) {
    try { recordTicketSoundDiagnostic(event, { mode, ...(code ? { code } : {}), ...(phase ? { phase } : {}), ...(success === undefined ? {} : { success }),
        volume: ticketSoundState.get().options.volume, enabled: ticketSoundState.get().options.enabled }); } catch { /* Diagnostics cannot break audio. */ }
}
class SoundError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}

function stopPlayback() {
    playbackRevision++;
    for (const stop of [...activeSources.keys()]) stop();
    ticketSoundState.set({ playing: false, testing: false });
}
export function stopTicketSoundPlayback() {
    stopPlayback();
    ticketSoundState.set({ playbackStatus: "Воспроизведение остановлено." });
    diagnostic("test", "test", "sound_stopped");
}
export function stopTicketReminderSound() {
    for (const [stop, mode] of [...activeSources]) if (mode === "reminder") stop();
}

/** Called directly from a user gesture; automatic events never resume stale audio. */
export function prepareTicketSound(mode: "ticket" | "reminder" = "ticket"): void {
    if (!running || !ticketSoundState.get().loaded || ticketSoundState.get().options.volume === 0) return;
    const gen = lifecycle, revision = playbackRevision;
    try {
        const ctx = audio ??= new AudioContext();
        void resumeTicketAudio(ctx).then(() => {
            if (!running || gen !== lifecycle || revision !== playbackRevision) return;
            if (ctx.state !== "running") throw new Error("Audio unavailable");
            playbackError = ""; publishError();
        }).catch(() => {
            if (!running || gen !== lifecycle || revision !== playbackRevision) return;
            playbackError = "Звук заблокирован. Нажмите «Проверить звук» в настройках тикетов.";
            diagnostic("error", mode, "sound_suspended"); publishError();
        });
    } catch {
        playbackError = "Не удалось включить звук. Проверьте устройство вывода Discord.";
        diagnostic("error", mode, "sound_unavailable"); publishError();
    }
}

function publishError() {
    ticketSoundState.set({ error: [persistenceError, audioPersistenceError, customError, playbackError].filter(Boolean).join(" ") });
}

/** Slider changes write only the small options record. */
function saveSettings(): Promise<void> {
    const options = ticketSoundState.get().options;
    const revision = ++writeRevision;
    const gen = lifecycle;
    // Accepted snapshots outlive playback; a restart waits for this queue before reading.
    writes = writes.catch(() => {}).then(() => storage.set(KEY, options));
    return writes.then(() => {
        if (!running || gen !== lifecycle || revision !== writeRevision) return;
        persistenceError = "";
        publishError();
    }, () => {
        if (!running || gen !== lifecycle || revision !== writeRevision) return;
        persistenceError = "Не удалось сохранить настройки. Повторите изменение.";
        publishError();
    });
}

/** Choose/reset writes are ordered independently of options and own their errors. */
function saveAudio(sound: CustomTicketSound | null): Promise<void> {
    const revision = ++audioWriteRevision;
    const gen = lifecycle;
    audioWrites = audioWrites.catch(() => {}).then(() => storage.set(AUDIO_KEY, sound));
    return audioWrites.then(() => {
        if (!running || gen !== lifecycle || revision !== audioWriteRevision) return;
        audioPersistenceError = "";
        ticketSoundState.set({ canReset: sound !== null });
        publishError();
    }, () => {
        if (!running || gen !== lifecycle || revision !== audioWriteRevision) return;
        audioPersistenceError = "Не удалось сохранить звук. Повторите выбор файла или сброс.";
        ticketSoundState.set({ canReset: true });
        diagnostic("error", "custom", "sound_save");
        publishError();
    });
}

export function setTicketSound(patch: Partial<TicketSoundOptions>) {
    if (!running || !ticketSoundState.get().loaded) return;
    const options = readTicketSound({ ...ticketSoundState.get().options, ...patch });
    // Keep deduplication history across option edits; toggling must not replay events.
    if (options.volume === 0 || patch.enabled === false) stopPlayback();
    ticketSoundState.set({ options });
    if (options.volume === 0) ticketSoundState.set({ playbackStatus: "Громкость 0%: все звуки тикетов выключены." });
    else if (patch.volume !== undefined || patch.enabled !== undefined) ticketSoundState.set({ playbackStatus: "" });
    if (patch.enabled === true) prepareTicketSound();
    void saveSettings();
}

function encodeBytes(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
}

function decodeBytes(data: string): ArrayBuffer {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

async function decodeSound(bytes: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = audio ??= new AudioContext();
    let buffer: AudioBuffer;
    try { buffer = await ctx.decodeAudioData(bytes); } catch {
        throw new SoundError("sound_decode", "Не удалось прочитать аудио. Выберите файл MP3, WAV, OGG, M4A или FLAC.");
    }
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > MAX_TICKET_SOUND_SECONDS) {
        throw new SoundError("sound_duration", "Длительность звука должна быть больше 0 и не более 30 секунд.");
    }
    return buffer;
}

/** Resolves even on failure: the UI may call this with void; errors live in state. */
export async function chooseTicketSound(file: File): Promise<void> {
    if (!running || !ticketSoundState.get().loaded) return;
    const gen = lifecycle;
    const revision = ++soundRevision;
    stopPlayback();
    const current = () => running && gen === lifecycle && revision === soundRevision;
    customError = "";
    ticketSoundState.set({ loadingSound: true, playbackStatus: "" });
    publishError();
    diagnostic("custom", "custom", undefined, undefined, "loading");
    try {
        if (!file || !Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_TICKET_SOUND_BYTES) {
            throw new SoundError("sound_size", "Выберите непустой аудиофайл размером до 5 МБ.");
        }
        if (!/\.(mp3|wav|ogg|m4a|flac)$/i.test(file.name)) {
            throw new SoundError("sound_format", "Выберите файл MP3, WAV, OGG, M4A или FLAC.");
        }
        const bytes = await file.arrayBuffer();
        if (!current()) return;
        if (bytes.byteLength !== file.size || bytes.byteLength > MAX_TICKET_SOUND_BYTES) {
            throw new SoundError("sound_read", "Не удалось прочитать аудиофайл размером до 5 МБ.");
        }
        // decodeAudioData may detach its input, so encode the durable bytes first.
        const sound: CustomTicketSound = { version: 1, name: ticketSoundFileName(file.name), data: encodeBytes(new Uint8Array(bytes)) };
        const buffer = await decodeSound(bytes);
        if (!current()) return;
        customBuffer = buffer;
        ticketSoundState.set({ customName: sound.name, canReset: true, playbackStatus: "Свой звук загружен. Нажмите «Проверить свой звук»." });
        diagnostic("custom", "custom", undefined, true, "ready");
        await saveAudio(sound);
    } catch (error) {
        if (!current()) return;
        customError = error instanceof SoundError ? error.message : "Не удалось загрузить аудиофайл. Повторите выбор файла.";
        diagnostic("error", "custom", error instanceof SoundError ? error.code : "sound_read");
        publishError();
    } finally {
        if (current()) ticketSoundState.set({ loadingSound: false });
    }
}

/** Cancels an in-progress import immediately and persists the standard sound. */
export function resetTicketSound(): void {
    if (!running || !ticketSoundState.get().loaded) return;
    soundRevision++;
    stopPlayback();
    customBuffer = null;
    customError = "";
    ticketSoundState.set({ customName: "", loadingSound: false, playbackStatus: "Выбран стандартный звук." });
    diagnostic("custom", "custom", undefined, true, "cleared");
    publishError();
    void saveAudio(null);
}

function trackSource(source: AudioScheduledSourceNode, gain: GainNode, mode: SoundMode): () => void {
    let finished = false;
    const disconnect = (natural = false) => {
        if (finished) return;
        finished = true;
        activeSources.delete(stop);
        source.onended = null;
        try { source.disconnect(); } catch { /* Already disconnected. */ }
        try { gain.disconnect(); } catch { /* Cleanup must continue. */ }
        if (mode === "test" && ![...activeSources.values()].includes("test")) {
            ticketSoundState.set({ playing: false, ...(natural ? { playbackStatus: "Тест завершён. Если звука не было, проверьте устройство вывода и громкость Discord." } : {}) });
        }
    };
    const stop = () => {
        try { source.stop(); } catch { /* Already ended. */ }
        disconnect();
    };
    source.onended = () => disconnect(true);
    activeSources.set(stop, mode);
    return stop;
}

async function beep(mode: SoundMode = "ticket", current: () => boolean = () => true): Promise<boolean> {
    const gen = lifecycle;
    const selection = soundRevision;
    const revision = playbackRevision;
    const { options, loaded, loadingSound } = ticketSoundState.get();
    diagnostic("request", mode);
    const skip = (code: string) => { diagnostic("skipped", mode, code); return false; };
    if (!running || !loaded) return skip("sound_not_ready");
    if (loadingSound) return skip("sound_loading");
    if (options.volume === 0) return skip("sound_muted");
    const started: (() => void)[] = [];
    try {
        if (!current()) return skip("sound_cancelled");
        const ctx = audio ??= new AudioContext();
        // Do not queue automatic sounds for a later user gesture: they would be stale.
        if (ctx.state === "suspended" && mode !== "test") {
            playbackError = "Звук заблокирован. Нажмите «Проверить звук» в настройках тикетов.";
            publishError();
            return skip("sound_suspended");
        }
        if (mode === "test") await resumeTicketAudio(ctx);
        if (!running || gen !== lifecycle || selection !== soundRevision || revision !== playbackRevision || !current()) return skip("sound_cancelled");
        if (ctx.state !== "running") {
            playbackError = "Звук недоступен. Нажмите «Проверить звук» или проверьте устройство вывода Discord.";
            publishError(); return skip("sound_unavailable");
        }
        const latest = ticketSoundState.get().options;
        if (mode === "ticket" && !latest.enabled) return skip("sound_disabled");
        if (latest.volume === 0) return skip("sound_muted");
        if (customBuffer) {
            const source = ctx.createBufferSource();
            const gain = ctx.createGain();
            started.push(trackSource(source, gain, mode));
            source.buffer = customBuffer;
            gain.gain.setValueAtTime(latest.volume / 100, ctx.currentTime);
            source.connect(gain);
            gain.connect(ctx.destination);
            source.start();
        } else {
            for (let i = 0; i < 3; i++) {
                const start = ctx.currentTime + i * 0.25;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                started.push(trackSource(osc, gain, mode));
                osc.type = "sine";
                osc.frequency.value = 660;
                gain.gain.setValueAtTime(0.3 * latest.volume / 100, start);
                gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(start);
                osc.stop(start + 0.2);
            }
        }
        playbackError = "";
        diagnostic("played", mode, undefined, true);
        if (mode === "test") ticketSoundState.set({ playing: true, playbackStatus: customBuffer ? "Воспроизводится свой звук. Если его не слышно, проверьте громкость Discord." : "Воспроизводится стандартный звук. Если его не слышно, проверьте громкость Discord." });
        publishError();
        return true;
    } catch {
        for (const stop of started) stop();
        if (!running || gen !== lifecycle || revision !== playbackRevision) return skip("sound_cancelled");
        diagnostic("error", mode, "sound_playback");
        playbackError = "Не удалось воспроизвести звук. Проверьте устройство вывода Discord.";
        publishError();
        return false;
    }
}

export async function testTicketSound() {
    if (!running || ticketSoundState.get().testing) return;
    const gen = lifecycle;
    stopPlayback();
    const revision = playbackRevision;
    diagnostic("test", "test");
    ticketSoundState.set({ testing: true, playbackStatus: "" });
    try { await beep("test"); } finally {
        if (gen === lifecycle && revision === playbackRevision) ticketSoundState.set({ testing: false });
    }
}

/** True means a sound was scheduled on a running context; never resumes or shows a toast. */
export function playTicketReminder(current?: () => boolean): Promise<boolean> {
    return beep("reminder", current);
}

interface ThreadEvent {
    newlyCreated?: boolean;
    newly_created?: boolean;
    channel?: { id: string; parent_id?: string; guild_id?: string; newly_created?: boolean; thread_metadata?: { archived?: boolean; }; };
}

function onThread(e: ThreadEvent) {
    if (!running) return;
    if (!ticketSoundState.get().loaded) { diagnostic("skipped", "ticket", "sound_not_ready"); return; }
    const c = e?.channel;
    if (!c?.id || !c.parent_id) { diagnostic("skipped", "ticket", "sound_invalid"); return; }
    const guildId = c.guild_id ?? ChannelStore.getChannel(c.parent_id)?.guild_id;
    if (!guildId) { diagnostic("skipped", "ticket", "sound_guild"); return; }
    const visible = SelectedChannelStore.getChannelId() === c.id && document.hasFocus();
    const reason = gate.decide({ id: c.id, parentId: c.parent_id, guildId, newlyCreated: e.newlyCreated ?? e.newly_created ?? c.newly_created, archived: c.thread_metadata?.archived }, ticketSoundState.get().options, Date.now(), visible);
    if (reason) { diagnostic("skipped", "ticket", reason); return; }
    void beep();
    try { toast("Новый тикет в техподдержке", "message"); } catch { /* Host toast failure must not escape dispatch. */ }
}

async function loadSettings(gen: number) {
    settingsLoading = true;
    let optionsLoaded = false;
    persistenceError = audioPersistenceError = customError = "";
    publishError();
    try {
        await writes.catch(() => {});
        if (!running || gen !== lifecycle) return;
        const value = await storage.get(KEY);
        if (!running || gen !== lifecycle) return;
        ticketSoundState.set({ options: readTicketSound(value) });
        optionsLoaded = true;
    } catch {
        if (!running || gen !== lifecycle) return;
        persistenceError = "Не удалось прочитать настройки звука.";
        ticketSoundState.set({ options: defaultTicketSound() });
    }
    try {
        customBuffer = null;
        ticketSoundState.set({ customName: "", canReset: false });
        await audioWrites.catch(() => {});
        if (!running || gen !== lifecycle) return;
        const stored = await storage.get(AUDIO_KEY);
        if (!running || gen !== lifecycle) return;
        if (stored != null) {
            ticketSoundState.set({ canReset: true });
            try {
                const sound = readCustomTicketSound(stored);
                if (!sound) throw new Error("Сохранённый аудиофайл повреждён. Выберите файл заново.");
                ticketSoundState.set({ loadingSound: true });
                const buffer = await decodeSound(decodeBytes(sound.data));
                if (!running || gen !== lifecycle) return;
                customBuffer = buffer;
                ticketSoundState.set({ customName: sound.name });
            } catch {
                if (!running || gen !== lifecycle) return;
                customError = "Не удалось загрузить сохранённый звук. Используется стандартный; выберите файл заново.";
            }
        }
    } catch {
        if (!running || gen !== lifecycle) return;
        audioPersistenceError = "Не удалось прочитать сохранённый звук.";
    } finally {
        if (running && gen === lifecycle) {
            settingsLoading = false;
            // A failed read is not an empty record: keep all edits blocked until retry succeeds.
            ticketSoundState.set({ loaded: optionsLoaded, loadingSound: false });
            publishError();
        }
    }
}

/** Retry failed reads without replacing the runtime or invalidating its stop callback. */
export function retryTicketSoundSettings(): void {
    if (!running || settingsLoading || ticketSoundState.get().loaded) return;
    void loadSettings(lifecycle);
}

function stopRuntime() {
    running = false;
    lifecycle++;
    soundRevision++;
    try { FluxDispatcher?.unsubscribe?.("THREAD_CREATE", onThread); } catch {
        // An unavailable/lazy host dispatcher must not prevent audio cleanup.
    }
    stopPlayback();
    try { if (audio) void audio.close().catch(() => {}); } catch { /* Host context already disposed. */ }
    audio = null;
    customBuffer = null;
    ticketSoundState.set({ loaded: false, loadingSound: false, testing: false, playing: false, playbackStatus: "", customName: "", canReset: false });
}

export function startTicketSound() {
    if (running) stopRuntime();
    const gen = ++lifecycle;
    running = true;
    settingsLoading = false;
    gate = new TicketSoundGate(Date.now());
    persistenceError = audioPersistenceError = playbackError = customError = "";
    ticketSoundState.set({ loaded: false, error: "", customName: "", loadingSound: false });
    void loadSettings(gen);
    try { FluxDispatcher?.subscribe?.("THREAD_CREATE", onThread); } catch {
        // Settings and manual playback remain available without thread events.
    }
    return () => {
        if (gen === lifecycle) stopRuntime();
    };
}
