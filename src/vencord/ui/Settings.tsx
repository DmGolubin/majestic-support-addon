/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useState } from "@webpack/common";

import { TECH_GUILD } from "../core/guard";
import { PREFIXES } from "../core/trigger";
import { PROJECTS } from "../core/types";
import { toast } from "../platform";
import { store, useStore } from "./uiState";

export function Settings() {
    useStore();
    const [status, setStatus] = useState("");
    const mj = store.templates.filter(t => t.project === "mj").length;
    const ro = store.templates.filter(t => t.project === "ro").length;

    const pick = () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = ".json,.txt,.md";
        inp.onchange = async () => {
            const file = inp.files?.[0];
            if (!file) return;
            try {
                setStatus(store.importText(await file.text()));
                toast("Импорт выполнен", "success");
            } catch (e: any) {
                console.error("[SupportTemplates] import failed", e);
                setStatus("Ошибка: " + e.message);
                toast("Импорт не удался", "failure");
            }
        };
        inp.click();
    };

    return (
        <div className="vc-stx-settings">
            <h3>Шаблоны</h3>
            <p>Сейчас: {store.templates.length} (Majestic {mj}, Россия Онлайн {ro}). Источник — локальный; вход через панель появится позже.</p>
            <p>Импорт: <code>SupportTemplates.config.json</code> из BetterDiscord, резервная копия или текст «## проект / ### шаблон». Заменяет текущие шаблоны, избранное и бинды.</p>
            <button className="vc-stx-btn" onClick={pick}>Импорт из файла</button>
            {status && <p className="vc-stx-muted">{status}</p>}

            <h3>Быстрый ввод</h3>
            <p>Префикс команды в строке ввода («/» занят командами Discord):</p>
            <div className="vc-stx-row">
                {PREFIXES.map(p => (
                    <button key={p} className={"vc-stx-btn " + (store.data.prefix === p ? "" : "vc-stx-ghost")} onClick={() => store.setPrefix(p)}>{p}снр</button>
                ))}
            </div>

            <h3>Серверы</h3>
            <ul>
                <li>{PROJECTS.mj.name} (<code>{PROJECTS.mj.guildId}</code>) — шаблоны {PROJECTS.mj.short} и общие</li>
                <li>{PROJECTS.ro.name} (<code>{PROJECTS.ro.guildId}</code>) — шаблоны {PROJECTS.ro.short} и общие</li>
                <li>Tech™ (<code>{TECH_GUILD}</code>) — все шаблоны обоих проектов, без выбора проекта</li>
            </ul>
            <p>На остальных серверах и в ЛС плагин выключен.</p>
        </div>
    );
}
