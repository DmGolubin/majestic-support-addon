/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { createRoot } from "@webpack/common";

import { DM_KEY, projectForGuild } from "./core/guard";
import { comboOf } from "./core/keys";
import { favoritesOf } from "./core/rank";
import { currentChannel, onChannelChange } from "./platform";
import { debugEnabled, dlog, keyDesc, setDebugEnabled } from "./ui/debug";
import { insertTemplate, supersede } from "./ui/flow";
import { Host } from "./ui/Host";
import { MJ_ICON } from "./ui/icons";
import { handleInlineKey, resetInline, startInline } from "./ui/inline";
import { latchKey, startLatch, swallowLatched } from "./ui/keylatch";
import { ChatBarIcon } from "./ui/ProjectIcon";
import { Settings } from "./ui/Settings";
import { activeProject, guildKey, poolFor, store, ui, UiState, useStore } from "./ui/uiState";
import { visibleItems } from "./ui/Window";

const Icon: IconComponent = ({ height = 20, width = 20, className }) => (
    <img src={MJ_ICON} height={height} width={width} className={className} style={{ borderRadius: 5 }} alt="" />
);

export function toggleWindow(open = !ui.get().windowOpen) {
    ui.set({ windowOpen: open, menu: null, selection: open ? String(window.getSelection() ?? "") : "" });
}

/** Chat-bar button: the icon follows this channel's server project (re-rendered by Discord on channel switch). */
const Button: ChatBarButtonFactory = ({ isMainChat, channel }) => {
    useStore(); // server bindings live in the store (picked in the "which project?" dialog)
    const session = ui.useSelect(s => s.sessionProject);
    if (!isMainChat) return null;
    const binding = projectForGuild(channel?.guild_id ?? null, store.data.guilds);
    const project = binding === "mj" || binding === "ro" ? binding : binding === "none" ? session : null;
    return (
        <ChatBarButton tooltip="Шаблоны (Ctrl+Alt+T)" onClick={() => toggleWindow()} buttonProps={{ "data-stx": "button" } as any}>
            <ChatBarIcon project={project} />
        </ChatBarButton>
    );
};

/** Focus is in another Discord input (search etc.), not the chat editor or our own UI. */
const inForeignInput = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    return !!target?.closest?.("input, textarea, select") && !target.closest(".vc-stx-root");
};

/** Focusable controls of the open dialog, in tab order. */
const dialogFocusables = (dlg: Element) =>
    Array.from(dlg.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])"))
        .filter(el => !(el as HTMLButtonElement).disabled);

/** While a dialog is open: Tab cycles inside it; Enter/Tab outside it never reach Discord. */
function trapDialogFocus(e: KeyboardEvent) {
    if (e.key !== "Tab" && e.key !== "Enter") return;
    const dlg = document.querySelector<HTMLElement>(".vc-stx-dialog");
    if (!dlg) return;
    const target = e.target as HTMLElement;
    if (!target?.closest?.(".vc-stx-dialog")) {
        e.preventDefault();
        e.stopPropagation();
        dlg.focus(); // the dialog itself, not its OK button: the next Enter must not confirm by accident
        return;
    }
    if (e.key !== "Tab") return;
    const els = dialogFocusables(dlg);
    if (!els.length) { e.preventDefault(); return; }
    const i = els.indexOf(target);
    if (e.shiftKey ? i <= 0 : i === els.length - 1) {
        e.preventDefault();
        els[e.shiftKey ? els.length - 1 : 0].focus();
    }
}

function onKey(e: KeyboardEvent) {
    if (swallowLatched(e)) return; // held key after an insert: never repeat it, never leak it to Discord
    const s = ui.get();
    if (s.dialog) {
        if (debugEnabled() && (e.key === "Tab" || e.key === "Enter")) dlog("key", { h: "dialog", key: keyDesc(e), dialog: s.dialog.kind });
        return trapDialogFocus(e); // dialogs handle their own keys
    }

    if (handleInlineKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (debugEnabled()) dlog("key", { h: "inline", key: keyDesc(e) }, "inline:" + e.code);
        return;
    }

    if (e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        e.stopPropagation();
        if (debugEnabled()) dlog("key", { h: "hotkey", key: keyDesc(e), action: e.repeat ? "repeat — игнор" : s.windowOpen ? "закрыть окно" : "открыть окно" });
        if (!e.repeat) toggleWindow();
        return;
    }

    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        if (inForeignInput(e)) { dlog("key", { h: "alt-n", key: keyDesc(e), skip: "фокус в чужом поле ввода" }); return; }
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) { dlog("key", { h: "alt-n", key: keyDesc(e), skip: "repeat" }, "altn-repeat:" + e.code); return; }
        const i = Number(digit[1]) - 1;
        const list = s.windowOpen ? visibleItems : favoritesOf(poolFor(activeProject().project), store.ctx());
        const t = list[i];
        dlog("key", { h: "alt-n", key: keyDesc(e), from: s.windowOpen ? "окно" : "избранное", id: t?.id, title: t?.title ?? "(пусто)" });
        if (t) {
            latchKey(e.code);
            void insertTemplate(t, { via: "alt-" + (i + 1) });
        }
        return;
    }

    const combo = comboOf(e);
    const bound = combo ? store.templateForCombo(combo) : undefined;
    if (bound) {
        if (inForeignInput(e)) { dlog("key", { h: "bind", key: keyDesc(e), skip: "фокус в чужом поле ввода" }); return; }
        e.preventDefault();
        e.stopPropagation();
        dlog("key", { h: "bind", key: keyDesc(e), id: bound.id, title: bound.title }, e.repeat ? "bind-repeat:" + e.code : undefined);
        if (!e.repeat) {
            latchKey(e.code);
            void insertTemplate(bound, { via: "bind " + combo });
        }
    }
}

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let offChannel: (() => void) | null = null;
let offInline: (() => void) | null = null;
let offLatch: (() => void) | null = null;
let lastGuild = DM_KEY;

/** Channel switch: cancel pending dialogs and drop everything tied to the old channel. */
function channelChanged(guildId: string | null) {
    supersede();
    const patch: Partial<UiState> = { compose: [], inline: null, menu: null, windowOpen: false };
    const key = guildId ?? DM_KEY;
    if (key !== lastGuild) patch.sessionProject = null; // a project picked in the window is per server
    if (debugEnabled()) {
        const ch = currentChannel();
        dlog("channel", { guild: key, channel: ch.id, name: ch.name, serverChanged: key !== lastGuild, hadDialog: !!ui.get().dialog, hadWindow: ui.get().windowOpen });
    }
    lastGuild = key;
    ui.set(patch);
}

const settings = definePluginSettings({
    panel: { type: OptionType.COMPONENT, component: Settings },
    // Vencord's own settings store: a UI preference, kept out of the templates data (and its backups).
    debug: {
        type: OptionType.BOOLEAN,
        displayName: "Режим отладки",
        description: "Панель состояния и журнал событий слева внизу, кнопка «Скопировать отчёт». Без текстов шаблонов.",
        default: false,
        onChange: (v: boolean) => setDebugEnabled(v),
    },
});

export default definePlugin({
    name: "SupportTemplates",
    description: "Шаблоны ответов поддержки Majestic RP и Россия Онлайн в строке ввода.",
    authors: [{ name: "Oblako", id: 0n }],
    settings,
    chatBarButton: { icon: Icon, render: Button },

    async start() {
        await store.load();
        document.addEventListener("keydown", onKey, true);
        offLatch = startLatch();
        lastGuild = guildKey();
        host = document.createElement("div");
        host.id = "vc-stx-host";
        document.body.append(host);
        root = createRoot(host);
        root.render(<Host />);
        offInline = startInline();
        offChannel = onChannelChange(channelChanged);
        setDebugEnabled(!!settings.store.debug);
    },

    stop() {
        document.removeEventListener("keydown", onKey, true);
        offChannel?.();
        offChannel = null;
        offInline?.();
        offInline = null;
        offLatch?.();
        offLatch = null;
        supersede(); // resolve a pending dialog so its flow ends instead of hanging
        resetInline();
        root?.unmount();
        host?.remove();
        root = host = null;
        ui.set({ windowOpen: false, dialog: null, inline: null, menu: null });
        setDebugEnabled(false);
    },
});
