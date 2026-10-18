/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useRef, useState } from "@webpack/common";

import { PREFIXES, validPrefix } from "../core/trigger";
import { toast } from "../platform";
import { demo } from "./demo";
import { DemoConnection } from "./DemoConnection";
import { confirmedForeign, supersede } from "./flow";
import { nextGeneration } from "./op";
import { panel, useDemoLibrary, useLocalLibrary } from "./panel";
import { PanelConnection } from "./PanelConnection";
import { PersonalLibrary } from "./PersonalLibrary";
import { IconBell, IconLink, IconSettings, IconTemplates } from "./svg";
import { TicketSettings } from "./TicketSettings";
import { getStoreSelection, store, ui, useStore } from "./uiState";

export function Settings({ onDirty, onBusy }: { onDirty?(dirty: boolean): void; onBusy?(busy: boolean): void; } = {}) {
    useStore();
    const demoState = demo.use();
    const p = panel.use();
    const [tab, setTab] = useState("personal");
    const [dirty, setDirty] = useState(false);
    const busyRef = useRef(false);
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<string | null>(null);
    const [prefix, setPrefix] = useState(store.data.prefix);
    const [prefixError, setPrefixError] = useState("");
    const [status, setStatus] = useState("");
    const main = store.templates.filter(t => t.source !== "personal");
    const mj = main.filter(t => t.project === "mj").length;
    const ro = main.filter(t => t.project === "ro").length;

    const pick = () => {
        const targetStore = getStoreSelection();
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = ".json,.txt,.md";
        inp.onchange = async () => {
            const file = inp.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                if (getStoreSelection() !== targetStore) return;
                const msg = await targetStore.store.importTextAsync(text);
                if (getStoreSelection() !== targetStore) return;
                // The set was replaced: nothing in progress may keep pointing at old templates or old confirmations.
                nextGeneration(); // pending inserts prepared from the old set are dropped at their next check
                supersede();
                confirmedForeign.clear();
                ui.set({ compose: [], inline: null, menu: null, dialog: null });
                setStatus(msg);
                toast("Импорт выполнен", "success");
            } catch (e: any) {
                if (getStoreSelection() !== targetStore) return;
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
                {[["personal", "Мои шаблоны"], ["general", "Настройки"], ["connection", "Подключение"], ["tickets", "Тикеты"]].map(([id, label]) => <button key={id} className={"vc-stx-btn " + (tab === id ? "" : "vc-stx-ghost")} aria-pressed={tab === id} disabled={busy} onClick={() => { if (busyRef.current || id === tab) return; if (dirty) setPending(id); else setTab(id); }}>{id === "personal" ? <IconTemplates size={16} /> : id === "general" ? <IconSettings size={16} /> : id === "tickets" ? <IconBell size={16} /> : <IconLink size={16} />}{label}</button>)}
            </nav>
            {pending && <div className="vc-stx-local-note" role="alert">Отменить изменения и сменить раздел? <button className="vc-stx-btn" disabled={busy} onClick={() => { if (busyRef.current) return; setTab(pending); setPending(null); setDirty(false); onDirty?.(false); }}>Отменить изменения</button><button className="vc-stx-btn vc-stx-ghost" disabled={busy} onClick={() => { if (!busyRef.current) setPending(null); }}>Остаться</button></div>}
            {tab === "personal" && p.enabled && <section className="vc-stx-setting-section">
                <div className="vc-stx-lib-title"><h3>Мои шаблоны</h3><a className="vc-stx-btn vc-stx-ghost" href="https://panel.majestic-rp.tech/faq" target="_blank" rel="noreferrer">Редактировать на панели <IconLink /></a></div>
                {p.phase !== "ready" ? <button className="vc-stx-btn" onClick={() => setTab("connection")}>Подключить панель</button>
                    : store.data.personal.length ? store.data.personal.map(t => <article key={t.id} className="vc-stx-setting-section" style={{ borderLeft: t.color ? `3px solid ${t.color}` : undefined, paddingLeft: 12 }}>
                        <h4>{t.title}</h4><span className="vc-stx-muted">{t.category}</span><p style={{ whiteSpace: "pre-wrap" }}>{t.text}</p>
                    </article>) : <p className="vc-stx-muted">Личных шаблонов пока нет.</p>}
            </section>}
            {tab === "personal" && !p.enabled && (!demoState.enabled || demoState.revision > 0) && <PersonalLibrary onDirty={v => { setDirty(v); if (!v) setPending(null); onDirty?.(v); }} onBusy={v => { busyRef.current = v; setBusy(v); onBusy?.(v); }} />}
            {tab === "personal" && !p.enabled && demoState.enabled && demoState.revision === 0 && <p className="vc-stx-local-note">Сначала подключите тестовый аккаунт во вкладке «Подключение».</p>}
            {tab === "connection" && <><PanelConnection />
                <details className="vc-stx-settings-details"><summary>Локальная библиотека и демо</summary>
                    <div className="vc-stx-lib-actions"><button className="vc-stx-btn vc-stx-ghost" onClick={() => void useLocalLibrary()}>Локальная библиотека</button><button className="vc-stx-btn vc-stx-ghost" onClick={() => void useDemoLibrary()}>Деморежим</button></div>
                    {!p.enabled && demoState.enabled && <DemoConnection />}
                </details></>}
            {tab === "tickets" && <TicketSettings />}
            {tab === "general" && <>
            <section className="vc-stx-setting-section">
                <h3>Окно и быстрый ввод</h3>
                <label className="vc-stx-check"><input type="checkbox" checked={store.data.previewOpen} onChange={e => store.setPreviewOpen(e.currentTarget.checked)} />Открывать полный предпросмотр</label>
                <p className="vc-stx-muted">В компактном окне удерживайте Shift для просмотра.</p>
                <h4>Префикс команды</h4>
                <div className="vc-stx-row" role="group" aria-label="Префикс команды">
                    {PREFIXES.map(p => <button key={p} aria-pressed={store.data.prefix === p} className={"vc-stx-btn " + (store.data.prefix === p ? "" : "vc-stx-ghost")} onClick={() => { store.setPrefix(p); setPrefix(p); setPrefixError(""); }}>{p}снр</button>)}
                </div>
                <form className="vc-stx-prefix-form" onSubmit={e => { e.preventDefault(); if (!validPrefix(prefix)) { setPrefixError("Один знак пунктуации, кроме /, @ и скобок."); return; } store.setPrefix(prefix); setPrefixError(""); }}>
                    <label>Свой символ<input aria-label="Свой префикс" maxLength={1} value={prefix} onChange={e => setPrefix(e.currentTarget.value)} /></label>
                    <button className="vc-stx-btn vc-stx-ghost" disabled={prefix === store.data.prefix}>Применить</button>
                    <code>{store.data.prefix}команда</code>
                </form>
                {prefixError && <p role="alert" className="vc-stx-form-error">{prefixError}</p>}
            </section>
            <section className="vc-stx-setting-section">
                <h3>Библиотека</h3>
                <p>{main.length} основных шаблонов <span className="vc-stx-muted">· Majestic {mj} · Россия Онлайн {ro}</span></p>
                <details className="vc-stx-settings-details"><summary>Импорт из файла</summary>
                    <p className="vc-stx-muted">JSON, TXT или Markdown. Заменит основные шаблоны, их избранное и бинды. Личные шаблоны и папки сохранятся.</p>
                    {(demoState.enabled || p.enabled) && <p className="vc-stx-muted">Доступен в локальной библиотеке.</p>}
                    <button className="vc-stx-btn vc-stx-ghost" disabled={demoState.enabled || p.enabled} onClick={pick}>Выбрать файл</button>
                    {status && <p role="status">{status}</p>}
                </details>
            </section>
            <section className="vc-stx-setting-section">
                <h3>Доступные серверы</h3>
                <div className="vc-stx-server-links">
                    <a href="https://discord.com/channels/530693013622489088" target="_blank" rel="noreferrer">Majestic <IconLink /></a>
                    <a href="https://discord.com/channels/1089530150540034181" target="_blank" rel="noreferrer">Россия Онлайн <IconLink /></a>
                    <a href="https://discord.com/channels/1395915167040016545" target="_blank" rel="noreferrer">Tech <IconLink /></a>
                </div>
            </section>
            </>}
        </div>
    );
}
