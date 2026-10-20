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
        <p className="vc-stx-diagnostic-path">{file.path ? <code>{file.path}</code> : file.initializing ? "Определяем путь…" : "Путь к логам пока недоступен"}</p>
        {(file.fileError || file.localError) && <p role="alert">{file.fileError
            ? file.localError ? "Не удалось сохранить логи и резервную копию." : "Не удалось сохранить логи."
            : "Резервная копия логов недоступна."}</p>}
        {openError && <p role="alert">Не удалось открыть папку логов. Повторите попытку.</p>}
        <div className="vc-stx-diagnostic-actions">
            <button type="button" className="vc-stx-btn" disabled={opening} onClick={open}>{opening ? "Открываем…" : "Открыть папку логов"}</button>
            {file.fileError && <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => { retryDiagnosticFile(); refresh(n => n + 1); }}>Повторить сохранение</button>}
        </div>
    </section>;
}
