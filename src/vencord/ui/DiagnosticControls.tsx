// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from "@webpack/common";
import { diagnosticJournal as journal } from "../core/diagnosticJournal";
import { diagnosticStorageStatus, openDiagnosticFolder, retryDiagnosticFile, setRecording } from "./diagnostics";
import "./diagnostics.css";

export function DiagnosticControls({ available = true }: { available?: boolean; } = {}) {
    const [, refresh] = useState(0);
    const [opening, setOpening] = useState(false);
    const [openError, setOpenError] = useState(false);
    useEffect(() => { const timer = setInterval(() => refresh(n => n + 1), 2000); return () => clearInterval(timer); }, []);
    const file = diagnosticStorageStatus();
    const open = async () => {
        setOpening(true); setOpenError(false);
        try { await openDiagnosticFolder(); } catch { setOpenError(true); }
        finally { setOpening(false); }
    };
    return <section className="vc-stx-diagnostics" aria-label="Диагностика">
        <div className="vc-stx-diagnostic-heading"><h3>Логи</h3><span>{file.initializing ? "Подключение…" : file.fileError ? "Ошибка сохранения" : journal.active ? "Запись включена" : "Запись выключена"}</span></div>
        <label className="vc-stx-record-toggle"><input type="checkbox" disabled={!available || file.initializing} checked={journal.active} onChange={e => { setRecording(e.currentTarget.checked); refresh(n => n + 1); }} />Записывать логи</label>
        <p className="vc-stx-diagnostic-note">Технические события сохраняются локально в main.log. Без текстов сообщений, токенов и автоматической отправки.</p>
        {file.fileError && <p role="alert">Не удалось записать файл. Проверьте свободное место и повторите сохранение.</p>}
        {file.fileError && file.localError && <p role="alert">Резервная запись тоже недоступна. Восстановите сохранение до перезапуска Discord.</p>}
        {file.deliveryLost > 0 && <p role="alert">В истории есть неподтверждённые события: {file.deliveryLost}. Приложите логи к описанию проблемы.</p>}
        {openError && <p role="alert">Не удалось открыть папку логов. Полностью перезапустите Discord после обновления и повторите попытку. Если ошибка сохраняется, проверьте доступ к файлам.</p>}
        <div className="vc-stx-diagnostic-actions">
            <button type="button" className="vc-stx-btn" disabled={opening} onClick={open}>{opening ? "Открываем…" : "Открыть папку логов"}</button>
            {file.fileError && <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => { retryDiagnosticFile(); refresh(n => n + 1); }}>Повторить сохранение</button>}
        </div>
    </section>;
}
