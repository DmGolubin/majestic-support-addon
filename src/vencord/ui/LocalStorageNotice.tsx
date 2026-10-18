/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useState } from "@webpack/common";
import { realStore } from "./uiState";

export function LocalStorageNotice() {
    const [failed, setFailed] = useState(realStore.loadError);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        const update = () => setFailed(realStore.loadError);
        const off = realStore.subscribe(update);
        update();
        return off;
    }, []);
    if (!failed) return null;
    return <div className="vc-stx-local-note" role="alert">
        Локальные настройки не удалось прочитать. Сохранённые данные не перезаписываются.
        <div className="vc-stx-lib-actions"><button type="button" className="vc-stx-btn vc-stx-ghost" disabled={busy}
            onClick={() => {
                setBusy(true);
                void realStore.load().catch(() => {}).finally(() => setBusy(false));
            }}>{busy ? "Читаем…" : "Повторить чтение"}</button></div>
    </div>;
}
