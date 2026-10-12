/*
 * TicketSound — userplugin для Vencord
 * Звук, когда в канале #тех-поддержка появляется новый тикет
 * (новая ветка под каналом или сообщение прямо в канале).
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { SelectedChannelStore, Toasts, UserStore } from "@webpack/common";

const settings = definePluginSettings({
    channelIds: {
        type: OptionType.STRING,
        description: "ID каналов #тех-поддержка через запятую",
        default: "696711470783922247,1534231644842754090"
    },
    cooldownMs: {
        type: OptionType.NUMBER,
        description: "Минимальная пауза между звуками (мс)",
        default: 3000
    },
    debug: {
        type: OptionType.BOOLEAN,
        description: "Показывать уведомление, что вызвало звук (для диагностики)",
        default: false
    }
});

let audioCtx: AudioContext | null = null;
let lastHeadsUp = 0;

function getIds(): Set<string> {
    return new Set(String(settings.store.channelIds).split(/[\s,;]+/).filter(Boolean));
}

function beep(freq = 660, count = 3) {
    if (!audioCtx) audioCtx = new AudioContext();
    const ctx = audioCtx;
    ctx.resume();
    for (let i = 0; i < count; i++) {
        const start = ctx.currentTime + i * 0.25;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.3, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.2);
    }
}

function headsUp(channelId: string, why: string) {
    // Если именно этот канал открыт и окно в фокусе — ты и так всё видишь
    if (SelectedChannelStore.getChannelId() === channelId && document.hasFocus()) return;

    const now = Date.now();
    if (now - lastHeadsUp <= Number(settings.store.cooldownMs)) return;
    lastHeadsUp = now;

    if (settings.store.debug) {
        Toasts.show({
            message: "TicketSound: " + why,
            id: Toasts.genId(),
            type: Toasts.Type.MESSAGE
        });
    }
    beep(660, 3);
}

export default definePlugin({
    name: "TicketSound",
    description: "Звук, когда в канале #тех-поддержка появляется новый тикет",
    authors: [{ name: "you", id: 0n }],
    settings,

    flux: {
        // Сообщение прямо в канале #тех-поддержка (канал загорается)
        MESSAGE_CREATE({ message, optimistic }: { message: any; optimistic?: boolean; }) {
            if (optimistic || !message) return;
            if (message.author?.id === UserStore.getCurrentUser()?.id) return;
            if (getIds().has(message.channel_id)) headsUp(message.channel_id, "сообщение в канале");
        },

        // Новая ветка-тикет под каналом #тех-поддержка
        THREAD_CREATE({ channel }: { channel: any; }) {
            if (channel && getIds().has(channel.parent_id)) {
                headsUp(channel.id, "создана ветка " + (channel.name ?? ""));
            }
        }
    }
});
