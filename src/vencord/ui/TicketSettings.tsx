/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ticket-settings.css";

import { ChannelStore, useState, useStateFromStores } from "@webpack/common";

import { channelTicketSound, reminderTicketSound, ReminderSoundProject } from "../core/ticketSound";
import { PROJECTS } from "../core/types";
import { Select } from "./Select";
import { ProjectIcon } from "./ProjectIcon";
import { IconBell } from "./svg";
import { chooseTicketSound, resetTicketSound, retryTicketSoundSettings, setChannelTicketSound, setReminderTicketSound, chooseReminderSound, resetReminderSound, testReminderSound, stopTicketSoundPlayback, testTicketSound, ticketSoundState } from "./ticketSound";
import { ReminderSettings } from "./ReminderSettings";
import { previewTicketReminderNotification, ticketRemindersState } from "./ticketReminders";

const percent = (value: number) => `${Math.round(value)}%`;

export function TicketSettings() {
    const state = ticketSoundState.use();
    const reminders = ticketRemindersState.use();
    const { options, loaded, error, testing, playing, playbackStatus } = state;
    const [previewLabel, setPreviewLabel] = useState<string | null>(null);
    const playbackLabel = testing ? "Подготовка звука…" : playing
        ? previewLabel ?? (playbackStatus.startsWith("Воспроизводится свой звук.") ? "Свой звук" : "Стандартный звук")
        : playbackStatus.startsWith("Тест завершён.") ? "Проверка завершена"
            : playbackStatus.startsWith("Воспроизведение остановлено.") ? "Остановлено"
                : playbackStatus.startsWith("Свой звук загружен.") ? "Свой звук загружен"
                    : playbackStatus.replace(/(\d+(?:\.\d+)?)%/g, (_, value) => percent(Number(value)));
    const channels = useStateFromStores([ChannelStore], () => options.channelIds.map(id => {
        const channel = ChannelStore.getChannel(id);
        const projectId = (["mj", "ro"] as const).find(key => PROJECTS[key].guildId === channel?.guild_id);
        return { id, name: channel?.name, projectId, project: projectId ? PROJECTS[projectId].short : undefined, unsupported: !!channel?.guild_id && !projectId };
    }), [options.channelIds]);

    // Reuse the same picker/reset/test controls for each independent audio record.
    const audioControls = (parentId?: string, project?: ReminderSoundProject) => {
        const sound = project ? state.reminderAudio?.[project] : parentId ? state.channelAudio?.[parentId] : state;
        const config = project ? reminderTicketSound(options, project) : parentId ? channelTicketSound(options, parentId) : options;
        const customName = sound?.customName ?? "";
        const loadingSound = sound?.loadingSound ?? false;
        const mutedPreview = !!(parentId || project) && (!config.enabled || config.volume === 0 || !!project && !reminders.settings?.discordEnabled);
        return <div className="vc-stx-ticket-custom-sound">
            <div className="vc-stx-ticket-sound-name"><span className="vc-stx-muted">Звук</span><span>{loadingSound ? "Загружаем…" : customName || "Стандартный"}</span></div>
            <div className="vc-stx-ticket-audio-actions">
                <label className="vc-stx-btn vc-stx-ghost vc-stx-sound-file">Выбрать файл
                    <input type="file" accept="audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/flac,.mp3,.wav,.ogg,.m4a,.flac" aria-label="Выбрать свой звук" disabled={loadingSound || testing} onChange={e => {
                        const file = e.currentTarget.files?.[0]; e.currentTarget.value = "";
                        if (file) void (project ? chooseReminderSound(file, project) : chooseTicketSound(file, parentId));
                    }} />
                </label>
                <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={testing || loadingSound}
                    title={mutedPreview ? `Проверить на ${percent(config.volume || 30)}, не включая уведомления` : undefined}
                    onClick={() => {
                        setPreviewLabel(customName ? "Свой звук" : "Стандартный звук");
                        void (project ? testReminderSound(project) : testTicketSound(parentId));
                    }} aria-busy={testing}><IconBell />Проверить звук</button>
                {(customName || sound?.canReset || loadingSound) && <button type="button" className="vc-stx-btn vc-stx-ghost vc-stx-ticket-reset" disabled={testing} onClick={() => project ? resetReminderSound(project) : resetTicketSound(parentId)}>Вернуть стандартный</button>}
            </div>
            <small className="vc-stx-muted">До 5 МБ · до 30 с · хранится локально</small>
            {(parentId || project) && sound?.error && <p className="vc-stx-ticket-error" role="alert">{sound.error}</p>}
        </div>;
    };

    return <div className="vc-stx-tickets">
        <section className="vc-stx-setting-section vc-stx-ticket-section" aria-label="Новые тикеты">
            <header className="vc-stx-ticket-heading"><IconBell size={18} /><h3>Новые тикеты</h3></header>
            <p className="vc-stx-muted">Все новые тикеты канала, не только назначенные вам. Сообщения и возврат в пул — без сигнала.</p>
            {!loaded ? <p className="vc-stx-muted" role="status">{error ? "Настройки недоступны." : "Загрузка каналов…"}</p>
                : !channels.length && <p className="vc-stx-muted">Каналы не настроены.</p>}
            <div className="vc-stx-ticket-card-grid">{loaded && channels.map((channel, index) => {
                const config = channelTicketSound(options, channel.id);
                const label = `${channel.project ?? (channel.unsupported ? "Вне поддерживаемых проектов" : "Проект не определён")} · ${channel.name ? `#${channel.name}` : `Канал ${index + 1}: название недоступно`}`;
                const volume = percent(config.volume);
                const cooldowns = [...new Set([1000, 3000, 5000, 10000, config.cooldownMs])].sort((a, b) => a - b);
                return <fieldset key={channel.id} className="vc-stx-ticket-controls vc-stx-ticket-channel" disabled={channel.unsupported} aria-label={label}>
                    <div className="vc-stx-ticket-card-heading">
                        <span aria-hidden="true"><ProjectIcon project={channel.projectId ?? null} size={24} /></span>
                        <div><strong>{channel.project ?? (channel.unsupported ? "Другой сервер" : "Проект не определён")}</strong><span>{channel.name ? `#${channel.name}` : `Канал ${index + 1}: название недоступно`}</span></div>
                    </div>
                    {channel.unsupported && <small>Сигнал для этого канала отключён</small>}
                    <label className="vc-stx-check"><input type="checkbox" checked={config.enabled} onChange={e => setChannelTicketSound(channel.id, { enabled: e.currentTarget.checked })} />Звук новых тикетов</label>
                    <label className="vc-stx-check"><input type="checkbox" checked={config.quietWhenVisible} onChange={e => setChannelTicketSound(channel.id, { quietWhenVisible: e.currentTarget.checked })} />Тихо, если тикет открыт и Discord в фокусе</label>
                    <div className="vc-stx-ticket-level-row">
                        <label className="vc-stx-ticket-volume"><span>Громкость <span className="vc-stx-ticket-value">{volume}</span></span>
                            <input aria-label="Громкость новых тикетов канала" aria-valuetext={volume} type="range" min={0} max={100} step={1} value={config.volume} onChange={e => setChannelTicketSound(channel.id, { volume: Number(e.currentTarget.value) })} />
                        </label>
                        <label className="vc-stx-ticket-cooldown"><span>Пауза</span>
                            <Select aria-label="Пауза между сигналами канала" value={String(config.cooldownMs)} onChange={e => setChannelTicketSound(channel.id, { cooldownMs: Number(e.currentTarget.value) })}>
                                {cooldowns.map(ms => <option key={ms} value={String(ms)}>{(ms / 1000).toLocaleString("ru-RU")} с</option>)}
                            </Select>
                        </label>
                    </div>
                    {config.volume === 0 && <small className="vc-stx-muted">0% — новые тикеты без звука.</small>}
                    {audioControls(channel.id)}
                </fieldset>;
            })}</div>
        </section>
        <ReminderSettings>
            <div className="vc-stx-ticket-card-grid">{reminders.settings?.projects.map(({ project, personalReminderMinutes }) => {
                const config = reminderTicketSound(options, project);
                const projectId = project === "majestic" ? "mj" : "ro";
                const name = PROJECTS[projectId].short;
                return <fieldset key={project} className="vc-stx-ticket-controls vc-stx-ticket-channel" disabled={!loaded} aria-label={`Личные напоминания · ${name}`}>
                    <div className="vc-stx-ticket-card-heading">
                        <span aria-hidden="true"><ProjectIcon project={projectId} size={24} /></span>
                        <div><strong>{name}</strong><span>Игрок ждёт ответа · {personalReminderMinutes} мин</span></div>
                    </div>
                    <label className="vc-stx-check"><input type="checkbox" checked={config.enabled} onChange={e => setReminderTicketSound(project, { enabled: e.currentTarget.checked })} />Напоминания этого сервера</label>
                    {!reminders.settings?.discordEnabled && <p className="vc-stx-ticket-project-note">Общий переключатель напоминаний выключен.</p>}
                    <label className="vc-stx-ticket-volume"><span>Громкость <span className="vc-stx-ticket-value">{percent(config.volume)}</span></span>
                        <input aria-label={`Громкость личных напоминаний · ${name}`} aria-valuetext={percent(config.volume)} type="range" min={0} max={100} step={1} value={config.volume} onChange={e => setReminderTicketSound(project, { volume: Number(e.currentTarget.value) })} />
                    </label>
                    {config.volume === 0 && <small className="vc-stx-muted">0% — напоминания этого сервера без звука.</small>}
                    {audioControls(undefined, project)}
                    <div className="vc-stx-reminder-preview">
                        <button type="button" className="vc-stx-btn vc-stx-ghost" title={`Тестовое уведомление · ${name}`}
                            onClick={() => previewTicketReminderNotification(project)}>Показать уведомление</button>
                    </div>
                </fieldset>;
            })}</div>
        </ReminderSettings>
        {(testing || playing || playbackStatus) && <div className="vc-stx-ticket-playback-row">
            <div className="vc-stx-ticket-playback" role="status"><IconBell size={16} /><span>{playbackLabel}</span></div>
            {(testing || playing) && <button type="button" className="vc-stx-btn vc-stx-ghost vc-stx-ticket-stop" aria-label="Остановить звук" onClick={stopTicketSoundPlayback}>
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" /></svg>Остановить
            </button>}
        </div>}
        {error && <p className="vc-stx-ticket-error" role="alert">{error}</p>}
        {!loaded && error && <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={retryTicketSoundSettings}>Повторить загрузку настроек</button>}
    </div>;
}
