/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ticket-settings.css";

import { ChannelStore, useStateFromStores } from "@webpack/common";

import { channelTicketSound } from "../core/ticketSound";
import { PROJECTS } from "../core/types";
import { Select } from "./Select";
import { IconBell } from "./svg";
import { chooseTicketSound, resetTicketSound, retryTicketSoundSettings, setChannelTicketSound, setTicketSound, stopTicketSoundPlayback, testTicketSound, ticketSoundState } from "./ticketSound";
import { ReminderSettings } from "./ReminderSettings";

export function TicketSettings() {
    const state = ticketSoundState.use();
    const { options, loaded, error, testing, playing, playbackStatus } = state;
    const channels = useStateFromStores([ChannelStore], () => options.channelIds.map(id => {
        const channel = ChannelStore.getChannel(id);
        const project = [PROJECTS.mj, PROJECTS.ro].find(p => p.guildId === channel?.guild_id);
        return { id, name: channel?.name, project: project?.short, unsupported: !!channel?.guild_id && !project };
    }), [options.channelIds]);

    // Reuse the same picker/reset/test controls for each independent audio record.
    const audioControls = (parentId?: string) => {
        const sound = parentId ? state.channelAudio?.[parentId] : state;
        const config = parentId ? channelTicketSound(options, parentId) : options;
        const customName = sound?.customName ?? "";
        const loadingSound = sound?.loadingSound ?? false;
        const mutedPreview = !!parentId && (!config.enabled || config.volume === 0);
        return <div className="vc-stx-ticket-custom-sound">
            <span>{loadingSound ? "Загружаем звук…" : customName || "Стандартный звук"}</span>
            <div className="vc-stx-lib-actions">
                <label className="vc-stx-btn vc-stx-ghost vc-stx-sound-file">Выбрать свой звук
                    <input type="file" accept="audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/flac,.mp3,.wav,.ogg,.m4a,.flac" aria-label="Выбрать свой звук" disabled={loadingSound || testing} onChange={e => {
                        const file = e.currentTarget.files?.[0]; e.currentTarget.value = "";
                        if (file) void chooseTicketSound(file, parentId);
                    }} />
                </label>
                {(customName || sound?.canReset || loadingSound) && <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={testing} onClick={() => resetTicketSound(parentId)}>Вернуть стандартный</button>}
                <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={testing || loadingSound || (!parentId && config.volume === 0)} onClick={() => void testTicketSound(parentId)}><IconBell />{testing ? "Проверяем…" : mutedPreview ? `Проверить при выключенном звуке (${config.volume || 30}%)` : customName ? "Проверить свой звук" : "Проверить звук"}</button>
            </div>
            <small className="vc-stx-muted">Аудиофайл до 5 МБ и 30 секунд. Сохраняется на этом компьютере.</small>
            {mutedPreview && <small className="vc-stx-muted">Кнопка проверки временно проиграет звук, даже если канал выключен. При 0% проверка использует 30%. Настройки канала не изменятся.</small>}
            {parentId && sound?.error && <p className="vc-stx-ticket-error" role="alert">{sound.error}</p>}
        </div>;
    };

    return <div className="vc-stx-tickets">
        <section className="vc-stx-setting-section vc-stx-ticket-section" aria-label="Новые тикеты">
            <header className="vc-stx-ticket-heading"><IconBell size={18} /><h3>Новые тикеты</h3></header>
            <p className="vc-stx-muted">Все новые ветки в выбранном канале поддержки Majestic или России Онлайн, независимо от назначения вам. Сообщения и возврат в пул не вызывают сигнал. Каждый канал настраивается отдельно.</p>
            {!loaded ? <p className="vc-stx-muted" role="status">{error ? "Настройки недоступны." : "Загрузка каналов…"}</p>
                : !channels.length && <p className="vc-stx-muted">Каналы не настроены.</p>}
            {loaded && channels.map((channel, index) => {
                const config = channelTicketSound(options, channel.id);
                const label = `${channel.project ?? (channel.unsupported ? "Вне поддерживаемых проектов" : "Проект не определён")} · ${channel.name ? `#${channel.name}` : `Канал ${index + 1}: название недоступно`}`;
                const volume = `${Math.round(config.volume)}%`;
                const cooldowns = [...new Set([1000, 3000, 5000, 10000, config.cooldownMs])].sort((a, b) => a - b);
                return <fieldset key={channel.id} className="vc-stx-ticket-controls vc-stx-ticket-channel" disabled={channel.unsupported} aria-label={label}>
                    <legend>{label}</legend>
                    {channel.unsupported && <small>Сигнал для этого канала отключён</small>}
                    <label className="vc-stx-check"><input type="checkbox" checked={config.enabled} onChange={e => setChannelTicketSound(channel.id, { enabled: e.currentTarget.checked })} />Звук новых тикетов в этом канале</label>
                    <label className="vc-stx-check"><input type="checkbox" checked={config.quietWhenVisible} onChange={e => setChannelTicketSound(channel.id, { quietWhenVisible: e.currentTarget.checked })} />Без звука, когда тикет открыт и Discord в фокусе</label>
                    <label className="vc-stx-ticket-volume"><span>Громкость <span className="vc-stx-ticket-value">{volume}</span></span>
                        <input aria-label="Громкость новых тикетов канала" aria-valuetext={volume} type="range" min={0} max={100} step={1} value={config.volume} onChange={e => setChannelTicketSound(channel.id, { volume: Number(e.currentTarget.value) })} />
                    </label>
                    {config.volume === 0 && <small className="vc-stx-muted">0%: автоматические сигналы этого канала выключены.</small>}
                    <label className="vc-stx-ticket-cooldown"><span>Между сигналами этого канала</span>
                        <Select aria-label="Пауза между сигналами канала" value={String(config.cooldownMs)} onChange={e => setChannelTicketSound(channel.id, { cooldownMs: Number(e.currentTarget.value) })}>
                            {cooldowns.map(ms => <option key={ms} value={String(ms)}>{(ms / 1000).toLocaleString("ru-RU")} с</option>)}
                        </Select>
                    </label>
                    {audioControls(channel.id)}
                </fieldset>;
            })}
        </section>
        <ReminderSettings />
        <section className="vc-stx-setting-section vc-stx-ticket-section" aria-label="Звук личных напоминаний">
            <header className="vc-stx-ticket-heading"><IconBell size={18} /><h3>Звук личных напоминаний</h3></header>
            <p className="vc-stx-muted">Для назначенных вам тикетов по правилам личных напоминаний выше. Громкость и файл общие для личных напоминаний обоих проектов; настройки новых тикетов на них не влияют.</p>
            <fieldset className="vc-stx-ticket-controls" disabled={!loaded} aria-label="Аудио личных напоминаний">
                <label className="vc-stx-ticket-volume"><span>Громкость <span className="vc-stx-ticket-value">{Math.round(options.volume)}%</span></span>
                    <input aria-label="Громкость личных напоминаний" aria-valuetext={`${Math.round(options.volume)}%`} type="range" min={0} max={100} step={1} value={options.volume} onChange={e => setTicketSound({ volume: Number(e.currentTarget.value) })} />
                </label>
                {options.volume === 0 && <small className="vc-stx-muted">0%: личные напоминания и их проверка беззвучны. Новые тикеты настраиваются отдельно выше.</small>}
                {audioControls()}
            </fieldset>
        </section>
        {(testing || playing) && <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={stopTicketSoundPlayback}>Остановить звук</button>}
        {playbackStatus && <p className="vc-stx-ticket-playback" role="status">{playbackStatus}</p>}
        {error && <p className="vc-stx-ticket-error" role="alert">{error}</p>}
        {!loaded && error && <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={retryTicketSoundSettings}>Повторить загрузку настроек</button>}
    </div>;
}
