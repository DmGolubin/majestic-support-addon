/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useState } from "@webpack/common";

import { PREFIXES } from "../core/trigger";
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
            <section className="vc-stx-setting-section">
                <h3>Окно и быстрый ввод</h3>
                <label className="vc-stx-check"><input type="checkbox" checked={store.data.previewOpen} onChange={e => store.setPreviewOpen(e.currentTarget.checked)} />Открывать полный предпросмотр</label>
                <p className="vc-stx-muted">В компактном окне удерживайте Shift для просмотра.</p>
                <h4>Префикс команды</h4>
                <div className="vc-stx-row" role="group" aria-label="Префикс команды">
                    {PREFIXES.map(p => <button key={p} aria-pressed={store.data.prefix === p} className={"vc-stx-btn " + (store.data.prefix === p ? "" : "vc-stx-ghost")} onClick={() => store.setPrefix(p)}>{p}снр</button>)}
                </div>
            </section>
            <section className="vc-stx-setting-section">
                <h3>Библиотека</h3>
                <p>{main.length} основных шаблонов <span className="vc-stx-muted">· Majestic {mj} · Россия Онлайн {ro}</span></p>
                <details className="vc-stx-settings-details"><summary>Импорт из файла</summary>
                    <p className="vc-stx-muted">JSON, TXT или Markdown. Заменит основные шаблоны, их избранное и бинды. Личные шаблоны и папки сохранятся.</p>
                    {demoState.enabled && <p className="vc-stx-muted">Доступен в локальной библиотеке.</p>}
                    <button className="vc-stx-btn vc-stx-ghost" disabled={demoState.enabled} onClick={pick}>Выбрать файл</button>
                    {status && <p role="status">{status}</p>}
                </details>
            </section>
            <section className="vc-stx-setting-section">
                <h3>Доступные серверы</h3>
                <div className="vc-stx-server-row"><span>Majestic</span><span>Majestic и общие</span></div>
                <div className="vc-stx-server-row"><span>Россия Онлайн</span><span>Россия Онлайн и общие</span></div>
                <div className="vc-stx-server-row"><span>Tech</span><span>Выбор проекта в меню</span></div>
                <p className="vc-stx-muted">На остальных серверах и в ЛС плагин выключен.</p>
            </section>
            </>}
        </div>
    );
}
