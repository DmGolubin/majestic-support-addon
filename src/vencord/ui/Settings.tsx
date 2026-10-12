/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useState } from "@webpack/common";

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
                setStatus("Ошибка: " + e.message);
                toast("Импорт не удался", "failure");
            }
        };
        inp.click();
    };

    const guilds = Object.entries(store.data.guilds);
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
            <p>{PROJECTS.mj.name} и {PROJECTS.ro.name} определяются сами. Ответы для остальных серверов:</p>
            {guilds.length
                ? <ul>{guilds.map(([k, b]) => <li key={k}><code>{k}</code> → {b === "none" ? "выбирать при открытии" : PROJECTS[b].name}</li>)}</ul>
                : <p className="vc-stx-muted">пока нет</p>}
            {guilds.length > 0 && <button className="vc-stx-btn vc-stx-ghost" onClick={() => store.clearGuilds()}>Сбросить ответы</button>}
        </div>
    );
}
