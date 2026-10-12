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

import { Host } from "./ui/Host";
import { MJ_ICON } from "./ui/icons";
import { Settings } from "./ui/Settings";
import { store, ui } from "./ui/uiState";

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
    if (e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) toggleWindow();
    }
}

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

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
    },

    stop() {
        document.removeEventListener("keydown", onKey, true);
        root?.unmount();
        host?.remove();
        root = host = null;
        ui.set({ windowOpen: false, dialog: null, inline: null, menu: null });
    },
});
