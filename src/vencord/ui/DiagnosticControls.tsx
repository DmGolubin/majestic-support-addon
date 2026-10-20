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
    return <section className="vc-stx-diagnostics" aria-label="Диагностика">
        <div className="vc-stx-diagnostic-heading"><h3>Локальная диагностика</h3><span>{journal.active ? "Запись идёт" : "Запись выключена"}</span></div>
        <p>Диагностика включена по умолчанию без ограничения по времени. Её можно выключить; выбор сохраняется после перезапуска. Если возникнет проблема, передайте файл разработчику вместе с описанием.</p>
        <label className="vc-stx-record-toggle"><input type="checkbox" disabled={!available || file.initializing} checked={journal.active} onChange={e => { setRecording(e.currentTarget.checked); refresh(n => n + 1); }} />Записывать диагностику</label>
        {file.path && <p className="vc-stx-diagnostic-note">Файл диагностики:<code className="vc-stx-diagnostic-path">{file.path}</code></p>}
        {file.initializing ? <p role="status">Подключаем сохранение в файл…</p>
            : file.fileError ? <p role="alert">Не удалось сохранить диагностику в файл. Пока можно скачать журнал вручную.</p>
                : file.lastSavedAt > 0 && <p className="vc-stx-diagnostic-note">Файл сохраняется автоматически. Последняя запись: {new Date(file.lastSavedAt).toLocaleTimeString("ru-RU")}.</p>}
        <p className="vc-stx-diagnostic-note">TXT-журнал дополняется событиями с датой и временем после каждого запуска. Ротация: текущий файл и до 9 архивов, каждый до 10 МиБ — до 100 МиБ журналов. Скачиваемый JSON содержит только последние 2 000 событий. Тексты сообщений, шаблонов, полей, нажатия клавиш, токены и содержимое запросов не записываются. Автоматической отправки нет.</p>
        <p className="vc-stx-diagnostic-note">Для полной истории передайте TXT-файл по указанному выше пути вместе с архивами из той же папки. Кнопка ниже скачивает только краткий JSON-отчёт.</p>
        {file.deliveryLost > 0 && <p role="alert">Очередь записи переполнялась: не доставлено событий — {file.deliveryLost}. В файле возможны пропуски.</p>}
        {file.fileError && file.localError && <p role="alert">Резервное сохранение тоже недоступно. Скачайте журнал до перезапуска Discord.</p>}
        <div className="vc-stx-diagnostic-actions">
            {file.fileError && <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => { retryDiagnosticFile(); refresh(n => n + 1); }}>Повторить сохранение</button>}
            <button type="button" className="vc-stx-btn" onClick={() => { try { downloadDiagnostics(); setNotice("Краткий отчёт передан в загрузки. Для полной истории приложите также TXT-файл и архивы."); } catch { setNotice("Не удалось скачать файл. Повторите попытку."); } }}>Скачать краткий отчёт</button>
            <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => setConfirm(true)}>Очистить журнал</button>
        </div>
        {confirm && <div className="vc-stx-diagnostic-actions"><span>Удалить сохранённые события?</span><button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => setConfirm(false)}>Отмена</button><button type="button" className="vc-stx-btn" onClick={() => { journal.clear(); setConfirm(false); refresh(n => n + 1); }}>Удалить журнал</button></div>}
        {notice && <p role="status">{notice}</p>}
    </section>;
}
