/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useState } from "@webpack/common";

import { Select } from "./Select";
import { setTicketSound, testTicketSound, ticketSoundState } from "./ticketSound";

export function TicketSettings() {
    const { options, loaded, error, testing } = ticketSoundState.use();
    const [channels, setChannels] = useState<string | null>(null);
    const [invalid, setInvalid] = useState("");
    return <section className="vc-stx-setting-section">
        <h3>Новые тикеты</h3>
        <fieldset disabled={!loaded} style={{ border: 0, padding: 0, minWidth: 0 }}>
            <label className="vc-stx-check"><input type="checkbox" checked={options.enabled} onChange={e => setTicketSound({ enabled: e.currentTarget.checked })} />Звук при создании тикета</label>
            <p className="vc-stx-muted">Новые ветки в выбранных каналах Majestic и России Онлайн. Сообщения и возврат в общий пул не вызывают этот сигнал.</p>
            <label className="vc-stx-check"><input type="checkbox" checked={options.quietWhenVisible} onChange={e => setTicketSound({ quietWhenVisible: e.currentTarget.checked })} />Без звука, если новый тикет уже открыт и Discord в фокусе</label>
            <label>Громкость: {options.volume}%<input aria-label="Громкость нового тикета" type="range" min={0} max={100} step={5} value={options.volume} onChange={e => setTicketSound({ volume: Number(e.currentTarget.value) })} /></label>
            <div className="vc-stx-row">
                <button className="vc-stx-btn vc-stx-ghost" disabled={testing || options.volume === 0} onClick={() => void testTicketSound()}>{testing ? "Проверяем…" : "Проверить звук"}</button>
                <Select aria-label="Пауза между сигналами" value={String(options.cooldownMs)} onChange={e => setTicketSound({ cooldownMs: Number(e.currentTarget.value) })}>
                    <option value="1000">Пауза 1 секунда</option><option value="3000">Пауза 3 секунды</option><option value="5000">Пауза 5 секунд</option><option value="10000">Пауза 10 секунд</option>
                </Select>
            </div>
            <details className="vc-stx-settings-details"><summary>Каналы техподдержки</summary>
                <p className="vc-stx-muted">ID родительских каналов из TicketSound. При одновременной работе старого плагина звуки могут дублироваться.</p>
                <form onSubmit={e => {
                    e.preventDefault();
                    const ids = (channels ?? options.channelIds.join(", ")).split(/[\s,;]+/).filter(Boolean);
                    if (!ids.length || ids.length > 20 || ids.some(id => !/^\d{17,20}$/.test(id))) { setInvalid("Укажите от 1 до 20 ID каналов через запятую."); return; }
                    setTicketSound({ channelIds: ids }); setChannels(null); setInvalid("");
                }}><label>ID каналов<input aria-label="ID каналов техподдержки" value={channels ?? options.channelIds.join(", ")} onChange={e => setChannels(e.currentTarget.value)} /></label><button className="vc-stx-btn vc-stx-ghost">Сохранить каналы</button></form>
                {invalid && <p role="alert">{invalid}</p>}
            </details>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <h3>Личные напоминания</h3>
        <p className="vc-stx-muted">Следующий этап: 5, 10 или 15 минут ожидания игрока. Для точного таймера нужен источник ответственного и состояния тикета от панели/бота.</p>
    </section>;
}
