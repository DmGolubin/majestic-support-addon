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

import { comboOf } from "./core/keys";
import { favoritesOf } from "./core/rank";
import { onChannelChange } from "./platform";
import { insertTemplate } from "./ui/flow";
import { Host } from "./ui/Host";
import { MJ_ICON } from "./ui/icons";
import { handleInlineKey, startInline } from "./ui/inline";
import { Settings } from "./ui/Settings";
import { activeProject, poolFor, store, ui } from "./ui/uiState";
import { visibleItems } from "./ui/Window";

const Icon: IconComponent = ({ height = 20, width = 20, className }) => (
    <img src={MJ_ICON} height={height} width={width} className={className} style={{ borderRadius: 5 }} alt="" />
);

export function toggleWindow(open = !ui.get().windowOpen) {
    ui.set({ windowOpen: open, menu: null, selection: open ? String(window.getSelection() ?? "") : "" });
}

const Button: ChatBarButtonFactory = ({ isMainChat }) => {
    if (!isMainChat) return null;
    return (
        <ChatBarButton tooltip="Шаблоны (Ctrl+Alt+T)" onClick={() => toggleWindow()} buttonProps={{ className: "vc-stx-button" } as any}>
            <Icon />
        </ChatBarButton>
    );
};

function onKey(e: KeyboardEvent) {
    const s = ui.get();
    if (s.dialog) return; // dialogs handle their own keys

    if (handleInlineKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
    }

    if (e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) toggleWindow();
        return;
    }

    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        const i = Number(digit[1]) - 1;
        const list = s.windowOpen ? visibleItems : favoritesOf(poolFor(activeProject().project), store.ctx());
        const t = list[i];
        if (t) void insertTemplate(t);
        return;
    }

    const combo = comboOf(e);
    const bound = combo ? store.templateForCombo(combo) : undefined;
    if (bound) {
        const target = e.target as HTMLElement;
        if (target?.closest?.("input, textarea, select") && !target.closest(".vc-stx-root")) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) void insertTemplate(bound);
    }
}

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let offChannel: (() => void) | null = null;
let offInline: (() => void) | null = null;

const settings = definePluginSettings({
    panel: { type: OptionType.COMPONENT, component: Settings },
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
        host = document.createElement("div");
        host.id = "vc-stx-host";
        document.body.append(host);
        root = createRoot(host);
        root.render(<Host />);
        offInline = startInline();
        offChannel = onChannelChange(() => ui.set({ compose: [], inline: null, menu: null }));
    },

    stop() {
        document.removeEventListener("keydown", onKey, true);
        offChannel?.();
        offChannel = null;
        offInline?.();
        offInline = null;
        root?.unmount();
        host?.remove();
        root = host = null;
        ui.set({ windowOpen: false, dialog: null, inline: null, menu: null });
    },
});
