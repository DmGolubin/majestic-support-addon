/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, FluxDispatcher, SelectedChannelStore } from "@webpack/common";

import { CustomTicketSound, defaultTicketSound, MAX_TICKET_SOUND_BYTES, MAX_TICKET_SOUND_SECONDS, readCustomTicketSound, readTicketSound, ticketSoundFileName, TicketSoundGate, TicketSoundOptions } from "../core/ticketSound";
import { storage, toast } from "../platform";
import { createObservable } from "./observable";

const KEY = "SupportTemplates_ticketSound_v1";
const AUDIO_KEY = "SupportTemplates_ticketSoundAudio_v1";
export const ticketSoundState = createObservable({ options: defaultTicketSound(), loaded: false, error: "", testing: false, customName: "", loadingSound: false });
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
const activeSources = new Set<() => void>();

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
        publishError();
    }, () => {
        if (!running || gen !== lifecycle || revision !== audioWriteRevision) return;
        audioPersistenceError = "Не удалось сохранить звук. Повторите выбор файла или сброс.";
        publishError();
    });
}

export function setTicketSound(patch: Partial<TicketSoundOptions>) {
    if (!running || !ticketSoundState.get().loaded) return;
    const options = readTicketSound({ ...ticketSoundState.get().options, ...patch });
    if (patch.enabled !== undefined || patch.channelIds !== undefined) gate = new TicketSoundGate(Date.now());
    ticketSoundState.set({ options });
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
        throw new Error("Не удалось прочитать аудио. Выберите файл MP3, WAV, OGG, M4A или FLAC.");
    }
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > MAX_TICKET_SOUND_SECONDS) {
        throw new Error("Длительность звука должна быть от 0 до 30 секунд.");
    }
    return buffer;
}

/** Resolves even on failure: the UI may call this with void; errors live in state. */
export async function chooseTicketSound(file: File): Promise<void> {
    if (!running || !ticketSoundState.get().loaded) return;
    const gen = lifecycle;
    const revision = ++soundRevision;
    const current = () => running && gen === lifecycle && revision === soundRevision;
    customError = "";
    ticketSoundState.set({ loadingSound: true });
    publishError();
    try {
        if (!file || !Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_TICKET_SOUND_BYTES) {
            throw new Error("Выберите непустой аудиофайл размером до 5 МБ.");
        }
        if (!/\.(mp3|wav|ogg|m4a|flac)$/i.test(file.name)) {
            throw new Error("Выберите файл MP3, WAV, OGG, M4A или FLAC.");
        }
        const bytes = await file.arrayBuffer();
        if (!current()) return;
        if (bytes.byteLength !== file.size || bytes.byteLength > MAX_TICKET_SOUND_BYTES) {
            throw new Error("Не удалось прочитать аудиофайл размером до 5 МБ.");
        }
        // decodeAudioData may detach its input, so encode the durable bytes first.
        const sound: CustomTicketSound = { version: 1, name: ticketSoundFileName(file.name), data: encodeBytes(new Uint8Array(bytes)) };
        const buffer = await decodeSound(bytes);
        if (!current()) return;
        customBuffer = buffer;
        ticketSoundState.set({ customName: sound.name });
        await saveAudio(sound);
    } catch (error) {
        if (!current()) return;
        customError = error instanceof Error ? error.message : "Не удалось загрузить аудиофайл.";
        publishError();
    } finally {
        if (current()) ticketSoundState.set({ loadingSound: false });
    }
}

/** Cancels an in-progress import immediately and persists the standard sound. */
export function resetTicketSound(): void {
    if (!running || !ticketSoundState.get().loaded) return;
    soundRevision++;
    customBuffer = null;
    customError = "";
    ticketSoundState.set({ customName: "", loadingSound: false });
    publishError();
    void saveAudio(null);
}

function trackSource(source: AudioScheduledSourceNode, gain: GainNode): () => void {
    const disconnect = () => {
        activeSources.delete(stop);
        source.disconnect();
        gain.disconnect();
    };
    const stop = () => {
        try { source.stop(); } catch { /* Already ended. */ }
        disconnect();
    };
    source.onended = disconnect;
    activeSources.add(stop);
    return stop;
}

async function beep(mode: "ticket" | "test" | "reminder" = "ticket", current: () => boolean = () => true): Promise<boolean> {
    const gen = lifecycle;
    const selection = soundRevision;
    const { options, loaded, loadingSound } = ticketSoundState.get();
    if (!running || !loaded || loadingSound || options.volume === 0) return false;
    const started: (() => void)[] = [];
    try {
        if (!current()) return false;
        const ctx = audio ??= new AudioContext();
        // Do not queue automatic sounds for a later user gesture: they would be stale.
        if (ctx.state === "suspended" && mode !== "test") {
            playbackError = "Звук заблокирован. Нажмите «Проверить звук» в настройках тикетов.";
            publishError();
            return false;
        }
        if (mode === "test") await ctx.resume();
        if (!running || gen !== lifecycle || selection !== soundRevision || ctx.state !== "running" || !current()) return false;
        const latest = ticketSoundState.get().options;
        if ((mode === "ticket" && !latest.enabled) || latest.volume === 0) return false;
        if (customBuffer) {
            const source = ctx.createBufferSource();
            const gain = ctx.createGain();
            started.push(trackSource(source, gain));
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
                started.push(trackSource(osc, gain));
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
        publishError();
        return true;
    } catch {
        for (const stop of started) stop();
        if (!running || gen !== lifecycle) return false;
        playbackError = "Не удалось воспроизвести звук. Проверьте устройство вывода Discord.";
        publishError();
        return false;
    }
}

export async function testTicketSound() {
    if (!running || ticketSoundState.get().testing) return;
    const gen = lifecycle;
    ticketSoundState.set({ testing: true });
    try { await beep("test"); } finally {
        if (gen === lifecycle) ticketSoundState.set({ testing: false });
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
    if (!running || !ticketSoundState.get().loaded || !ticketSoundState.get().options.enabled) return;
    const c = e.channel;
    if (!c?.id || !c.parent_id) return;
    const guildId = c.guild_id ?? ChannelStore.getChannel(c.parent_id)?.guild_id;
    if (!guildId) return;
    const visible = SelectedChannelStore.getChannelId() === c.id && document.hasFocus();
    if (!gate.accept({ id: c.id, parentId: c.parent_id, guildId, newlyCreated: e.newlyCreated ?? e.newly_created ?? c.newly_created, archived: c.thread_metadata?.archived }, ticketSoundState.get().options, Date.now(), visible)) return;
    void beep();
    toast("Новый тикет в техподдержке", "message");
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
        ticketSoundState.set({ customName: "" });
        await audioWrites.catch(() => {});
        if (!running || gen !== lifecycle) return;
        const stored = await storage.get(AUDIO_KEY);
        if (!running || gen !== lifecycle) return;
        if (stored != null) {
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
    for (const stop of activeSources) stop();
    if (audio) void audio.close().catch(() => {});
    audio = null;
    customBuffer = null;
    ticketSoundState.set({ loaded: false, loadingSound: false, testing: false, customName: "" });
}

export function startTicketSound() {
    if (running) stopRuntime();
    const gen = ++lifecycle;
    running = true;
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
