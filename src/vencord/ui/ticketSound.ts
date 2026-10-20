/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, FluxDispatcher, SelectedChannelStore } from "@webpack/common";

import { channelTicketSound, ChannelTicketSoundOptions, reminderTicketSound, REMINDER_SOUND_PROJECTS, ReminderSoundProject, ReminderSoundOptions, CustomTicketSound, defaultTicketSound, MAX_TICKET_SOUND_BYTES, MAX_TICKET_SOUND_SECONDS, readCustomTicketSound, readTicketSound, recordTicketSoundDiagnostic, resumeTicketAudio, ticketSoundFileName, TicketSoundContext, TicketSoundGate, TicketSoundOptions } from "../core/ticketSound";
import { storage } from "../platform";
import { createObservable } from "./observable";

const KEY = "SupportTemplates_ticketSound_v1";
const AUDIO_KEY = "SupportTemplates_ticketSoundAudio_v1";
interface ChannelAudioState { customName: string; loadingSound: boolean; canReset: boolean; error: string; }
const emptyChannelAudio = (): ChannelAudioState => ({ customName: "", loadingSound: false, canReset: false, error: "" });
const emptyReminderAudio = (): Record<ReminderSoundProject, ChannelAudioState> => ({ majestic: emptyChannelAudio(), "russia-online": emptyChannelAudio() });
export const ticketSoundState = createObservable({ options: defaultTicketSound(), loaded: false, error: "", testing: false, playing: false, playbackStatus: "", customName: "", loadingSound: false, canReset: false, channelAudio: {} as Record<string, ChannelAudioState>, reminderAudio: emptyReminderAudio() });
const channelBuffers = new Map<string, AudioBuffer>();
const channelRevisions = new Map<string, number>();
const channelImports = new Map<string, number>();
const inheritedChannelAudio = new Map<string, CustomTicketSound | null>();
// Successful writes, including those drained after shutdown, outrank migration snapshots.
const channelPersistenceVersions = new Map<string, number>();
let channelWrites: Promise<void> = Promise.resolve();
const reminderScope = (project: ReminderSoundProject) => `reminder:${project}`;
const scopeProject = (id?: string): ReminderSoundProject | undefined => REMINDER_SOUND_PROJECTS.find(project => reminderScope(project) === id);
const channelAudioKey = (id: string) => scopeProject(id) ? `${AUDIO_KEY}_reminder_${scopeProject(id)}` : `${AUDIO_KEY}_channel_${id}`;
function scopeOptions(id?: string) {
    const options = ticketSoundState.get().options;
    const project = scopeProject(id);
    return project ? reminderTicketSound(options, project) : id ? channelTicketSound(options, id) : options;
}
function scopeAudio(id: string) {
    const state = ticketSoundState.get(), project = scopeProject(id);
    return project ? state.reminderAudio[project] : state.channelAudio[id];
}
const audioScopes = () => [...ticketSoundState.get().options.channelIds, ...REMINDER_SOUND_PROJECTS.map(reminderScope)];
function updateChannelAudio(id: string, patch: Partial<ChannelAudioState>) {
    const project = scopeProject(id);
    if (project) {
        const { reminderAudio } = ticketSoundState.get();
        ticketSoundState.set({ reminderAudio: { ...reminderAudio, [project]: { ...(reminderAudio[project] ?? emptyChannelAudio()), ...patch } } });
        return;
    }
    const { channelAudio } = ticketSoundState.get();
    ticketSoundState.set({ channelAudio: { ...channelAudio, [id]: { ...(channelAudio[id] ?? emptyChannelAudio()), ...patch } } });
}
function knownChannel(id: string): boolean { return ticketSoundState.get().options.channelIds.includes(id) && /^\d{17,20}$/.test(id); }
const knownAudioScope = (id: string) => !!scopeProject(id) || knownChannel(id);
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
let testParentId: string | undefined;
type SoundMode = "ticket" | "test" | "reminder";
const activeSources = new Map<() => void, { mode: SoundMode; parentId?: string; }>();
function diagnostic(event: string, mode: SoundMode | "custom", code?: string, success?: boolean, phase?: string, context: TicketSoundContext = {}, parentId?: string, preview = false) {
    const options = scopeOptions(parentId);
    try { recordTicketSoundDiagnostic(event, { mode, ...(code ? { code } : {}), ...(phase ? { phase } : {}), ...(success === undefined ? {} : { success }),
        ticketId: context.ticketId, channelId: scopeProject(context.channelId ?? undefined) ? undefined : context.channelId, guildId: context.guildId, waitingCycleId: context.waitingCycleId,
        reminderId: context.reminderId, cycle: context.cycle, project: scopeProject(parentId) ?? context.project, configSource: preview ? "preview" : scopeProject(parentId) ? "personal" : parentId ? "channel" : "global",
        audioState: audio?.state ?? "absent", volume: preview && options.volume === 0 ? 30 : options.volume,
        ...(parentId || mode === "ticket" ? { enabled: options.enabled } : {}) }); } catch { /* Diagnostics cannot break audio. */ }
}
class SoundError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}

function stopPlayback(parentId?: string, all = false) {
    if (parentId) channelRevisions.set(parentId, (channelRevisions.get(parentId) ?? 0) + 1);
    else playbackRevision++;
    if (all) for (const id of audioScopes()) channelRevisions.set(id, (channelRevisions.get(id) ?? 0) + 1);
    for (const [stop, source] of [...activeSources]) if (all || source.parentId === parentId) stop();
    if (all || parentId === testParentId) ticketSoundState.set({ playing: false, testing: false });
}
export function stopTicketSoundPlayback() {
    stopPlayback(undefined, true);
    ticketSoundState.set({ playbackStatus: "Воспроизведение остановлено." });
    diagnostic("test", "test", "sound_stopped");
}
export function stopTicketReminderSound() {
    for (const project of REMINDER_SOUND_PROJECTS) stopPlayback(reminderScope(project));
    for (const [stop, source] of [...activeSources]) if (source.mode === "reminder") stop();
}

/** Called directly from a user gesture; automatic events never resume stale audio. */
export function prepareTicketSound(mode: "ticket" | "reminder" = "ticket", parentId?: string): void {
    if (mode === "reminder" && !parentId) {
        const project = REMINDER_SOUND_PROJECTS.find(project => {
            const config = reminderTicketSound(ticketSoundState.get().options, project);
            return config.enabled && config.volume > 0;
        });
        if (!project) return;
        parentId = reminderScope(project);
    }
    const options = scopeOptions(parentId);
    if (!running || !ticketSoundState.get().loaded || options.volume === 0) return;
    const gen = lifecycle, revision = parentId ? channelRevisions.get(parentId) ?? 0 : playbackRevision;
    const current = () => running && gen === lifecycle && revision === (parentId ? channelRevisions.get(parentId) ?? 0 : playbackRevision);
    try {
        const ctx = audio ??= new AudioContext();
        void resumeTicketAudio(ctx).then(() => {
            if (!current()) return;
            if (ctx.state !== "running") throw new Error("Audio unavailable");
            playbackError = ""; publishError();
        }).catch(() => {
            if (!current()) return;
            playbackError = "Звук заблокирован. Нажмите «Проверить звук» в настройках тикетов.";
            diagnostic("error", mode, "sound_suspended", false, undefined, {}, parentId); publishError();
        });
    } catch {
        playbackError = "Не удалось включить звук. Проверьте устройство вывода Discord.";
        diagnostic("error", mode, "sound_unavailable", false, undefined, {}, parentId); publishError();
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
    // Freeze legacy channel copies before changing the old shared (now reminder) record.
    const inherited = [...inheritedChannelAudio].map(([id, value]) => ({ id, value, version: channelPersistenceVersions.get(id) ?? 0 }));
    const preserve = channelWrites = channelWrites.catch(() => {}).then(async () => {
        for (const { id, value, version } of inherited) {
            if (version !== (channelPersistenceVersions.get(id) ?? 0)) continue;
            await storage.set(channelAudioKey(id), value);
            channelPersistenceVersions.set(id, version + 1);
            if (gen === lifecycle && inheritedChannelAudio.get(id) === value) inheritedChannelAudio.delete(id);
        }
    });
    audioWrites = audioWrites.catch(() => {}).then(() => preserve).then(() => storage.set(AUDIO_KEY, sound));
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
    if (patch.volume !== undefined || patch.enabled === false) stopPlayback();
    ticketSoundState.set({ options });
    if (options.volume === 0) ticketSoundState.set({ playbackStatus: "Громкость 0%: личные напоминания выключены." });
    else if (patch.volume !== undefined || patch.enabled !== undefined) ticketSoundState.set({ playbackStatus: "" });
    if (patch.enabled === true) prepareTicketSound();
    void saveSettings();
}

export function setChannelTicketSound(parentId: string, patch: Partial<ChannelTicketSoundOptions>): void {
    const state = ticketSoundState.get();
    if (!running || !state.loaded || !knownChannel(parentId)) return;
    const options = readTicketSound({ ...state.options, channels: { ...state.options.channels, [parentId]: { ...channelTicketSound(state.options, parentId), ...patch } } });
    // Edits invalidate only this parent's pending and active sounds, including previews.
    stopPlayback(parentId);
    ticketSoundState.set({ options, playbackStatus: "" });
    if (patch.enabled === true) prepareTicketSound("ticket", parentId);
    void saveSettings();
}

/** Local audio eligibility only; the reminder controller separately owns API/session guards. */
export function reminderSoundPolicy(project: ReminderSoundProject) {
    const state = ticketSoundState.get(), scope = reminderScope(project);
    const config = reminderTicketSound(state.options, project);
    return {
        enabled: REMINDER_SOUND_PROJECTS.includes(project) && running && state.loaded && config.enabled && config.volume > 0 && !scopeAudio(scope)?.loadingSound,
        revision: `${lifecycle}:${channelRevisions.get(scope) ?? 0}`,
    };
}

export function setReminderTicketSound(project: ReminderSoundProject, patch: Partial<ReminderSoundOptions>): void {
    const state = ticketSoundState.get();
    if (!running || !state.loaded || !REMINDER_SOUND_PROJECTS.includes(project)) return;
    const options = readTicketSound({ ...state.options, reminders: {
        ...state.options.reminders, [project]: { ...reminderTicketSound(state.options, project), ...patch },
    } });
    stopPlayback(reminderScope(project));
    ticketSoundState.set({ options, playbackStatus: "" });
    if (patch.enabled === true) prepareTicketSound("reminder", reminderScope(project));
    void saveSettings();
}

export function chooseReminderSound(file: File, project: ReminderSoundProject): Promise<void> {
    return REMINDER_SOUND_PROJECTS.includes(project) ? chooseChannelSound(file, reminderScope(project)) : Promise.resolve();
}
export function resetReminderSound(project: ReminderSoundProject): void {
    if (REMINDER_SOUND_PROJECTS.includes(project)) resetTicketSound(reminderScope(project));
}
export function testReminderSound(project: ReminderSoundProject): Promise<void> {
    return REMINDER_SOUND_PROJECTS.includes(project) ? testTicketSound(reminderScope(project)) : Promise.resolve();
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
export async function chooseTicketSound(file: File, parentId?: string): Promise<void> {
    if (parentId !== undefined) return chooseChannelSound(file, parentId);
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
export function resetTicketSound(parentId?: string): void {
    if (parentId !== undefined) {
        if (!running || !ticketSoundState.get().loaded || !knownAudioScope(parentId)) return;
        channelImports.set(parentId, (channelImports.get(parentId) ?? 0) + 1);
        stopPlayback(parentId);
        channelBuffers.delete(parentId);
        updateChannelAudio(parentId, { customName: "", loadingSound: false, error: "" });
        diagnostic("custom", "custom", undefined, true, "cleared", { channelId: parentId }, parentId);
        void saveChannelAudio(parentId, null);
        return;
    }
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

async function saveChannelAudio(parentId: string, sound: CustomTicketSound | null) {
    const gen = lifecycle, revision = channelImports.get(parentId);
    // Remove only when the ordered write succeeds, so a failed change remains retryable.
    channelWrites = channelWrites.catch(() => {}).then(async () => {
        await storage.set(channelAudioKey(parentId), sound);
        channelPersistenceVersions.set(parentId, (channelPersistenceVersions.get(parentId) ?? 0) + 1);
        if (gen === lifecycle) inheritedChannelAudio.delete(parentId);
    });
    try {
        await channelWrites;
        if (!running || gen !== lifecycle || revision !== channelImports.get(parentId)) return;
        updateChannelAudio(parentId, { canReset: sound !== null, error: "" });
    } catch {
        if (!running || gen !== lifecycle || revision !== channelImports.get(parentId)) return;
        updateChannelAudio(parentId, { canReset: true, error: "Не удалось сохранить звук канала. Повторите выбор или сброс." });
        diagnostic("error", "custom", "sound_save", false, undefined, { channelId: parentId }, parentId);
    }
}

async function chooseChannelSound(file: File, parentId: string): Promise<void> {
    if (!running || !ticketSoundState.get().loaded || !knownAudioScope(parentId)) return;
    const gen = lifecycle, revision = (channelImports.get(parentId) ?? 0) + 1;
    channelImports.set(parentId, revision);
    stopPlayback(parentId);
    const current = () => running && gen === lifecycle && revision === channelImports.get(parentId);
    updateChannelAudio(parentId, { loadingSound: true, error: "" });
    diagnostic("custom", "custom", undefined, undefined, "loading", { channelId: parentId }, parentId);
    try {
        if (!file || !Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_TICKET_SOUND_BYTES)
            throw new SoundError("sound_size", "Выберите непустой аудиофайл размером до 5 МБ.");
        if (!/\.(mp3|wav|ogg|m4a|flac)$/i.test(file.name))
            throw new SoundError("sound_format", "Выберите файл MP3, WAV, OGG, M4A или FLAC.");
        const bytes = await file.arrayBuffer();
        if (!current()) return;
        if (bytes.byteLength !== file.size || bytes.byteLength > MAX_TICKET_SOUND_BYTES)
            throw new SoundError("sound_read", "Не удалось прочитать аудиофайл размером до 5 МБ.");
        const sound: CustomTicketSound = { version: 1, name: ticketSoundFileName(file.name), data: encodeBytes(new Uint8Array(bytes)) };
        const buffer = await decodeSound(bytes);
        if (!current()) return;
        channelBuffers.set(parentId, buffer);
        updateChannelAudio(parentId, { customName: sound.name, canReset: true });
        diagnostic("custom", "custom", undefined, true, "ready", { channelId: parentId }, parentId);
        await saveChannelAudio(parentId, sound);
    } catch (error) {
        if (!current()) return;
        updateChannelAudio(parentId, { error: error instanceof SoundError ? error.message : "Не удалось загрузить звук канала. Повторите выбор." });
        diagnostic("error", "custom", error instanceof SoundError ? error.code : "sound_read", false, undefined, { channelId: parentId }, parentId);
    } finally {
        if (current()) updateChannelAudio(parentId, { loadingSound: false });
    }
}

function trackSource(source: AudioScheduledSourceNode, gain: GainNode, mode: SoundMode, context: TicketSoundContext, parentId?: string): () => void {
    let finished = false;
    const disconnect = (natural = false) => {
        if (finished) return;
        finished = true;
        activeSources.delete(stop);
        source.onended = null;
        try { source.disconnect(); } catch { /* Already disconnected. */ }
        try { gain.disconnect(); } catch { /* Cleanup must continue. */ }
        diagnostic("result", mode, undefined, natural, natural ? "ended" : "stopped", context, parentId, mode === "test" && !!parentId);
        if (mode === "test" && ![...activeSources.values()].some(source => source.mode === "test")) {
            ticketSoundState.set({ playing: false, ...(natural ? { playbackStatus: "Тест завершён. Если звука не было, проверьте устройство вывода и громкость Discord." } : {}) });
        }
    };
    const stop = () => {
        try { source.stop(); } catch { /* Already ended. */ }
        disconnect();
    };
    source.onended = () => disconnect(true);
    activeSources.set(stop, { mode, parentId });
    return stop;
}

async function beep(mode: SoundMode = "ticket", current: () => boolean = () => true, context: TicketSoundContext = {}, parentId?: string): Promise<boolean> {
    const gen = lifecycle;
    const selection = soundRevision;
    const revision = parentId ? channelRevisions.get(parentId) ?? 0 : playbackRevision;
    const unchanged = () => revision === (parentId ? channelRevisions.get(parentId) ?? 0 : playbackRevision) && (parentId || selection === soundRevision);
    const state = ticketSoundState.get();
    const options = scopeOptions(parentId);
    const loadingSound = parentId ? scopeAudio(parentId)?.loadingSound : state.loadingSound;
    const preview = mode === "test" && !!parentId;
    const trace = (event: string, code?: string, success?: boolean, phase?: string) => diagnostic(event, mode, code, success, phase, context, parentId, preview);
    trace("request");
    const skip = (code: string) => { trace("skipped", code, false); return false; };
    if (!running || !state.loaded) return skip("sound_not_ready");
    if (loadingSound) return skip("sound_loading");
    if (options.volume === 0 && !preview) return skip("sound_muted");
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
        if (!running || gen !== lifecycle || !unchanged() || !current()) return skip("sound_cancelled");
        if (ctx.state !== "running") {
            playbackError = "Звук недоступен. Нажмите «Проверить звук» или проверьте устройство вывода Discord.";
            publishError(); return skip("sound_unavailable");
        }
        const latest = scopeOptions(parentId);
        if ((mode === "ticket" || mode === "reminder" && !!scopeProject(parentId)) && !latest.enabled) return skip("sound_disabled");
        if (latest.volume === 0 && !preview) return skip("sound_muted");
        const volume = latest.volume === 0 && preview ? 30 : latest.volume;
        const buffer = parentId ? channelBuffers.get(parentId) : customBuffer;
        if (buffer) {
            const source = ctx.createBufferSource();
            const gain = ctx.createGain();
            started.push(trackSource(source, gain, mode, context, parentId));
            source.buffer = buffer;
            gain.gain.setValueAtTime(volume / 100, ctx.currentTime);
            source.connect(gain);
            gain.connect(ctx.destination);
            source.start();
        } else {
            for (let i = 0; i < 3; i++) {
                const start = ctx.currentTime + i * 0.25;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                started.push(trackSource(osc, gain, mode, context, parentId));
                osc.type = "sine";
                osc.frequency.value = 660;
                gain.gain.setValueAtTime(0.3 * volume / 100, start);
                gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(start);
                osc.stop(start + 0.2);
            }
        }
        playbackError = "";
        trace("played", undefined, true, "start");
        if (mode === "test") ticketSoundState.set({ playing: true, playbackStatus: `${buffer ? "Воспроизводится свой звук." : "Воспроизводится стандартный звук."}${preview && (!latest.enabled || latest.volume === 0) ? ` Проверка при выключенном ${scopeProject(parentId) ? "проекте" : "канале"}: ${Math.round(volume)}%, настройки не изменены.` : ""} Если его не слышно, проверьте громкость Discord.` });
        publishError();
        return true;
    } catch {
        for (const stop of started) stop();
        if (!running || gen !== lifecycle || !unchanged()) return skip("sound_cancelled");
        trace("error", "sound_playback", false);
        playbackError = "Не удалось воспроизвести звук. Проверьте устройство вывода Discord.";
        publishError();
        return false;
    }
}

export async function testTicketSound(parentId?: string) {
    if (!running || ticketSoundState.get().testing) return;
    if (parentId !== undefined && !knownAudioScope(parentId)) return;
    const gen = lifecycle;
    stopPlayback(parentId);
    testParentId = parentId;
    const revision = parentId ? channelRevisions.get(parentId) : playbackRevision;
    diagnostic("test", "test", undefined, undefined, undefined, { channelId: parentId }, parentId, !!parentId);
    ticketSoundState.set({ testing: true, playbackStatus: "" });
    try { await beep("test", undefined, { channelId: parentId }, parentId); } finally {
        if (gen === lifecycle && revision === (parentId ? channelRevisions.get(parentId) : playbackRevision)) ticketSoundState.set({ testing: false });
    }
}

/** True means a sound was scheduled on a running context; never resumes or shows a toast. */
export function playTicketReminder(current?: () => boolean, ticket?: TicketSoundContext): Promise<boolean> {
    const project = ticket?.project;
    if (project !== undefined && !REMINDER_SOUND_PROJECTS.includes(project)) return Promise.resolve(false);
    return beep("reminder", current, ticket, project ? reminderScope(project) : undefined);
}

interface ThreadEvent {
    newlyCreated?: boolean;
    newly_created?: boolean;
    channel?: { id: string; parent_id?: string; guild_id?: string; newly_created?: boolean; thread_metadata?: { archived?: boolean; }; };
}

function onThread(e: ThreadEvent) {
    if (!running) return;
    const c = e?.channel;
    const guildId = c?.guild_id ?? (c?.parent_id ? ChannelStore.getChannel(c.parent_id)?.guild_id : undefined);
    const context = { ticketId: c?.id, channelId: c?.parent_id, guildId };
    diagnostic("input", "ticket", undefined, undefined, undefined, context, c?.parent_id);
    const skip = (code: string) => diagnostic("skipped", "ticket", code, false, undefined, context, c?.parent_id);
    if (!ticketSoundState.get().loaded) { skip("sound_not_ready"); return; }
    if (!c?.id || !c.parent_id) { skip("sound_invalid"); return; }
    if (!guildId) { skip("sound_guild"); return; }
    const visible = SelectedChannelStore.getChannelId() === c.id && document.hasFocus();
    const reason = gate.decide({ id: c.id, parentId: c.parent_id, guildId, newlyCreated: e.newlyCreated ?? e.newly_created ?? c.newly_created, archived: c.thread_metadata?.archived }, ticketSoundState.get().options, Date.now(), visible);
    if (reason) { skip(reason); return; }
    void beep("ticket", undefined, context, c.parent_id);
}

async function loadSettings(gen: number) {
    settingsLoading = true;
    let optionsLoaded = false;
    let legacySound: CustomTicketSound | null = null;
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
                legacySound = sound;
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
            try {
                await channelWrites.catch(() => {});
                if (!running || gen !== lifecycle) return;
                channelBuffers.clear();
                inheritedChannelAudio.clear();
                ticketSoundState.set({ channelAudio: {}, reminderAudio: emptyReminderAudio() });
                for (const id of audioScopes()) {
                    const stored = await storage.get(channelAudioKey(id));
                    if (!running || gen !== lifecycle) return;
                    updateChannelAudio(id, emptyChannelAudio());
                    if (stored === undefined) inheritedChannelAudio.set(id, legacySound);
                    const raw = stored === undefined ? legacySound : stored;
                    if (raw != null) {
                        updateChannelAudio(id, { canReset: true });
                        try {
                            const sound = readCustomTicketSound(raw);
                            if (!sound) throw new Error("Invalid audio");
                            const buffer = stored === undefined && customBuffer ? customBuffer : await decodeSound(decodeBytes(sound.data));
                            if (!running || gen !== lifecycle) return;
                            channelBuffers.set(id, buffer);
                            updateChannelAudio(id, { customName: sound.name });
                        } catch {
                            if (!running || gen !== lifecycle) return;
                            updateChannelAudio(id, { error: "Не удалось загрузить звук канала. Используется стандартный; выберите файл заново." });
                            diagnostic("error", "custom", "sound_decode", false, undefined, { channelId: id }, id);
                        }
                    }
                }
            } catch {
                if (!running || gen !== lifecycle) return;
                optionsLoaded = false;
                persistenceError = "Не удалось прочитать настройки звука каналов. Повторите загрузку.";
            }
            if (!running || gen !== lifecycle) return;
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
    stopPlayback(undefined, true);
    try { if (audio) void audio.close().catch(() => {}); } catch { /* Host context already disposed. */ }
    audio = null;
    customBuffer = null;
    channelBuffers.clear();
    channelImports.clear();
    channelRevisions.clear();
    inheritedChannelAudio.clear();
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
