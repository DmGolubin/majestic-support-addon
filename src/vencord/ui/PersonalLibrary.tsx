/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useRef, useState } from "@webpack/common";

import { PERSONAL_COLORS, PersonalDraft, PersonalTemplate } from "../core/personal";
import { insertToken } from "../core/tokenEditor";
import { ProjectId } from "../core/types";
import { demo } from "./demo";
import { TokenToolbar } from "./TokenToolbar";
import { store, useStore } from "./uiState";

const COLOR_NAMES = ["Красный", "Оранжевый", "Жёлтый", "Зелёный", "Бирюзовый", "Синий", "Фиолетовый", "Розовый"];
const blank = (): PersonalDraft => ({ title: "", text: "", project: "mj", color: null, command: null, folderId: null });

/** Same fields as the panel; only the local prototype is connected at this stage. */
export function PersonalLibrary({ onDirty }: { onDirty?(dirty: boolean): void; }) {
    useStore();
    const isDemo = demo.useSelect(d => d.enabled);
    const [editing, setEditing] = useState<{ id?: string; draft: PersonalDraft; } | null>(null);
    const [dirty, setDirty] = useState(false);
    const [discard, setDiscard] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [query, setQuery] = useState("");
    const [folder, setFolder] = useState("all");
    const [project, setProject] = useState("all");
    const [folderEdit, setFolderEdit] = useState<{ id?: string; name: string; } | null>(null);
    const [remove, setRemove] = useState<{ kind: "template" | "folder"; id: string; name: string; } | null>(null);
    const bodyRef = useRef<HTMLTextAreaElement>(null);
    const newId = useRef("");
    const newFolderId = useRef("");
    const mark = (v: boolean) => { setDirty(v); onDirty?.(v); };
    const begin = (t?: PersonalTemplate, copy = false) => {
        newId.current = "personal:" + crypto.randomUUID();
        setEditing(t ? { id: copy ? undefined : t.id, draft: { ...t, title: copy ? t.title + " (копия)" : t.title, command: copy ? null : t.command } } : { draft: { ...blank(), folderId: folder !== "all" && folder !== "none" ? folder : null } });
        setError(""); setNotice(""); mark(false);
    };
    const close = () => { setEditing(null); setDiscard(false); mark(false); };
    const change = (patch: Partial<PersonalDraft>) => {
        if (!editing) return;
        setEditing({ ...editing, draft: { ...editing.draft, ...patch } }); mark(true);
    };
    const run = async (action: () => Promise<void>) => {
        if (busy) return;
        setBusy(true); setError("");
        try { await action(); } catch (e) { setError(String((e as Error).message) + ". Проверьте данные и повторите сохранение."); }
        finally { setBusy(false); }
    };
    const range = useRef({ start: 0, end: 0 });
    const captureRange = () => {
        const el = bodyRef.current;
        if (el) range.current = { start: el.selectionStart, end: el.selectionEnd };
    };
    const addToken = (token: string) => {
        const el = bodyRef.current;
        if (!el || !editing) return false;
        try {
            const next = insertToken(editing.draft.text, range.current.start, range.current.end, token);
            change({ text: next.text }); setError("");
            range.current = { start: next.caret, end: next.caret };
            requestAnimationFrame(() => { if (el.isConnected) { el.focus(); el.setSelectionRange(next.caret, next.caret); } });
            return true;
        } catch (e) { setError((e as Error).message); return false; }
    };
    const list = store.data.personal.filter(t => (folder === "all" || (folder === "none" ? !t.folderId : t.folderId === folder))
        && (project === "all" || t.project === null || t.project === project)
        && `${t.title} ${t.text} ${t.command ?? ""}`.toLowerCase().includes(query.toLowerCase()));

    return <section className="vc-stx-library">
        <div className="vc-stx-lib-title"><div><h3>Мои шаблоны</h3><span className="vc-stx-storage-note">{isDemo ? "Демо · до выхода" : "На этом устройстве"}</span></div>
            {!editing && <button className="vc-stx-btn" disabled={!!folderEdit || busy} onClick={() => begin()}>Добавить шаблон</button>}</div>
        {error && <p role="alert" className="vc-stx-form-error">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {editing ? <form className="vc-stx-personal-form" onSubmit={e => { e.preventDefault(); void run(async () => {
            // Keep the ID even if persistence fails: retry must update, not create a duplicate.
            const id = editing.id ?? newId.current;
            const exists = store.data.personal.some(t => t.id === id);
            await store.savePersonal(editing.draft, exists ? id : undefined, exists ? undefined : id);
            setNotice("Шаблон сохранён"); close();
        }); }}>
            <h4>{editing.id ? "Редактирование шаблона" : "Новый шаблон"}</h4>
            <fieldset disabled={busy}>
                <label>Название<input autoFocus maxLength={160} required value={editing.draft.title} onChange={e => change({ title: e.currentTarget.value })} /></label>
                <label htmlFor="vc-stx-personal-text">Текст шаблона</label>
                <TokenToolbar capture={captureRange} insert={addToken} hasBoundary={editing.draft.text.includes("[[greeting:end]]")} />
                <textarea id="vc-stx-personal-text" ref={bodyRef} required maxLength={20000} value={editing.draft.text} onChange={e => change({ text: e.currentTarget.value })} />
                <details className="vc-stx-settings-details"><summary>Как работают переменные</summary><p className="vc-stx-muted">Заполняются при вставке. Граница отделяет приветствие; ссылка и заголовок относятся к каналу Discord.</p></details>
                <span>Цвет</span><div className="vc-stx-colors" role="group" aria-label="Цвет шаблона">
                    <button type="button" aria-pressed={!editing.draft.color} onClick={() => change({ color: null })}>Нет</button>
                    {PERSONAL_COLORS.map((c, i) => <button type="button" key={c} aria-label={COLOR_NAMES[i]} title={COLOR_NAMES[i]} aria-pressed={editing.draft.color === c} style={{ "--swatch": c } as React.CSSProperties} onClick={() => change({ color: c })}><span /></button>)}
                </div>
                <div className="vc-stx-form-grid">
                    <label>Проект<select aria-label="Проект" value={editing.draft.project ?? "shared"} onChange={e => change({ project: e.currentTarget.value === "shared" ? null : e.currentTarget.value as ProjectId })}><option value="mj">Majestic</option><option value="ro">Россия Онлайн</option><option value="shared">Общий для двух проектов</option></select></label>
                    <label>Папка<select aria-label="Папка" value={editing.draft.folderId ?? ""} onChange={e => change({ folderId: e.currentTarget.value || null })}><option value="">Без папки</option>{store.data.folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
                </div>
                <label>Команда (необязательно)<input maxLength={40} placeholder="Например: drivers" value={editing.draft.command ?? ""} onChange={e => change({ command: e.currentTarget.value || null })} /></label>
                <p className="vc-stx-muted">Вызов в чате: {store.data.prefix}{editing.draft.command || "drivers"}</p>
            </fieldset>
            {discard && <div className="vc-stx-local-note" role="alert">Отменить несохранённые изменения? <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={close}>Отменить изменения</button><button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => setDiscard(false)}>Продолжить редактирование</button></div>}
            <div className="vc-stx-lib-actions vc-stx-editor-actions"><button type="button" className="vc-stx-btn vc-stx-ghost" disabled={busy} onClick={() => dirty ? setDiscard(true) : close()}>Назад</button><button type="submit" className="vc-stx-btn" disabled={busy}>{busy ? "Сохранение…" : "Сохранить"}</button></div>
        </form> : <>
            <div className="vc-stx-form-grid"><label>Поиск<input value={query} onChange={e => setQuery(e.currentTarget.value)} placeholder="Название, текст или команда" /></label><label>Проект<select aria-label="Проект" value={project} onChange={e => setProject(e.currentTarget.value)}><option value="all">Все проекты</option><option value="mj">Majestic и общие</option><option value="ro">Россия Онлайн и общие</option></select></label></div>
            <div className="vc-stx-folder-bar"><label>Папка<select aria-label="Папка" value={folder} onChange={e => setFolder(e.currentTarget.value)}><option value="all">Все папки</option><option value="none">Без папки</option>{store.data.folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
                <button className="vc-stx-btn vc-stx-ghost" disabled={!!folderEdit || busy} onClick={() => { newFolderId.current = "folder:" + crypto.randomUUID(); setFolderEdit({ name: "" }); mark(true); }}>Создать папку</button>
                {store.data.folders.some(f => f.id === folder) && <><button className="vc-stx-btn vc-stx-ghost" disabled={!!folderEdit || busy} onClick={() => { setFolderEdit({ id: folder, name: store.data.folders.find(f => f.id === folder)!.name }); mark(true); }}>Переименовать</button><button className="vc-stx-btn vc-stx-ghost" onClick={() => setRemove({ kind: "folder", id: folder, name: store.data.folders.find(f => f.id === folder)!.name })}>Удалить папку</button></>}
            </div>
            {folderEdit && <form className="vc-stx-folder-bar" onSubmit={e => { e.preventDefault(); void run(async () => { const candidate = folderEdit.id ?? newFolderId.current; const exists = store.data.folders.some(f => f.id === candidate); const id = await store.saveFolder(folderEdit.name, exists ? candidate : undefined, exists ? undefined : candidate); setFolder(id); setFolderEdit(null); mark(false); }); }}><label>Название папки<input autoFocus required maxLength={80} value={folderEdit.name} onChange={e => setFolderEdit({ ...folderEdit, name: e.currentTarget.value })} /></label><button className="vc-stx-btn" disabled={busy}>Сохранить папку</button><button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => { setFolderEdit(null); mark(false); }}>Отмена</button></form>}
            {remove && <div className="vc-stx-local-note" role="alert"><p>Удалить {remove.kind === "folder" ? "папку" : "шаблон"} «{remove.name}»? {remove.kind === "folder" && "Шаблоны останутся в разделе «Без папки»."}</p><button className="vc-stx-btn" disabled={busy} onClick={() => void run(async () => { if (remove.kind === "folder") { await store.deleteFolder(remove.id); setFolder("all"); } else await store.deletePersonal(remove.id); setRemove(null); })}>Удалить</button> <button className="vc-stx-btn vc-stx-ghost" onClick={() => setRemove(null)}>Отмена</button></div>}
            <p className="vc-stx-muted">Шаблоны · {list.length}</p>
            {!list.length && <div className="vc-stx-library-empty"><h4>{store.data.personal.length ? "Нет совпадений" : "Здесь будут ваши ответы"}</h4><p>{store.data.personal.length ? "Измените поиск или фильтр папок." : "Нажмите «Добавить шаблон», чтобы создать первый ответ."}</p></div>}
            {list.map(t => <article key={t.id} className="vc-stx-personal-card" style={{ borderLeftColor: t.color ?? undefined }}><h4>{t.title}</h4><p className="vc-stx-muted">{t.project === "mj" ? "Majestic" : t.project === "ro" ? "Россия Онлайн" : "Общий"} · {store.data.folders.find(f => f.id === t.folderId)?.name ?? "Без папки"}{t.command && ` · ${store.data.prefix}${t.command}`}</p><pre>{t.text}</pre><div className="vc-stx-lib-actions"><button className="vc-stx-btn vc-stx-ghost" disabled={!!folderEdit || busy} onClick={() => begin(t)}>Редактировать</button><button className="vc-stx-btn vc-stx-ghost" disabled={!!folderEdit || busy} onClick={() => begin(t, true)}>Создать копию</button><button className="vc-stx-btn vc-stx-ghost" onClick={() => setRemove({ kind: "template", id: t.id, name: t.title })}>Удалить</button></div></article>)}
        </>}
    </section>;
}
