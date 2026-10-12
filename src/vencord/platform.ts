/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { insertTextIntoChatInputBox } from "@utils/discord";
import { ChannelStore, FluxDispatcher, SelectedChannelStore, SelectedGuildStore, showToast } from "@webpack/common";

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
        navigator.clipboard?.writeText(text).catch(err => console.error("[SupportTemplates] clipboard write failed", err));
        toast("Не удалось вставить — текст скопирован, вставьте Ctrl+V", "failure");
        return false;
    }
}

export const currentGuildId = (): string | null => SelectedGuildStore.getGuildId() ?? null;

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
    showToast(msg, type);
}

/** The Slate editor that has focus, else the main chat editor. */
export function activeEditor(): HTMLElement | null {
    const focused = document.activeElement?.closest?.('[data-slate-editor="true"]') as HTMLElement | null;
    return focused ?? document.querySelector('main [role="textbox"][data-slate-editor="true"], [role="textbox"][data-slate-editor="true"]');
}

export function chatAreaRect(): DOMRect | null {
    // The box of the active editor (a thread in the side panel has its own), else the first one.
    const el = activeEditor()?.closest('[class*="channelTextArea"]') ?? document.querySelector('[class*="channelTextArea"]');
    return el ? el.getBoundingClientRect() : null;
}

export async function readClipboard(): Promise<string> {
    try { return await navigator.clipboard.readText(); } catch (e) { console.error("[SupportTemplates] clipboard read failed", e); return ""; }
}
