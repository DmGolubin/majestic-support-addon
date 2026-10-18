/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { insertTextIntoChatInputBox } from "@utils/discord";
import { AccessibilityStore, ChannelStore, FluxDispatcher, GuildStore, LocaleStore, SelectedChannelStore, SelectedGuildStore, showToast, ThemeStore } from "@webpack/common";

import { StorageLike } from "./core/state";

export const storage: StorageLike = {
    get: key => DataStore.get(key),
    set: (key, value) => DataStore.set(key, value),
};

const unavailable = new Set<string>();
let noticeGeneration = 0;
function hostValue<T>(capability: string, read: () => T, fallback: T): T {
    try {
        const value = read();
        unavailable.delete(capability);
        return value;
    } catch {
        if (!unavailable.has(capability)) {
            unavailable.add(capability);
            toast("Часть функций Discord недоступна — повторите действие после обновления клиента.", "failure");
        }
        return fallback;
    }
}

/** One INSERT_TEXT into the focused chat box. Never sends. false = failed; copying is best effort. */
export function insertText(text: string): boolean {
    try {
        insertTextIntoChatInputBox(text);
        return true;
    } catch (e) {
        console.error("[SupportTemplates] insert failed", e);
        const generation = noticeGeneration;
        toast("Не удалось вставить текст — откройте шаблон в окне для ручного копирования", "failure");
        // Report the copy only once it really happened: a refused clipboard must not promise Ctrl+V.
        const copy = Promise.resolve().then(() => {
            if (generation !== noticeGeneration) return;
            if (typeof navigator.clipboard?.writeText !== "function") throw new Error("no clipboard");
            return navigator.clipboard.writeText(text);
        });
        copy.then(
            () => { if (generation === noticeGeneration) toast("Не удалось вставить — текст скопирован, вставьте Ctrl+V", "failure"); },
            err => {
                if (generation !== noticeGeneration) return;
                console.error("[SupportTemplates] clipboard write failed", err);
                toast("Не удалось вставить и скопировать текст — откройте шаблон в окне и скопируйте вручную", "failure");
            },
        );
        return false;
    }
}

export const currentGuildId = (): string | null => hostValue("guild", () => {
    if (unavailable.has("channel-events")) return null;
    const id = SelectedGuildStore.getGuildId();
    // A missing channel store must not leave a stale selected guild enabling insertion.
    return typeof id === "string" && currentChannel().guildId === id ? id : null;
}, null);

export const guildName = (id: string): string => hostValue("guild-name", () => GuildStore.getGuild(id)?.name ?? "", "");

export function currentChannel() {
    return hostValue("channel", () => {
        const id = SelectedChannelStore.getChannelId();
        const ch = typeof id === "string" ? ChannelStore.getChannel(id) : null;
        return { id: ch ? id : null, name: ch?.name ?? "", guildId: ch?.guild_id ?? null };
    }, { id: null, name: "", guildId: null });
}

/** fn gets the new channel's guild id (null in DMs) from the CHANNEL_SELECT payload. */
export function onChannelChange(fn: (guildId: string | null) => void) {
    const h = (e: { guildId?: string | null; }) => fn(e?.guildId ?? null);
    return hostValue("channel-events", () => {
        const dispatcher = FluxDispatcher;
        // Resolve both methods before subscribing, including potentially throwing lazy proxies.
        const subscribe = dispatcher.subscribe.bind(dispatcher);
        const unsubscribe = dispatcher.unsubscribe.bind(dispatcher);
        let active = true;
        const handler = (e: { guildId?: string | null; }) => { if (active) h(e); };
        try { subscribe("CHANNEL_SELECT", handler); }
        catch (error) {
            active = false;
            try { unsubscribe("CHANNEL_SELECT", handler); } catch { /* Partial subscription: callback is inert. */ }
            throw error;
        }
        return () => {
            if (!active) return;
            active = false;
            hostValue("channel-events-cleanup", () => unsubscribe("CHANNEL_SELECT", handler), undefined);
        };
    }, () => {});
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
export function disposePlatformNotices() {
    noticeGeneration++;
    clearTimeout(noticeTimer);
    noticeTimer = undefined;
    unavailable.clear();
    try { document.getElementById("vc-stx-compat-notice")?.remove(); } catch { /* DOM may already be gone. */ }
}

export function toast(msg: string, type: "message" | "success" | "failure" = "message") {
    try {
        showToast({ text: msg, variant: type === "failure" ? "critical" : type === "success" ? "success" : "default" });
    } catch {
        // Reporting must remain usable without Discord's toast module or any clipboard bridge.
        try {
            const notice = document.getElementById("vc-stx-compat-notice") ?? document.createElement("div");
            notice.id = "vc-stx-compat-notice";
            notice.setAttribute("role", "status");
            notice.textContent = msg;
            Object.assign(notice.style, { position: "fixed", bottom: "24px", left: "24px", zIndex: "2147483647", maxWidth: "420px", padding: "12px", background: "#202225", color: "#fff", borderRadius: "6px" });
            if (!notice.isConnected) document.body.append(notice);
            clearTimeout(noticeTimer);
            noticeTimer = setTimeout(() => notice.remove(), 8000);
        } catch { console.error("[SupportTemplates]", msg); }
    }
}

/** The Slate editor that has focus, else the main chat editor. */
export function activeEditor(): HTMLElement | null {
    const focused = document.activeElement?.closest?.('[data-slate-editor="true"]') as HTMLElement | null;
    return focused ?? document.querySelector('main [role="textbox"][data-slate-editor="true"], [role="textbox"][data-slate-editor="true"]');
}

/** The box of `editor` (default: the active one; a thread in the side panel has its own), else the first one. */
export function chatAreaEl(editor: HTMLElement | null = activeEditor()): Element | null {
    const ed = editor?.isConnected ? editor : activeEditor();
    return ed?.closest('[class*="channelTextArea"]') ?? document.querySelector('[class*="channelTextArea"]');
}

export function chatAreaRect(editor?: HTMLElement | null): DOMRect | null {
    return chatAreaEl(editor ?? undefined)?.getBoundingClientRect() ?? null;
}

export async function readClipboard(): Promise<string | null> {
    try {
        // Desktop Discord exposes its native clipboard; the web API can be denied in Electron.
        if (typeof DiscordNative !== "undefined" && typeof DiscordNative.clipboard?.read === "function") {
            const text = DiscordNative.clipboard.read();
            if (typeof text === "string") return text;
        }
    } catch { /* Fall back to the browser adapter when the native bridge is unavailable. */ }
    try { return await navigator.clipboard.readText(); } catch {
        console.error("[SupportTemplates] clipboard read failed");
        return null;
    }
}

/** Discord's zoom / font size / locale / theme for the debug report; null where a store is not available. */
export function discordEnv(): { zoom: number | null; fontSize: number | null; locale: string | null; theme: string | null; } {
    const safe = <T>(f: () => T): T | null => { try { return f() ?? null; } catch { return null; } };
    return {
        zoom: safe(() => AccessibilityStore.zoom),
        fontSize: safe(() => AccessibilityStore.fontSize),
        locale: safe(() => LocaleStore.locale),
        theme: safe(() => String(ThemeStore.theme)),
    };
}
