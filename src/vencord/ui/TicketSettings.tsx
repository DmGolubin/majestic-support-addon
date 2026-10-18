/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ticket-settings.css";

import { ChannelStore, useStateFromStores } from "@webpack/common";

import { PROJECTS } from "../core/types";
import { Select } from "./Select";
import { IconBell } from "./svg";
import { setTicketSound, testTicketSound, ticketSoundState } from "./ticketSound";

export function TicketSettings() {
    const { options, loaded, error, testing } = ticketSoundState.use();
    const channels = useStateFromStores([ChannelStore], () => options.channelIds.map(id => {
        const channel = ChannelStore.getChannel(id);
        const project = Object.values(PROJECTS).find(p => p.guildId === channel?.guild_id);
        return { id, name: channel?.name, project: project?.short,
            unsupported: !!channel?.guild_id && !project };
    }), [options.channelIds]);
    // Keep a previously saved custom interval visible instead of displaying a different selection.
    const cooldowns = [...new Set([1000, 3000, 5000, 10000, options.cooldownMs])].sort((a, b) => a - b);

    return <div className="vc-stx-tickets">
        <section className="vc-stx-setting-section vc-stx-ticket-section" aria-label="Новые тикеты">
            <header className="vc-stx-ticket-heading"><IconBell size={18} /><h3>Новые тикеты</h3></header>
            <p className="vc-stx-muted">Звук новой ветки поддержки в Majestic или России Онлайн. Сообщения и возврат в пул не вызывают сигнал.</p>
            <fieldset className="vc-stx-ticket-controls" disabled={!loaded} aria-label="Звук новых тикетов">
                <label className="vc-stx-check"><input type="checkbox" checked={options.enabled} onChange={e => setTicketSound({ enabled: e.currentTarget.checked })} />Звук при создании тикета</label>
                <label className="vc-stx-check"><input type="checkbox" checked={options.quietWhenVisible} onChange={e => setTicketSound({ quietWhenVisible: e.currentTarget.checked })} />Без звука, когда тикет открыт и Discord в фокусе</label>
                <label className="vc-stx-ticket-volume"><span>Громкость <span className="vc-stx-ticket-value">{options.volume}%</span></span>
                    <input aria-label="Громкость нового тикета" aria-valuetext={`${options.volume}%`} type="range" min={0} max={100} step="any" value={options.volume} onChange={e => setTicketSound({ volume: Number(e.currentTarget.value) })} />
                </label>
                <div className="vc-stx-ticket-sound-row">
                    <div className="vc-stx-ticket-cooldown"><span>Между сигналами</span>
                        <Select aria-label="Пауза между сигналами" value={String(options.cooldownMs)} onChange={e => setTicketSound({ cooldownMs: Number(e.currentTarget.value) })}>
                            {cooldowns.map(ms => <option key={ms} value={String(ms)}>{(ms / 1000).toLocaleString("ru-RU")} с</option>)}
                        </Select>
                    </div>
                    <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={testing || options.volume === 0} onClick={() => void testTicketSound()}><IconBell />{testing ? "Проверяем…" : "Проверить звук"}</button>
                </div>
            </fieldset>
            <div className="vc-stx-ticket-channels">
                <span className="vc-stx-muted">Каналы уведомлений</span>
                {!loaded ? <p className="vc-stx-muted" role="status">Загрузка каналов…</p>
                    : channels.length ? <ul>{channels.map((channel, index) => <li key={channel.id}>
                        <span className="vc-stx-ticket-project">{channel.project ?? (channel.unsupported ? "Вне поддерживаемых проектов" : "Проект не определён")}</span>
                        <span>{channel.name ? `#${channel.name}` : `Канал ${index + 1}: название недоступно`}{channel.unsupported && <small>Сигнал для этого канала отключён</small>}</span>
                    </li>)}</ul> : <p className="vc-stx-muted">Каналы не настроены.</p>}
            </div>
            {error && <p className="vc-stx-ticket-error" role="alert">{error}</p>}
        </section>
        <section className="vc-stx-setting-section vc-stx-ticket-section" aria-label="Игрок ждёт ответа">
            <header className="vc-stx-ticket-heading">
                <svg className="vc-stx-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                <h3>Игрок ждёт ответа</h3><span className="vc-stx-ticket-unavailable">Не подключено</span>
            </header>
            <label className="vc-stx-check vc-stx-ticket-disabled"><input type="checkbox" checked={false} disabled />Напоминать в Discord</label>
            <p className="vc-stx-muted">Личные напоминания пока недоступны. Порог ожидания задаётся в Telegram.</p>
        </section>
    </div>;
}
