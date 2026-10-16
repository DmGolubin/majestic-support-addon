/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, FluxDispatcher, SelectedChannelStore } from "@webpack/common";

import { defaultTicketSound, readTicketSound, TicketSoundGate, TicketSoundOptions } from "../core/ticketSound";
import { storage, toast } from "../platform";
import { createObservable } from "./observable";

const KEY = "SupportTemplates_ticketSound_v1";
export const ticketSoundState = createObservable({ options: defaultTicketSound(), loaded: false, error: "", testing: false });
let gate = new TicketSoundGate(Date.now());
let audio: AudioContext | null = null;
let lifecycle = 0;
let running = false;
let writes: Promise<void> = Promise.resolve();

export function setTicketSound(patch: Partial<TicketSoundOptions>) {
    if (!ticketSoundState.get().loaded) return;
    const options = readTicketSound({ ...ticketSoundState.get().options, ...patch });
    if (patch.enabled !== undefined || patch.channelIds !== undefined) gate = new TicketSoundGate(Date.now());
    ticketSoundState.set({ options, error: "" });
    writes = writes.catch(() => {}).then(() => storage.set(KEY, options));
    writes.catch(() => ticketSoundState.set({ error: "Не удалось сохранить настройки. Повторите изменение." }));
}

async function beep(test = false) {
    const gen = lifecycle;
    const { options } = ticketSoundState.get();
    if (!running || options.volume === 0) return;
    try {
        const ctx = audio ??= new AudioContext();
        // Do not queue automatic sounds for a later user gesture: they would be stale.
        if (ctx.state === "suspended" && !test) {
            ticketSoundState.set({ error: "Звук заблокирован. Нажмите «Проверить звук» в настройках тикетов." });
            return;
        }
        if (test) await ctx.resume();
        if (!running || gen !== lifecycle || ctx.state !== "running") return;
        const current = ticketSoundState.get().options;
        if ((!test && !current.enabled) || current.volume === 0) return;
        for (let i = 0; i < 3; i++) {
            const start = ctx.currentTime + i * 0.25;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "sine";
            osc.frequency.value = 660;
            gain.gain.setValueAtTime(0.3 * current.volume / 100, start);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.onended = () => { osc.disconnect(); gain.disconnect(); };
            osc.start(start);
            osc.stop(start + 0.2);
        }
        ticketSoundState.set({ error: "" });
    } catch {
        ticketSoundState.set({ error: "Не удалось воспроизвести звук. Проверьте устройство вывода Discord." });
    }
}

export async function testTicketSound() {
    if (ticketSoundState.get().testing) return;
    ticketSoundState.set({ testing: true });
    try { await beep(true); } finally { ticketSoundState.set({ testing: false }); }
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

export function startTicketSound() {
    const gen = ++lifecycle;
    running = true;
    gate = new TicketSoundGate(Date.now());
    ticketSoundState.set({ loaded: false, error: "" });
    void writes.catch(() => {}).then(() => storage.get(KEY)).then(value => {
        if (running && gen === lifecycle) ticketSoundState.set({ options: readTicketSound(value), loaded: true });
    }, () => {
        if (running && gen === lifecycle) ticketSoundState.set({ options: defaultTicketSound(), loaded: true, error: "Не удалось прочитать настройки звука." });
    });
    FluxDispatcher.subscribe("THREAD_CREATE", onThread);
    return () => {
        running = false;
        lifecycle++;
        FluxDispatcher.unsubscribe("THREAD_CREATE", onThread);
        if (audio) void audio.close().catch(() => {});
        audio = null;
    };
}
