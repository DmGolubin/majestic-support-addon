// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from "@webpack/common";
import { diagnosticJournal as journal } from "../core/diagnosticJournal";
import { downloadDiagnostics, setRecording } from "./diagnostics";
import "./diagnostics.css";

export function DiagnosticControls({ available = true }: { available?: boolean; } = {}) {
    const [, refresh] = useState(0);
    const [notice, setNotice] = useState("");
    const [confirm, setConfirm] = useState(false);
    useEffect(() => { const timer = setInterval(() => refresh(n => n + 1), 2000); return () => clearInterval(timer); }, []);
    return <section className="vc-stx-diagnostics" aria-label="Диагностика">
        <div className="vc-stx-diagnostic-heading"><h3>Диагностика для тестера</h3><span>{journal.active ? "Запись идёт" : "Запись выключена"}</span></div>
        <p>Включите перед проверкой. Если пропадёт вход или возникнет ошибка, скачайте файл и передайте его разработчику.</p>
        <label className="vc-stx-record-toggle"><input type="checkbox" disabled={!available} checked={journal.active} onChange={e => { setRecording(e.currentTarget.checked); refresh(n => n + 1); }} />Записывать диагностику на 24 часа</label>
        <p className="vc-stx-diagnostic-note">Сохраняются последние 2 000 событий, до 512 КиБ. Запись переживает Ctrl+R. Тексты сообщений, шаблонов, полей и токены не записываются. Файл никуда не отправляется автоматически.</p>
        {journal.storageFailed && <p role="alert">Локальное сохранение недоступно. Скачайте файл до перезапуска Discord.</p>}
        <div className="vc-stx-diagnostic-actions">
            <button type="button" className="vc-stx-btn" onClick={() => { try { downloadDiagnostics(); setNotice("Файл передан в загрузки. Прикрепите его к описанию проблемы."); } catch { setNotice("Не удалось скачать файл. Повторите попытку."); } }}>Скачать диагностику</button>
            <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => setConfirm(true)}>Очистить журнал</button>
        </div>
        {confirm && <div className="vc-stx-diagnostic-actions"><span>Удалить сохранённые события?</span><button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => setConfirm(false)}>Отмена</button><button type="button" className="vc-stx-btn" onClick={() => { journal.clear(); setConfirm(false); refresh(n => n + 1); }}>Удалить журнал</button></div>}
        {notice && <p role="status">{notice}</p>}
    </section>;
}
