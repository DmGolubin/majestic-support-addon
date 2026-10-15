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
import { demo } from "./demo";
import { DemoConnection } from "./DemoConnection";
import { confirmedForeign, supersede } from "./flow";
import { nextGeneration } from "./op";
import { PersonalLibrary } from "./PersonalLibrary";
import { store, ui, useStore } from "./uiState";

export function Settings({ onDirty }: { onDirty?(dirty: boolean): void; } = {}) {
    useStore();
    const demoState = demo.use();
    const [tab, setTab] = useState("personal");
    const [dirty, setDirty] = useState(false);
    const [pending, setPending] = useState<string | null>(null);
    const [status, setStatus] = useState("");
    const main = store.templates.filter(t => t.source !== "personal");
    const mj = main.filter(t => t.project === "mj").length;
    const ro = main.filter(t => t.project === "ro").length;

    const pick = () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = ".json,.txt,.md";
        inp.onchange = async () => {
            const file = inp.files?.[0];
            if (!file) return;
            try {
                const msg = store.importText(await file.text());
                // The set was replaced: nothing in progress may keep pointing at old templates or old confirmations.
                nextGeneration(); // pending inserts prepared from the old set are dropped at their next check
                supersede();
                confirmedForeign.clear();
                ui.set({ compose: [], inline: null, menu: null, dialog: null });
                setStatus(msg);
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
            <nav className="vc-stx-settings-nav" aria-label="Разделы настроек">
                {[["personal", "Мои шаблоны"], ["general", "Настройки"], ["connection", "Подключение"]].map(([id, label]) => <button key={id} className={"vc-stx-btn " + (tab === id ? "" : "vc-stx-ghost")} aria-pressed={tab === id} onClick={() => { if (id === tab) return; if (dirty) setPending(id); else setTab(id); }}>{label}</button>)}
            </nav>
            {pending && <div className="vc-stx-local-note" role="alert">Отменить изменения и сменить раздел? <button className="vc-stx-btn" onClick={() => { setTab(pending); setPending(null); setDirty(false); onDirty?.(false); }}>Отменить изменения</button><button className="vc-stx-btn vc-stx-ghost" onClick={() => setPending(null)}>Остаться</button></div>}
            {tab === "personal" && (!demoState.enabled || demoState.revision > 0) && <PersonalLibrary onDirty={v => { setDirty(v); onDirty?.(v); }} />}
            {tab === "personal" && demoState.enabled && demoState.revision === 0 && <p className="vc-stx-local-note">Сначала подключите тестовый аккаунт во вкладке «Подключение».</p>}
            {tab === "connection" && <DemoConnection />}
            {tab === "general" && <>
            <h3>Основные шаблоны</h3>
            <p>Основных шаблонов: {main.length} (Majestic {mj}, Россия Онлайн {ro}). Источник — локальный; вход через панель появится позже.</p>
            <p>Временный импорт FAQ: <code>SupportTemplates.config.json</code> из BetterDiscord, резервная копия или текст «## проект / ### шаблон». Заменяет импортированный набор, его избранное и бинды. Личные шаблоны и их папки сохраняются.</p>
            <button className="vc-stx-btn" disabled={demoState.enabled} onClick={pick}>Импорт из файла</button>
            {status && <p className="vc-stx-muted">{status}</p>}

            <h3>Быстрый ввод</h3>
            <label className="vc-stx-check"><input type="checkbox" checked={store.data.previewOpen} onChange={e => store.setPreviewOpen(e.currentTarget.checked)} />Открывать окно с полным предпросмотром</label>
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
                <li>Tech™ (<code>{TECH_GUILD}</code>) — переключатель «Majestic / Россия Онлайн» в окне, без проверки проекта</li>
            </ul>
            <p>На остальных серверах и в ЛС плагин выключен.</p>
            </>}
        </div>
    );
}
