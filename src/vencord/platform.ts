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

/** One INSERT_TEXT into the focused chat box. Never sends. */
export function insertText(text: string) {
    insertTextIntoChatInputBox(text);
}

export const currentGuildId = (): string | null => SelectedGuildStore.getGuildId() ?? null;

export function currentChannel() {
    const id = SelectedChannelStore.getChannelId() ?? null;
    const ch = id ? ChannelStore.getChannel(id) : null;
    return { id, name: ch?.name ?? "", guildId: ch?.guild_id ?? null };
}

export function onChannelChange(fn: () => void) {
    const h = () => fn();
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
    const el = document.querySelector('[class*="channelTextArea"]');
    return el ? el.getBoundingClientRect() : null;
}

export async function readClipboard(): Promise<string> {
    try { return await navigator.clipboard.readText(); } catch { return ""; }
}
