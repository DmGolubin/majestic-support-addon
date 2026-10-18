/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useLayoutEffect, useRef, useState } from "@webpack/common";

import { PanelFolderRecord, PanelPersonalRecord } from "../core/panelCatalog";
import { PanelError } from "../core/panelClient";
import { PanelMutation } from "../core/panelProtocol";
import { splitGreeting } from "../core/text";
import { insertToken } from "../core/tokenEditor";
import { ProjectId } from "../core/types";
import { Markdown } from "./markdown";
import { authorizePanelEditing, panel, panelPersonal, panelWriteMessage, preparePanelWrite, reloadPanel } from "./panel";
import { PanelConnection } from "./PanelConnection";
import { Select } from "./Select";
import { TokenToolbar } from "./TokenToolbar";
import { ColorPicker } from "./ColorPicker";

import "./panel-personal.css";

interface Props { onDirty?(dirty: boolean): void; onBusy?(busy: boolean): void; }
interface Draft {
    title: string; text: string; project: ProjectId; shared: boolean;
    command: string; color: string | null; folderId: string | null; position: number;
}
interface Editor { kind: "template" | "folder"; id?: string; version?: string; draft: Draft; }
interface Pending { request: PanelMutation; run: ReturnType<typeof preparePanelWrite>; }
interface DraftState {
    editor: Editor | null; dirty: boolean; remove: boolean; conflict: boolean;
    pending: Pending | null; error: string; busy: boolean;
}
const empty = (): DraftState => ({ editor: null, dirty: false, remove: false, conflict: false, pending: null, error: "", busy: false });
const binding = () => {
    const p = panelPersonal.get();
    return p.catalog ? `${p.generation}:${p.catalog.accountId}:${p.connectionId}` : "";
};
// A single account/connection-bound draft, never written to Store or disk. It also keeps the
// exact pending action across a forced Settings unmount, including an uncertain create UUID.
let retained: { key: string; state: DraftState; } | null = null;
const draftListeners = new Set<() => void>();
const notifyDraft = () => draftListeners.forEach(fn => fn());
export function discardPanelDraft() { retained = null; notifyDraft(); }
panelPersonal.subscribe(() => {
    if (retained && retained.key !== binding()) discardPanelDraft();
});
const projectName = (p: ProjectId) => p === "mj" ? "Majestic" : "Россия Онлайн";
const wireProject = (p: ProjectId) => p === "mj" ? "majestic" : "russia-online";
const COLOR_NAMES: Record<string, string> = { red: "Красный", orange: "Оранжевый", amber: "Янтарный", yellow: "Жёлтый", green: "Зелёный",
    teal: "Бирюзовый", cyan: "Бирюзовый", blue: "Синий", purple: "Фиолетовый", violet: "Фиолетовый", pink: "Розовый" };
const toEditor = (kind: Editor["kind"], row: PanelPersonalRecord | PanelFolderRecord): Editor => ({
    kind, id: row.id, version: row.version,
    draft: "text" in row ? { title: row.title, text: row.text, project: row.projects[0], shared: row.shared,
        command: row.command ?? "", color: row.color, folderId: row.folderId, position: 0 }
        : { title: row.title, text: "", project: row.project, shared: false, command: "", color: null, folderId: null, position: row.position },
});

export function PanelPersonalLibrary(props: Props) {
    const p = panelPersonal.use();
    panel.use();
    if (!p.catalog) return <PanelConnection />;
    return <PersonalEditor key={`${p.generation}:${p.catalog.accountId}:${p.connectionId}`} owner={binding()} {...props} />;
}

function PersonalEditor({ owner, onDirty, onBusy }: Props & { owner: string; }) {
    const p = panelPersonal.use(), connection = panel.use();
    const [state, setState] = useState<DraftState>(() => retained?.key === owner ? retained.state : empty());
    const [query, setQuery] = useState("");
    const [folder, setFolder] = useState("all");
    const [discard, setDiscard] = useState(false);
    const [notice, setNotice] = useState("");
    const bodyRef = useRef<HTMLTextAreaElement>(null);
    const range = useRef({ start: 0, end: 0 });
    const callbacks = useRef({ onDirty, onBusy }); callbacks.current = { onDirty, onBusy };
    const mounted = useRef(false);
    const live = useRef(state); live.current = state;
    const current = () => owner === binding();
    const update = (patch: Partial<DraftState>) => {
        if (!current()) return;
        const base = retained?.key === owner ? retained.state : live.current;
        const next = { ...base, ...patch };
        live.current = next; retained = { key: owner, state: next };
        notifyDraft();
    };
    useLayoutEffect(() => {
        mounted.current = true;
        const receive = () => {
            if (!current()) return;
            const next = retained?.key === owner ? retained.state : empty();
            live.current = next; setState(next);
            callbacks.current.onDirty?.(next.dirty || !!next.pending);
            callbacks.current.onBusy?.(next.busy);
        };
        draftListeners.add(receive); receive();
        return () => {
            mounted.current = false; draftListeners.delete(receive);
            callbacks.current.onDirty?.(false); callbacks.current.onBusy?.(false);
        };
    }, [owner]);
    const catalog = p.catalog!;
    const colorName = (key: string) => catalog.colorLabels[key] || COLOR_NAMES[key] || key;
    const busy = state.busy || p.busy;
    const canWrite = p.scopes.includes("personal:write");
    const canFolders = p.scopes.includes("folders:write");
    const ready = connection.phase === "ready";
    const editor = state.editor;
    const writable = editor?.kind === "folder" ? canFolders : canWrite;
    const restricted = !!editor?.draft.shared && catalog.projects.length !== 2;
    const locked = busy || !!state.pending || !writable || restricted;
    const begin = (kind: Editor["kind"], row?: PanelPersonalRecord | PanelFolderRecord) => {
        if (!current() || busy || editor) return;
        setNotice(""); setDiscard(false);
        update({ ...empty(), editor: row ? toEditor(kind, row) : { kind, draft: { title: "", text: "", project: (kind === "template" ? catalog.folderRecords.find(f => f.id === folder)?.project : undefined) ?? catalog.projects[0],
            shared: false, command: "", color: null, folderId: folder !== "all" && folder !== "none" ? folder : null, position: 0 } } });
    };
    const change = (patch: Partial<Draft>) => {
        if (!current() || locked || !live.current.editor) return;
        update({ editor: { ...live.current.editor, draft: { ...live.current.editor.draft, ...patch } }, dirty: true, error: "" });
    };
    const close = () => {
        if (!current() || busy) return;
        if (state.dirty || state.pending) setDiscard(true);
        else discardPanelDraft();
    };
    const run = async (deleting = false) => {
        const initial = live.current;
        if (!current() || initial.busy || p.busy || !initial.editor || !writable || restricted || initial.conflict || !ready) return;
        let pending = initial.pending;
        try {
            if (!pending) {
                const e = initial.editor, d = e.draft;
                const path = e.kind === "folder" ? "/folders" : "/personal-templates";
                const body = e.kind === "folder" ? { title: d.title, ...(!e.id ? { project: wireProject(d.project) } : {}), position: d.position }
                    : { title: d.title, text: d.text, project: wireProject(d.project), shared: d.shared,
                        command: d.command || null, color: d.color, folderId: d.folderId };
                const request: PanelMutation = { path: path + (e.id ? "/" + e.id : ""), method: deleting ? "DELETE" : e.id ? "PATCH" : "POST",
                    ...(deleting ? {} : { body }), ...(e.id ? { version: e.version } : { idempotencyKey: crypto.randomUUID() }) };
                pending = { request, run: preparePanelWrite(request) };
            }
            const action = pending;
            update({ pending: action, busy: true, error: "" });
            const result = await action.run();
            if (!current() || retained?.state.pending !== action) return;
            discardPanelDraft();
            if (mounted.current) {
                setDiscard(false);
                setNotice((deleting ? "Удалено на панели." : "Сохранено на панели.") + (result.refreshed ? "" : " Список пока не обновлён — повторите загрузку."));
            }
        } catch (error) {
            if (!current()) return;
            const conflict = error instanceof PanelError && (error.status === 412 || error.code === "version_conflict");
            // Only definite server rejections allow changing the body. Unknown outcomes keep
            // the original JSON and UUID frozen until a retry confirms the result or user discards.
            const definite = error instanceof PanelError && (error.status >= 400 && error.status < 500 && error.status !== 408
                || ["invalid_request", "stale_library", "write_busy"].includes(error.code));
            // A local retry preflight says nothing about the earlier request's outcome.
            // Never release its UUID/body just because freshness, a lock or validation failed.
            update({ error: panelWriteMessage(error), conflict, pending: conflict ? null : initial.pending ?? (definite ? null : pending), dirty: true });
        } finally {
            if (current() && retained?.key === owner) update({ busy: false });
        }
    };
    const capture = () => { if (bodyRef.current) range.current = { start: bodyRef.current.selectionStart, end: bodyRef.current.selectionEnd }; };
    const addToken = (token: string) => {
        if (!editor || locked) return false;
        try {
            const next = insertToken(editor.draft.text, range.current.start, range.current.end, token);
            change({ text: next.text }); range.current = { start: next.caret, end: next.caret };
            requestAnimationFrame(() => { if (current() && bodyRef.current?.isConnected) { bodyRef.current.focus(); bodyRef.current.setSelectionRange(next.caret, next.caret); } });
            return true;
        } catch { update({ error: "Текст с переменной превышает 20 000 символов." }); return false; }
    };
    const latest = ready && editor?.id ? editor.kind === "folder" ? catalog.folderRecords.find(f => f.id === editor.id)
        : catalog.personalRecords.find(t => t.id === editor.id) : undefined;
    const rows = catalog.personalRecords.filter(t => (folder === "all" || (folder === "none" ? !t.folderId : t.folderId === folder))
        && `${t.title} ${t.text} ${t.command ?? ""}`.toLowerCase().includes(query.toLowerCase()));

    return <section className="vc-stx-panel-personal" aria-label="Личная библиотека панели">
        <header><div><h3>Мои шаблоны</h3><p className="vc-stx-muted">На панели · {catalog.personalRecords.length}</p></div>
            {!editor && <button className="vc-stx-btn" disabled={!canWrite || !ready || busy || !catalog.projects.length} onClick={() => begin("template")}>Добавить шаблон</button>}</header>
        {(!canWrite || !canFolders) && <div className="vc-stx-pp-note">
            <p>Для редактирования подтвердите права записи на панели. Потребуется новый вход.</p>
            <button className="vc-stx-btn vc-stx-ghost" disabled={busy || !!editor} onClick={() => void authorizePanelEditing()}>Разрешить редактирование</button>
        </div>}
        {!ready && <div className="vc-stx-pp-note" role="status"><p>Запись временно недоступна. Черновик остаётся в памяти этого аккаунта.</p><button className="vc-stx-btn vc-stx-ghost" disabled={busy} onClick={() => void reloadPanel()}>Обновить библиотеку</button></div>}
        {state.error && <p role="alert" className="vc-stx-form-error">{state.error}</p>}
        {notice && <p role="status">{notice}</p>}
        {editor ? <form className="vc-stx-pp-editor" onSubmit={e => { e.preventDefault(); void run(); }}>
            <div className="vc-stx-pp-editor-body">
            <h4>{editor.id ? "Редактирование" : "Создание"} {editor.kind === "folder" ? "папки" : "шаблона"}</h4>
            {restricted && <p role="status">Общая запись доступна для просмотра. Для изменения нужны права на оба проекта.</p>}
            <fieldset disabled={locked || state.conflict}>
                <label>Название<input autoFocus required maxLength={editor.kind === "folder" ? 120 : 160} value={editor.draft.title} onChange={e => change({ title: e.currentTarget.value })} /></label>
                {editor.kind === "template" && <>
                    <label htmlFor="vc-stx-panel-personal-text">Текст шаблона</label>
                    <TokenToolbar capture={capture} insert={addToken} hasBoundary={editor.draft.text.includes("[[greeting:end]]")} />
                    <textarea id="vc-stx-panel-personal-text" ref={bodyRef} required maxLength={20000} value={editor.draft.text} onChange={e => change({ text: e.currentTarget.value })} />
                </>}
                <div className="vc-stx-pp-grid">
                    {(!editor.id || editor.kind === "template") && <label>Проект<Select aria-label="Проект" value={editor.draft.project} onChange={e => change({ project: e.currentTarget.value as ProjectId, folderId: null })}>
                        {catalog.projects.map(project => <option key={project} value={project}>{projectName(project)}</option>)}
                    </Select></label>}
                    {editor.kind === "template" ? <>
                        <label>Команда<input maxLength={40} placeholder="Без пробелов и /" value={editor.draft.command} onChange={e => change({ command: e.currentTarget.value })} /></label>
                        <label>Папка<Select aria-label="Папка шаблона" value={editor.draft.folderId ?? ""} onChange={e => change({ folderId: e.currentTarget.value || null })}>
                            <option value="">Без папки</option>{catalog.folderRecords.filter(f => editor.draft.shared || f.project === editor.draft.project).map(f => <option key={f.id} value={f.id}>{f.title} · {projectName(f.project)}</option>)}
                        </Select></label>
                        <ColorPicker value={editor.draft.color} colors={catalog.colors} labels={catalog.colorLabels}
                            disabled={locked || state.conflict} onChange={color => change({ color })} />
                    </> : <label>Позиция<input type="number" min={0} max={100000} step={1} required value={editor.draft.position} onChange={e => change({ position: Number(e.currentTarget.value) })} /></label>}
                </div>
                {editor.kind === "template" && <label className="vc-stx-pp-check"><input type="checkbox" disabled={catalog.projects.length !== 2} checked={editor.draft.shared} onChange={e => change({ shared: e.currentTarget.checked, folderId: null })} />Общий для двух проектов</label>}
            </fieldset>
            {editor.kind === "template" && <details className="vc-stx-pp-preview" open><summary>Предпросмотр</summary><div><Markdown text={editor.draft.text} /></div><p className="vc-stx-muted">Переменные заполняются при вставке.</p></details>}
            {state.conflict && <div className="vc-stx-pp-note" role="group" aria-label="Конфликт версии">
                <h4>{ready ? "Текущая запись на панели" : "Текущая версия ещё не загружена"}</h4>{latest ? <><strong>{latest.title}</strong><pre>{"text" in latest ? latest.text : `${projectName(latest.project)} · позиция ${latest.position}`}</pre>
                    <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={busy} onClick={() => setDiscard(true)}>Отменить черновик и открыть текущую запись</button></>
                    : <p>{ready ? "Запись удалена или недоступна." : "Восстановите соединение и обновите библиотеку для сравнения. Ваш черновик сохранён."}</p>}
                {editor.kind === "template" && canWrite && !restricted && <button type="button" className="vc-stx-btn" disabled={busy} onClick={() => update({ editor: { ...editor, id: undefined, version: undefined, draft: { ...editor.draft, title: (editor.draft.title.slice(0, 150) + " (копия)"), command: "" } }, conflict: false, remove: false, pending: null, error: "", dirty: true })}>Продолжить как новый шаблон</button>}
            </div>}
            {state.pending && !busy && <p className="vc-stx-pp-note">Результат пока неизвестен. Повтор отправит те же данные. Перед новой операцией проверьте список на панели.</p>}
            <p className="vc-stx-muted">Несохранённый черновик останется при закрытии настроек до выхода из аккаунта или перезапуска Discord.</p>
            </div>
            <div className="vc-stx-pp-editor-footer">
            <div className="vc-stx-pp-actions">
                <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={busy} onClick={close}>Отмена</button>
                {editor.id && writable && !restricted && !state.pending && !state.conflict && <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={busy || !ready} onClick={() => update({ remove: true })}>Удалить</button>}
                {writable && !restricted && !state.remove && <button className="vc-stx-btn" disabled={busy || !ready || state.conflict}>{busy ? "Сохраняем…" : state.pending ? "Повторить сохранение" : "Сохранить на панели"}</button>}
            </div>
            {state.remove && !state.conflict && <div className="vc-stx-pp-note" role="group" aria-label="Подтверждение удаления"><p>{editor.kind === "folder" ? "Удалить папку? Шаблоны останутся без папки." : "Переместить шаблон в корзину панели на 7 дней?"}</p>
                <button type="button" className="vc-stx-btn" disabled={busy || !ready} onClick={() => void run(true)}>{state.pending ? "Повторить удаление" : "Подтвердить удаление"}</button>
                <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={busy || !!state.pending} onClick={() => update({ remove: false })}>Оставить</button></div>}
            {discard && <div className="vc-stx-pp-note" role="group" aria-label="Несохранённый черновик"><p>Удалить несохранённый черновик?{state.pending && " Отправленная операция уже могла сохраниться на панели."}</p>
                <button type="button" className="vc-stx-btn" disabled={busy} onClick={() => {
                    const replacement = state.conflict && latest ? toEditor(editor.kind, latest) : null;
                    discardPanelDraft(); setDiscard(false);
                    if (replacement) update({ ...empty(), editor: replacement });
                }}>Удалить черновик</button><button type="button" className="vc-stx-btn vc-stx-ghost" disabled={busy} onClick={() => setDiscard(false)}>Продолжить редактирование</button></div>}
            </div>
        </form> : <>
            <div className="vc-stx-pp-grid"><label>Поиск<input value={query} placeholder="Название, текст или команда" onChange={e => setQuery(e.currentTarget.value)} /></label>
                <label>Папка<Select aria-label="Фильтр папок" value={folder} onChange={e => setFolder(e.currentTarget.value)}><option value="all">Все папки</option><option value="none">Без папки</option>
                    {catalog.folderRecords.map(f => <option key={f.id} value={f.id}>{f.title} · {projectName(f.project)}</option>)}</Select></label></div>
            <div className="vc-stx-pp-cards">{rows.map(t => <button type="button" key={t.id} className="vc-stx-pp-card" disabled={busy} onClick={() => begin("template", t)}>
                <strong>{t.title}</strong><span><Markdown text={splitGreeting(t.text).body} /></span><small>{t.shared ? "Общий" : projectName(t.projects[0])}{t.command ? ` · команда ${t.command}` : ""}{t.color ? ` · ${colorName(t.color)}` : ""}</small>
            </button>)}{!rows.length && <p className="vc-stx-muted">{query || folder !== "all" ? "Шаблоны не найдены." : "Личных шаблонов пока нет."}</p>}</div>
            <details className="vc-stx-pp-folders"><summary>Папки · {catalog.folderRecords.length}</summary>
                <div className="vc-stx-pp-folder-list">{catalog.folderRecords.map(f => <button type="button" key={f.id} disabled={busy} onClick={() => begin("folder", f)}><strong>{f.title}</strong><span>{projectName(f.project)}</span></button>)}</div>
                <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={busy || !ready || !canFolders || !catalog.projects.length} onClick={() => begin("folder")}>Создать папку</button>
            </details>
        </>}
    </section>;
}
