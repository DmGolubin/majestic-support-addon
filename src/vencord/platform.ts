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

/** One INSERT_TEXT into the focused chat box. Never sends. false = failed, text copied to the clipboard. */
export function insertText(text: string): boolean {
    try {
        insertTextIntoChatInputBox(text);
        return true;
    } catch (e) {
        console.error("[SupportTemplates] insert failed", e);
        // Report the copy only once it really happened: a refused clipboard must not promise Ctrl+V.
        const copy = navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("no clipboard"));
        copy.then(
            () => toast("Не удалось вставить — текст скопирован, вставьте Ctrl+V", "failure"),
            err => {
                console.error("[SupportTemplates] clipboard write failed", err);
                toast("Не удалось вставить и скопировать текст — откройте шаблон в окне и скопируйте вручную", "failure");
            },
        );
        return false;
    }
}

export const currentGuildId = (): string | null => SelectedGuildStore.getGuildId() ?? null;

export const guildName = (id: string) => GuildStore.getGuild(id)?.name ?? "";

export function currentChannel() {
    const id = SelectedChannelStore.getChannelId() ?? null;
    const ch = id ? ChannelStore.getChannel(id) : null;
    return { id, name: ch?.name ?? "", guildId: ch?.guild_id ?? null };
}

/** fn gets the new channel's guild id (null in DMs) from the CHANNEL_SELECT payload. */
export function onChannelChange(fn: (guildId: string | null) => void) {
    const h = (e: { guildId?: string | null; }) => fn(e?.guildId ?? null);
    FluxDispatcher.subscribe("CHANNEL_SELECT", h);
    return () => FluxDispatcher.unsubscribe("CHANNEL_SELECT", h);
}

export function toast(msg: string, type: "message" | "success" | "failure" = "message") {
    showToast({ text: msg, variant: type === "failure" ? "critical" : type === "success" ? "success" : "default" });
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
