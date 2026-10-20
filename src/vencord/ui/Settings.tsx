/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./settings-layout.css";

import { useRef, useState } from "@webpack/common";

import { validPrefix } from "../core/trigger";
import { moveWindowTab, WindowTab, WINDOW_TAB_LABELS } from "../core/types";
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
    const tabDrag = useRef<{ id: WindowTab; order: WindowTab[]; } | null>(null);
    const [tabDrop, setTabDrop] = useState<WindowTab | null>(null);
    const [tabAnnouncement, setTabAnnouncement] = useState("");
    const reorderTab = (id: WindowTab, target: WindowTab) => {
        if (p.phase !== "ready" || id === target) return;
        const order = moveWindowTab(store.data.windowTabOrder, id, target);
        store.setWindowTabOrder(order);
        setTabAnnouncement(`${WINDOW_TAB_LABELS[id]}: позиция ${order.indexOf(id) + 1} из ${order.length}`);
    };
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
                <p id="stx-tab-order-help">Перетащите вкладки в нужном порядке.</p>
                <ol aria-label="Порядок вкладок" style={{ display: "flex", flexWrap: "wrap", gap: 6, listStyle: "none", padding: 0, margin: "8px 0" }}>
                    {store.data.windowTabOrder.map((id, index, order) => <li key={id} style={{ margin: 0 }}>
                        <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={p.phase !== "ready"} draggable={p.phase === "ready"}
                            style={{ height: 28, padding: "0 10px", cursor: p.phase === "ready" ? "grab" : undefined,
                                outline: tabDrop === id ? "2px solid var(--stx-pr)" : undefined }}
                            aria-label={`${WINDOW_TAB_LABELS[id]}, позиция ${index + 1} из ${order.length}`}
                            aria-describedby="stx-tab-order-help" aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                            onDragStart={e => {
                                if (p.phase !== "ready") { e.preventDefault(); return; }
                                tabDrag.current = { id, order: store.data.windowTabOrder };
                                e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", id);
                            }}
                            onDragOver={e => {
                                if (p.phase === "ready" && tabDrag.current?.order === store.data.windowTabOrder) {
                                    e.preventDefault(); e.dataTransfer.dropEffect = "move"; setTabDrop(id);
                                }
                            }}
                            onDragLeave={() => setTabDrop(null)}
                            onDrop={e => {
                                const drag = tabDrag.current;
                                tabDrag.current = null; setTabDrop(null);
                                if (drag && drag.order === store.data.windowTabOrder) { e.preventDefault(); reorderTab(drag.id, id); }
                            }}
                            onDragEnd={() => { tabDrag.current = null; setTabDrop(null); }}
                            onKeyDown={e => {
                                if (e.nativeEvent.isComposing || e.keyCode === 229 || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey
                                    || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
                                e.preventDefault(); e.stopPropagation();
                                if (e.repeat || tabDrag.current || p.phase !== "ready") return;
                                const current = store.data.windowTabOrder;
                                const next = current.indexOf(id) + (e.key === "ArrowLeft" ? -1 : 1);
                                if (next >= 0 && next < current.length) reorderTab(id, current[next]);
                            }}>{WINDOW_TAB_LABELS[id]}</button>
                    </li>)}
                </ol>
                <span role="status" aria-live="polite" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" }}>{tabAnnouncement}</span>
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
