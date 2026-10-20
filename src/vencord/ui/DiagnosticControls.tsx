// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from "@webpack/common";
import { diagnosticJournal as journal } from "../core/diagnosticJournal";
import { diagnosticStorageStatus, downloadDiagnostics, retryDiagnosticFile, setRecording } from "./diagnostics";
import "./diagnostics.css";

export function DiagnosticControls({ available = true }: { available?: boolean; } = {}) {
    const [, refresh] = useState(0);
    const [notice, setNotice] = useState("");
    const [confirm, setConfirm] = useState(false);
    useEffect(() => { const timer = setInterval(() => refresh(n => n + 1), 2000); return () => clearInterval(timer); }, []);
    const file = diagnosticStorageStatus();
    const ends = journal.campaignEndsAt;
    const expired = ends > 0 && ends <= Date.now();
    return <section className="vc-stx-diagnostics" aria-label="Диагностика">
        <div className="vc-stx-diagnostic-heading"><h3>Диагностика тестовой версии</h3><span>{journal.active ? "Запись идёт" : expired ? "Тестовый период завершён" : "Запись выключена"}</span></div>
        <p>В этой тестовой версии диагностика включена автоматически на четыре дня с первого запуска. Если возникнет проблема, передайте файл разработчику вместе с описанием.</p>
        <label className="vc-stx-record-toggle"><input type="checkbox" disabled={!available || expired || file.initializing} checked={journal.active} onChange={e => { setRecording(e.currentTarget.checked); refresh(n => n + 1); }} />Записывать диагностику</label>
        {ends > 0 && <p className="vc-stx-diagnostic-note">{expired ? "Запись завершена" : "Автоматическое отключение"}: {new Date(ends).toLocaleString("ru-RU")}. Перезапуск Discord не продлевает срок.</p>}
        {file.path && <p className="vc-stx-diagnostic-note">Файл диагностики:<code className="vc-stx-diagnostic-path">{file.path}</code></p>}
        {file.initializing ? <p role="status">Подключаем сохранение в файл…</p>
            : file.fileError ? <p role="alert">Не удалось сохранить диагностику в файл. Пока можно скачать журнал вручную.</p>
                : file.lastSavedAt > 0 && <p className="vc-stx-diagnostic-note">Файл сохраняется автоматически. Последняя запись: {new Date(file.lastSavedAt).toLocaleTimeString("ru-RU")}.</p>}
        <p className="vc-stx-diagnostic-note">Хранятся последние 2 000 событий за тестовый период. Тексты сообщений, шаблонов, полей, токены и содержимое запросов не записываются. Файл никуда не отправляется автоматически.</p>
        {file.fileError && file.localError && <p role="alert">Резервное сохранение тоже недоступно. Скачайте журнал до перезапуска Discord.</p>}
        <div className="vc-stx-diagnostic-actions">
            {file.fileError && <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => { retryDiagnosticFile(); refresh(n => n + 1); }}>Повторить сохранение</button>}
            <button type="button" className="vc-stx-btn" onClick={() => { try { downloadDiagnostics(); setNotice("Файл передан в загрузки. Прикрепите его к описанию проблемы."); } catch { setNotice("Не удалось скачать файл. Повторите попытку."); } }}>Скачать диагностику</button>
            <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => setConfirm(true)}>Очистить журнал</button>
        </div>
        {confirm && <div className="vc-stx-diagnostic-actions"><span>Удалить сохранённые события?</span><button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => setConfirm(false)}>Отмена</button><button type="button" className="vc-stx-btn" onClick={() => { journal.clear(); setConfirm(false); refresh(n => n + 1); }}>Удалить журнал</button></div>}
        {notice && <p role="status">{notice}</p>}
    </section>;
}
