/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { Button, createRoot, showToast, useState } from "@webpack/common";

import { isOpen, Picker, quickInsert, setOpen, useOpen } from "./Picker";
import { getTemplates, groups, importBackup, load } from "./store";

const Icon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg viewBox="0 0 24 24" height={height} width={width} className={className}>
        <path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM7 8v2h10V8H7zm0 4v2h7v-2H7z" />
    </svg>
);

function mainTextAreaRect() {
    const el = document.querySelector('[class*="channelTextArea"]');
    return el ? el.getBoundingClientRect() : null;
}

const TemplatesButton: ChatBarButtonFactory = ({ isMainChat }) => {
    if (!isMainChat) return null;

    return (
        <ChatBarButton
            tooltip="Шаблоны ответов (Ctrl+Alt+T)"
            onClick={() => setOpen(!isOpen())}
            buttonProps={{ className: "vc-st-button" } as any}
        >
            <Icon />
        </ChatBarButton>
    );
};

// The picker lives in its own root, so Ctrl+Alt+T works even when the chat bar button is not rendered.
function PickerHost() {
    const open = useOpen();
    return open ? <Picker anchor={mainTextAreaRect()} /> : null;
}

let hostEl: HTMLDivElement | null = null;
let hostRoot: ReturnType<typeof createRoot> | null = null;

function ImportPanel() {
    const [status, setStatus] = useState(`Сейчас шаблонов: ${getTemplates().length}${groups().length ? ` (${groups().join(", ")})` : ""}`);

    const pick = () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = ".json,.txt,.md";
        inp.onchange = async () => {
            const file = inp.files?.[0];
            if (!file) return;
            try {
                const msg = importBackup(await file.text());
                setStatus(msg);
                showToast("Импорт выполнен", "success");
            } catch (e: any) {
                setStatus("Ошибка: " + e.message);
                showToast("Импорт не удался", "failure");
            }
        };
        inp.click();
    };

    return (
        <div className="vc-st-settings">
            <p>Импорт: файл <code>SupportTemplates.config.json</code> из BetterDiscord (папка plugins), резервная копия или текст в формате «## сервер / ### шаблон».</p>
            <Button onClick={pick}>Импорт из файла</Button>
            <p className="vc-st-status">{status}</p>
        </div>
    );
}

const settings = definePluginSettings({
    importer: {
        type: OptionType.COMPONENT,
        component: ImportPanel,
    },
});

function onKey(e: KeyboardEvent) {
    if (e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(!isOpen());
        return;
    }
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        const m = /^Digit([1-9])$/.exec(e.code);
        if (!m) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return; // held key must not insert the template again
        quickInsert(Number(m[1]) - 1);
    }
}

export default definePlugin({
    name: "SupportTemplates",
    description: "Шаблоны ответов поддержки в строке ввода (прототип для Vencord).",
    authors: [{ name: "Oblako", id: 0n }],
    settings,

    chatBarButton: {
        icon: Icon,
        render: TemplatesButton,
    },

    async start() {
        await load();
        document.addEventListener("keydown", onKey, true);
        hostEl = document.createElement("div");
        hostEl.id = "vc-st-host";
        document.body.append(hostEl);
        hostRoot = createRoot(hostEl);
        hostRoot.render(<PickerHost />);
    },

    stop() {
        document.removeEventListener("keydown", onKey, true);
        setOpen(false);
        hostRoot?.unmount();
        hostEl?.remove();
        hostRoot = null;
        hostEl = null;
    },
});
