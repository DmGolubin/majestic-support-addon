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
import { chooseTicketSound, resetTicketSound, retryTicketSoundSettings, setTicketSound, stopTicketSoundPlayback, testTicketSound, ticketSoundState } from "./ticketSound";
import { ReminderSettings } from "./ReminderSettings";

export function TicketSettings() {
    const { options, loaded, error, testing, playing, playbackStatus, customName, loadingSound, canReset } = ticketSoundState.use();
    const volumeLabel = `${Math.round(options.volume)}%`;
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
                <small className="vc-stx-muted">Этот переключатель — для новых тикетов. Личные напоминания включаются отдельно ниже.</small>
                <label className="vc-stx-check"><input type="checkbox" checked={options.quietWhenVisible} onChange={e => setTicketSound({ quietWhenVisible: e.currentTarget.checked })} />Без звука, когда тикет открыт и Discord в фокусе</label>
                <label className="vc-stx-ticket-volume"><span>Громкость <span className="vc-stx-ticket-value">{volumeLabel}</span></span>
                    <input aria-label="Громкость нового тикета" aria-valuetext={volumeLabel} type="range" min={0} max={100} step={1} value={options.volume} onChange={e => setTicketSound({ volume: Number(e.currentTarget.value) })} />
                </label>
                {options.volume === 0 && <p className="vc-stx-muted" role="status">Громкость 0%: новые тикеты, личные напоминания и проверка звука беззвучны. Увеличьте громкость для проверки.</p>}
                <div className="vc-stx-ticket-custom-sound">
                    <span>{loadingSound ? "Загружаем звук…" : customName || "Стандартный звук"}</span>
                    <div className="vc-stx-lib-actions">
                        <label className="vc-stx-btn vc-stx-ghost vc-stx-sound-file">Выбрать свой звук
                            <input type="file" accept="audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/flac,.mp3,.wav,.ogg,.m4a,.flac" aria-label="Выбрать свой звук" disabled={loadingSound || testing} onChange={e => {
                                const file = e.currentTarget.files?.[0]; e.currentTarget.value = "";
                                if (file) void chooseTicketSound(file);
                            }} />
                        </label>
                        {(customName || canReset || loadingSound) && <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={testing} onClick={resetTicketSound}>Вернуть стандартный</button>}
                    </div>
                    <small className="vc-stx-muted">Аудиофайл до 5 МБ и 30 секунд. Сохраняется на этом компьютере.</small>
                </div>
                <div className="vc-stx-ticket-sound-row">
                    <div className="vc-stx-ticket-cooldown"><span>Между сигналами</span>
                        <Select aria-label="Пауза между сигналами" value={String(options.cooldownMs)} onChange={e => setTicketSound({ cooldownMs: Number(e.currentTarget.value) })}>
                            {cooldowns.map(ms => <option key={ms} value={String(ms)}>{(ms / 1000).toLocaleString("ru-RU")} с</option>)}
                        </Select>
                    </div>
                    <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={testing || loadingSound || options.volume === 0} onClick={() => void testTicketSound()}><IconBell />{testing ? "Проверяем…" : customName ? "Проверить свой звук" : "Проверить звук"}</button>
                    {(testing || playing) && <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={stopTicketSoundPlayback}>Остановить звук</button>}
                </div>
                {playbackStatus && <p className="vc-stx-ticket-playback" role="status">{playbackStatus}</p>}
            </fieldset>
            <div className="vc-stx-ticket-channels">
                <span className="vc-stx-muted">Каналы уведомлений</span>
                {!loaded ? <p className="vc-stx-muted" role="status">{error ? "Настройки недоступны." : "Загрузка каналов…"}</p>
                    : channels.length ? <ul>{channels.map((channel, index) => <li key={channel.id}>
                        <span className="vc-stx-ticket-project">{channel.project ?? (channel.unsupported ? "Вне поддерживаемых проектов" : "Проект не определён")}</span>
                        <span>{channel.name ? `#${channel.name}` : `Канал ${index + 1}: название недоступно`}{channel.unsupported && <small>Сигнал для этого канала отключён</small>}</span>
                    </li>)}</ul> : <p className="vc-stx-muted">Каналы не настроены.</p>}
            </div>
            {error && <p className="vc-stx-ticket-error" role="alert">{error}</p>}
            {!loaded && error && <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={retryTicketSoundSettings}>Повторить загрузку настроек</button>}
        </section>
        <ReminderSettings />
    </div>;
}
