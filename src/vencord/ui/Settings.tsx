/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./settings-layout.css";

import { useRef, useState } from "@webpack/common";

import { validPrefix } from "../core/trigger";
import { moveWindowTab, WINDOW_TAB_LABELS } from "../core/types";
import { panel } from "./panel";
import { DiagnosticControls } from "./DiagnosticControls";
import { PanelConnection } from "./PanelConnection";
import { discardPanelDraft, PanelPersonalLibrary } from "./PanelPersonalLibrary";
import { IconBell, IconSettings, IconTemplates } from "./svg";
import { TicketSettings } from "./TicketSettings";
import { LocalStorageNotice } from "./LocalStorageNotice";
import { BuildIdentity } from "./BuildIdentity";
import { store, useStore } from "./uiState";

export function Settings({ onDirty, onBusy }: { onDirty?(dirty: boolean): void; onBusy?(busy: boolean): void; } = {}) {
    useStore();
    const p = panel.use();
    const [tab, setTab] = useState("personal");
    const [dirty, setDirty] = useState(false);
    const personalDirty = useRef(false);
    const busyRef = useRef(false);
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<string | null>(null);
    const [prefix, setPrefix] = useState(store.data.prefix);
    const prefixRef = useRef(prefix);
    const [prefixError, setPrefixError] = useState("");
    const reportDirty = () => {
        const next = personalDirty.current || prefixRef.current !== store.data.prefix;
        setDirty(next);
        if (!next) setPending(null);
        onDirty?.(next);
    };
    const changeTab = (id: string) => {
        if (busyRef.current || id === tab) return;
        if (dirty) setPending(id); else setTab(id);
    };
    return <div className="vc-stx-settings vc-stx-settings-account">
        <BuildIdentity />
        <LocalStorageNotice />
        <nav className="vc-stx-settings-nav" aria-label="Разделы настроек">
            {[["personal", "Мои шаблоны"], ["general", "Настройки"], ["tickets", "Тикеты"]].map(([id, label]) => <button key={id}
                type="button" className="vc-stx-btn vc-stx-ghost" aria-pressed={tab === id} disabled={busy} onClick={() => changeTab(id)}>
                {id === "personal" ? <IconTemplates size={17} /> : id === "general" ? <IconSettings size={17} /> : <IconBell size={17} />}{label}
            </button>)}
        </nav>
        {pending && <div className="vc-stx-local-note" role="alert">Есть несохранённые изменения.
            <div className="vc-stx-lib-actions"><button className="vc-stx-btn vc-stx-ghost" disabled={busy} onClick={() => { if (!busyRef.current) setPending(null); }}>Остаться</button>
                <button className="vc-stx-btn" disabled={busy} onClick={() => {
                    if (busyRef.current) return;
                    prefixRef.current = store.data.prefix;
                    setPrefix(prefixRef.current); setPrefixError(""); personalDirty.current = false;
                    discardPanelDraft(); setTab(pending); setPending(null); reportDirty();
                }}>Перейти без сохранения</button></div>
        </div>}
        {tab === "personal" && <PanelPersonalLibrary onDirty={v => { personalDirty.current = v; reportDirty(); }} onBusy={v => { busyRef.current = v; setBusy(v); onBusy?.(v); }} />}
        {tab === "tickets" && <TicketSettings />}
        {tab === "general" && <div className="vc-stx-settings-sections">
            <PanelConnection />
            <section className="vc-stx-setting-section vc-stx-setting-card" aria-labelledby="stx-window-settings">
                <h3 id="stx-window-settings">Шаблоны и поиск</h3>
                <div className="vc-stx-setting-line">
                    <div><strong>Личные шаблоны во «Все»</strong><span>Вкладка «Мои», избранное и недавние доступны независимо от этой настройки.</span></div>
                    <label className="vc-stx-switch"><input type="checkbox" aria-label="Показывать личные шаблоны во Все" checked={store.data.showPersonalInAll} disabled={p.phase !== "ready"} onChange={e => store.setShowPersonalInAll(e.currentTarget.checked)} /><span aria-hidden="true" /></label>
                </div>
                <div className="vc-stx-setting-line">
                    <div><strong>Общие шаблоны первыми в поиске</strong><span>Сначала общие, затем личные. Внутри каждой группы сохраняется порядок по точности совпадения.</span></div>
                    <label className="vc-stx-switch"><input type="checkbox" aria-label="Общие шаблоны первыми в поиске" checked={store.data.generalFirstInSearch} disabled={p.phase !== "ready"} onChange={e => store.setGeneralFirstInSearch(e.currentTarget.checked)} /><span aria-hidden="true" /></label>
                </div>
                <h4>Порядок вкладок</h4>
                <p>Перетащите вкладку в окне шаблонов или используйте кнопки ниже.</p>
                <ol aria-label="Порядок вкладок">
                    {store.data.windowTabOrder.map((id, index, order) => <li key={id}>
                        <div className="vc-stx-setting-line">
                            <strong>{WINDOW_TAB_LABELS[id]}</strong>
                            <div className="vc-stx-lib-actions">
                                <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={p.phase !== "ready" || index === 0}
                                    aria-label={`Переместить ${WINDOW_TAB_LABELS[id]} раньше`}
                                    onClick={() => store.setWindowTabOrder(moveWindowTab(order, id, order[index - 1]))}>Раньше</button>
                                <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={p.phase !== "ready" || index === order.length - 1}
                                    aria-label={`Переместить ${WINDOW_TAB_LABELS[id]} позже`}
                                    onClick={() => store.setWindowTabOrder(moveWindowTab(order, id, order[index + 1]))}>Позже</button>
                            </div>
                        </div>
                    </li>)}
                </ol>
            </section>
            <section className="vc-stx-setting-section vc-stx-setting-card" aria-labelledby="stx-input-settings">
                <h3 id="stx-input-settings">Быстрый ввод</h3>
                <div className="vc-stx-setting-line">
                    <div><strong>Полный предпросмотр</strong><span>В компактном меню полный текст открывается по Shift.</span></div>
                    <label className="vc-stx-switch"><input type="checkbox" aria-label="Открывать полный предпросмотр" checked={store.data.previewOpen} disabled={p.phase !== "ready"} onChange={e => store.setPreviewOpen(e.currentTarget.checked)} /><span aria-hidden="true" /></label>
                </div>
                <form className="vc-stx-prefix-control" onSubmit={e => {
                    e.preventDefault();
                    if (!validPrefix(prefix)) { setPrefixError("Введите один знак: например ; или !"); return; }
                    store.setPrefix(prefix); setPrefixError(""); reportDirty();
                }}>
                    <label htmlFor="stx-prefix-input"><strong>Префикс команды</strong><span>Например, {store.data.prefix}снр</span></label>
                    <div><input id="stx-prefix-input" aria-label="Префикс команды" maxLength={1} value={prefix} disabled={p.phase !== "ready"} onChange={e => { prefixRef.current = e.currentTarget.value; setPrefix(prefixRef.current); reportDirty(); }} /><button className="vc-stx-btn vc-stx-ghost" disabled={p.phase !== "ready" || prefix === store.data.prefix}>Сохранить</button></div>
                </form>
                {prefixError && <p role="alert" className="vc-stx-form-error">{prefixError}</p>}
            </section>
            <DiagnosticControls />
        </div>}
    </div>;
}
