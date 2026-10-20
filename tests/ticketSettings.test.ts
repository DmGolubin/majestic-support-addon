import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as soundCore from "../src/core/ticketSound";
import { defaultTicketSound, TicketSoundOptions } from "../src/core/ticketSound";
import { PROJECTS } from "../src/core/types";

const code = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/TicketSettings.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const reminderCode = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/ReminderSettings.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
type Node = { type: unknown; props: Record<string, any>; };
const nodes = (node: any): Node[] => Array.isArray(node) ? node.flatMap(nodes)
    : node && typeof node === "object" ? [node, ...nodes(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join("")
    : node && typeof node === "object" ? text(node.props.children) : node == null || typeof node === "boolean" ? "" : String(node);

function harness(patch: Partial<TicketSoundOptions> = {}) {
    type Audio = { customName: string; loadingSound: boolean; canReset: boolean; error: string; };
    const state = { options: soundCore.readTicketSound({ ...defaultTicketSound(), ...patch }), loaded: true, testing: false, playing: false, playbackStatus: "", canReset: false, error: "", customName: "", loadingSound: false, channelAudio: {} as Record<string, Audio>, reminderAudio: {} as Partial<Record<soundCore.ReminderSoundProject, Audio>> };
    const reminders: {
        phase: "idle" | "permission" | "loading" | "ready" | "offline";
        settings: { discordEnabled: boolean; projects: { project: soundCore.ReminderSoundProject; personalReminderMinutes: number; }[]; } | null;
        busy: boolean; error: string; deliveryError: string;
    } = { phase: "ready", settings: { discordEnabled: true, projects: [
        { project: "majestic", personalReminderMinutes: 5 },
        { project: "russia-online", personalReminderMinutes: 15 },
    ] }, busy: false, error: "", deliveryError: "" };
    const channels = new Map<string, { name?: string; guild_id?: string; }>();
    const ChannelStore = { getChannel: (id: string) => channels.get(id) };
    let previewLabel: unknown = null;
    const useState = (initial: unknown) => [previewLabel ?? initial, (value: unknown) => { previewLabel = value; }];
    const useStateFromStores = vi.fn((_stores, read: () => unknown) => read());
    const setTicketSound = vi.fn(), testTicketSound = vi.fn(), setChannelTicketSound = vi.fn();
    const chooseTicketSound = vi.fn(), resetTicketSound = vi.fn();
    const setReminderTicketSound = vi.fn(), chooseReminderSound = vi.fn(), resetReminderSound = vi.fn(), testReminderSound = vi.fn();
    const previewTicketReminderNotification = vi.fn();
    const setDiscordReminders = vi.fn(), refreshTicketReminders = vi.fn(), authorizePanelReminders = vi.fn();
    const retryTicketSoundSettings = vi.fn();
    const stopTicketSoundPlayback = vi.fn();
    const dependencies: Record<string, unknown> = {
        "./ticket-settings.css": {},
        "@webpack/common": { ChannelStore, useState, useStateFromStores },
        "../core/types": { PROJECTS },
        "../core/ticketSound": soundCore,
        "./Select": { Select: "Select" },
        "./ProjectIcon": { ProjectIcon: "ProjectIcon" },
        "./svg": { IconBell: "IconBell" },
        "./panel": { authorizePanelReminders },
        "./ticketReminders": { ticketRemindersState: { use: () => reminders }, setDiscordReminders, refreshTicketReminders, previewTicketReminderNotification },
        "./ticketSound": { ticketSoundState: { use: () => state }, setTicketSound, setChannelTicketSound, testTicketSound, chooseTicketSound, resetTicketSound, retryTicketSoundSettings, stopTicketSoundPlayback, setReminderTicketSound, chooseReminderSound, resetReminderSound, testReminderSound },
    };
    const context = {
        require: (id: string) => { if (!(id in dependencies)) throw new Error(`Unexpected import: ${id}`); return dependencies[id]; },
        React: { Fragment: "Fragment", createElement: (type: unknown, props: unknown, ...children: unknown[]) => {
            const next = { ...props as object, children };
            return typeof type === "function" ? type(next) : { type, props: next };
        } },
    };
    // Execute the actual child too: idle/permission must hide its supplied cards.
    const reminderExports: any = {};
    runInNewContext(reminderCode, { ...context, exports: reminderExports });
    dependencies["./ReminderSettings"] = reminderExports;
    const exports: any = {};
    runInNewContext(code, { ...context, exports });
    return { state, reminders, previewTicketReminderNotification, channels, ChannelStore, useStateFromStores, setTicketSound, setChannelTicketSound, testTicketSound, chooseTicketSound, resetTicketSound, retryTicketSoundSettings, stopTicketSoundPlayback, setReminderTicketSound, chooseReminderSound, resetReminderSound, testReminderSound, setDiscordReminders, refreshTicketReminders, authorizePanelReminders, render: () => exports.TicketSettings() };
}

describe("A24 ticket and personal reminder audio settings", () => {
    const fields = (h: ReturnType<typeof harness>) => nodes(h.render()).filter(n => n.type === "fieldset");
    const checks = (field: Node) => nodes(field).filter(n => n.type === "input" && n.props.type === "checkbox");
    const range = (field: Node) => nodes(field).find(n => n.type === "input" && n.props.type === "range")!;
    const picker = (field: Node) => nodes(field).find(n => n.type === "input" && n.props.type === "file")!;
    const button = (field: Node, name: string) => nodes(field).find(n => n.type === "button" && text(n).includes(name))!;

    it("explains all new tickets versus assigned personal reminders, with one audio set per parent", () => {
        const h = harness(); const tree = h.render();
        expect(text(tree)).toContain("не только назначенные вам");
        expect(text(tree)).toContain("Только назначенные вам тикеты");
        expect(text(tree)).toContain("Звук и громкость — отдельно для каждого сервера.");
        expect(fields(h)).toHaveLength(4);
        expect(nodes(tree).filter(n => n.type === "section" && n.props["aria-label"] === "Личные напоминания")).toHaveLength(1);
        expect(nodes(tree).filter(n => n.type === "input" && n.props.type === "file")).toHaveLength(4);
        expect(checks(fields(h)[2])).toHaveLength(1);
    });

    it("subscribes to live channel metadata without exposing raw IDs or inferring project by position", () => {
        const h = harness(); const [first, second] = h.state.options.channelIds;
        h.channels.set(first, { name: "помощь", guild_id: PROJECTS.ro.guildId });
        h.channels.set(second, { name: "support", guild_id: PROJECTS.mj.guildId });
        expect(fields(h)[0].props["aria-label"]).toBe("Россия Онлайн · #помощь");
        expect(fields(h)[1].props["aria-label"]).toBe("Majestic · #support");
        expect(nodes(fields(h)[0]).find(n => n.type === "ProjectIcon")!.props.project).toBe("ro");
        expect(nodes(fields(h)[1]).find(n => n.type === "ProjectIcon")!.props.project).toBe("mj");
        expect(nodes(h.render()).some(n => n.type === "legend")).toBe(false);
        expect(h.useStateFromStores).toHaveBeenCalledWith([h.ChannelStore], expect.any(Function), [h.state.options.channelIds]);
        for (const id of h.state.options.channelIds) expect(text(h.render())).not.toContain(id);
        h.channels.delete(first);
        expect(fields(h)[0].props["aria-label"]).toContain("название недоступно");
        h.channels.set(second, { name: "outside", guild_id: "123" });
        expect(fields(h)[1].props.disabled).toBe(true);
        expect(text(fields(h)[1])).toContain("Сигнал для этого канала отключён");
    });

    it("routes checkbox/quiet/volume/cooldown changes only to their channel", () => {
        const h = harness({ cooldownMs: 2500 });
        const second = fields(h)[1]; const id = h.state.options.channelIds[1];
        checks(second)[0].props.onChange({ currentTarget: { checked: true } });
        checks(second)[1].props.onChange({ currentTarget: { checked: false } });
        range(second).props.onChange({ currentTarget: { value: "55" } });
        const select = nodes(second).find(n => n.type === "Select")!;
        expect(select.props.value).toBe("2500");
        expect(nodes(select).some(n => n.type === "option" && n.props.value === "2500")).toBe(true);
        select.props.onChange({ currentTarget: { value: "5000" } });
        expect(h.setChannelTicketSound.mock.calls).toEqual([[id, { enabled: true }], [id, { quietWhenVisible: false }], [id, { volume: 55 }], [id, { cooldownMs: 5000 }]]);
        expect(h.setTicketSound).not.toHaveBeenCalled();
        expect(h.setReminderTicketSound).not.toHaveBeenCalled();
        expect(h.setDiscordReminders).not.toHaveBeenCalled();
    });

    it("routes personal volume to the selected project without changing the channel or global API toggle", () => {
        const h = harness({ volume: 83.9506 }); const personal = fields(h)[2];
        expect(range(personal).props).toMatchObject({ "aria-label": "Громкость личных напоминаний · Majestic", "aria-valuetext": "84%", min: 0, max: 100, step: 1, value: 83.9506 });
        range(personal).props.onChange({ currentTarget: { value: "85" } });
        expect(h.setReminderTicketSound).toHaveBeenCalledExactlyOnceWith("majestic", { volume: 85 });
        expect(h.setTicketSound).not.toHaveBeenCalled();
        expect(h.setDiscordReminders).not.toHaveBeenCalled();
        expect(h.setChannelTicketSound).not.toHaveBeenCalled();
    });

    it("allows explicitly labelled channel and personal previews at mute/zero without enabling either", () => {
        const h = harness({ enabled: false, volume: 0 });
        const [first, , personal] = fields(h);
        const preview = button(first, "Проверить звук");
        expect(preview.props.disabled).toBe(false);
        expect(text(first)).not.toContain("Проверка:");
        expect(preview.props.title).toBe("Проверить на 30%, не включая уведомления");
        preview.props.onClick();
        expect(h.testTicketSound).toHaveBeenCalledExactlyOnceWith(h.state.options.channelIds[0]);
        expect(button(personal, "Проверить звук").props.disabled).toBe(false);
        expect(text(personal)).not.toContain("Проверка:");
        expect(button(personal, "Проверить звук").props.title).toBe("Проверить на 30%, не включая уведомления");
        button(personal, "Проверить звук").props.onClick();
        expect(h.testReminderSound).toHaveBeenCalledExactlyOnceWith("majestic");
        expect(h.setReminderTicketSound).not.toHaveBeenCalled();
        expect(h.setChannelTicketSound).not.toHaveBeenCalled();
        expect(h.setDiscordReminders).not.toHaveBeenCalled();
    });

    it("dispatches file selection and reset with parent context, clears picker, and keeps reminders separate", () => {
        const h = harness(); const id = h.state.options.channelIds[0];
        h.state.channelAudio[id] = { customName: "channel.wav", canReset: true, loadingSound: false, error: "" };
        const [first, , personal] = fields(h);
        const file = { name: "sound.wav" }; const currentTarget = { files: [file], value: "sound.wav" };
        picker(first).props.onChange({ currentTarget });
        expect(h.chooseTicketSound).toHaveBeenCalledExactlyOnceWith(file, id);
        expect(currentTarget.value).toBe("");
        button(first, "Вернуть стандартный").props.onClick({ type: "click" });
        expect(h.resetTicketSound).toHaveBeenCalledExactlyOnceWith(id);
        button(first, "Проверить звук").props.onClick();
        expect(h.testTicketSound).toHaveBeenCalledWith(id);
        picker(personal).props.onChange({ currentTarget: { files: [file], value: "x" } });
        expect(h.chooseReminderSound).toHaveBeenCalledExactlyOnceWith(file, "majestic");
        expect(h.chooseTicketSound).toHaveBeenCalledTimes(1);
    });

    it.each([[], null, undefined])("ignores empty file selections (%j)", files => {
        const h = harness(); const currentTarget = { files, value: "old" };
        for (const field of fields(h)) picker(field).props.onChange({ currentTarget });
        expect(currentTarget.value).toBe(""); expect(h.chooseTicketSound).not.toHaveBeenCalled();
        expect(h.chooseReminderSound).not.toHaveBeenCalled();
    });

    it("keeps upload failures scoped and permits reset retry/cancellation in that channel", () => {
        const h = harness(); const id = h.state.options.channelIds[0];
        h.state.channelAudio[id] = { customName: "", loadingSound: true, canReset: true, error: "Не удалось сохранить звук канала." };
        const [first, second] = fields(h);
        expect(picker(first).props.disabled).toBe(true);
        expect(button(first, "Вернуть стандартный").props.disabled).toBe(false);
        expect(text(nodes(first).find(n => n.props.role === "alert"))).toContain("Не удалось сохранить");
        expect(nodes(second).some(n => n.props.role === "alert")).toBe(false);
        expect(picker(second).props.disabled).toBe(false);
    });

    it("offers settings read retry outside disabled controls and hides unloaded channel guesses", () => {
        const h = harness(); h.state.loaded = false;
        expect(fields(h)).toHaveLength(2);
        for (const field of fields(h)) expect(field.props.disabled).toBe(true);
        expect(text(h.render())).toContain("Загрузка каналов…");
        h.state.error = "Не удалось прочитать настройки звука.";
        const retry = nodes(h.render()).find(n => n.type === "button" && text(n) === "Повторить загрузку настроек")!;
        expect(nodes(fields(h)[0])).not.toContain(retry);
        retry.props.onClick(); expect(h.retryTicketSoundSettings).toHaveBeenCalledOnce();
    });

    it("displays shared playback feedback and stop control without adding duplicate controls", () => {
        const h = harness(); h.state.playing = true; h.state.playbackStatus = "Воспроизводится свой звук.";
        const tree = h.render();
        expect(text(nodes(tree).find(n => n.props.role === "status"))).toBe("Свой звук");
        const stops = nodes(tree).filter(n => n.type === "button" && n.props["aria-label"] === "Остановить звук");
        expect(stops).toHaveLength(1); stops[0].props.onClick();
        expect(h.stopTicketSoundPlayback).toHaveBeenCalledOnce();
    });

    it.each(["majestic", "russia-online"] as const)("routes every local personal control independently for %s, without writing API thresholds", project => {
        const h = harness({ reminders: {
            majestic: { enabled: false, volume: 23 },
            "russia-online": { enabled: true, volume: 67 },
        } });
        const saved = h.reminders.settings!;
        saved.projects.forEach(Object.freeze); Object.freeze(saved.projects); Object.freeze(saved);
        const before = structuredClone(saved);
        const optionsBefore = structuredClone(h.state.options);
        h.state.reminderAudio[project] = { customName: `${project}.wav`, canReset: true, loadingSound: false, error: "" };
        const personal = fields(h)[project === "majestic" ? 2 : 3];
        expect(checks(personal)[0].props.checked).toBe(project === "russia-online");
        expect(range(personal).props.value).toBe(project === "majestic" ? 23 : 67);
        expect(text(personal)).toContain(project === "majestic" ? "5 мин" : "15 мин");
        expect(nodes(personal).filter(n => ["select", "Select", "textarea"].includes(n.type as string) || n.props.type === "number" || n.props.contentEditable)).toHaveLength(0);
        checks(personal)[0].props.onChange({ currentTarget: { checked: project === "majestic" } });
        range(personal).props.onChange({ currentTarget: { value: "42" } });
        const file = { name: `${project}-new.wav` };
        const currentTarget = { files: [file], value: file.name };
        picker(personal).props.onChange({ currentTarget });
        button(personal, "Вернуть стандартный").props.onClick();
        button(personal, "Проверить звук").props.onClick();
        expect(currentTarget.value).toBe("");
        expect(h.setReminderTicketSound.mock.calls).toEqual([[project, { enabled: project === "majestic" }], [project, { volume: 42 }]]);
        expect(h.chooseReminderSound).toHaveBeenCalledExactlyOnceWith(file, project);
        expect(h.resetReminderSound).toHaveBeenCalledExactlyOnceWith(project);
        expect(h.testReminderSound).toHaveBeenCalledExactlyOnceWith(project);
        for (const other of [h.setTicketSound, h.setChannelTicketSound, h.chooseTicketSound, h.resetTicketSound, h.testTicketSound, h.setDiscordReminders, h.refreshTicketReminders, h.authorizePanelReminders]) expect(other).not.toHaveBeenCalled();
        expect(saved).toEqual(before);
        expect(h.state.options).toEqual(optionsBefore);
    });

    it.each(["majestic", "russia-online"] as const)("renders only the authorized %s personal project despite both local profiles", project => {
        const h = harness();
        h.reminders.settings!.projects = h.reminders.settings!.projects.filter(p => p.project === project);
        const personal = fields(h).slice(2);
        expect(personal).toHaveLength(1);
        expect(personal[0].props["aria-label"]).toBe(`Личные напоминания · ${project === "majestic" ? "Majestic" : "Россия Онлайн"}`);
        expect(nodes(personal[0]).find(n => n.type === "ProjectIcon")!.props.project).toBe(project === "majestic" ? "mj" : "ro");
        button(personal[0], "Проверить звук").props.onClick();
        expect(h.testReminderSound).toHaveBeenCalledExactlyOnceWith(project);
        h.reminders.settings!.projects = [];
        expect(fields(h)).toHaveLength(2);
    });

    it.each(["idle", "permission", "loading", "offline", "ready"] as const)("does not invent personal cards without settings in %s", phase => {
        const h = harness(); h.reminders.phase = phase; h.reminders.settings = null;
        expect(fields(h)).toHaveLength(2);
        expect(text(h.render())).not.toContain("Игрок ждёт ответа ·");
        expect(h.setReminderTicketSound).not.toHaveBeenCalled();
        expect(h.testReminderSound).not.toHaveBeenCalled();
    });

    it.each(["idle", "permission"] as const)("hides personal children after auth changes to %s even while old settings are present", phase => {
        const h = harness(); expect(fields(h)).toHaveLength(4);
        h.reminders.phase = phase;
        expect(fields(h)).toHaveLength(2);
        expect(text(h.render())).not.toContain("Игрок ждёт ответа ·");
    });

    it("renders server identity and thresholds from projects rather than card position", () => {
        const h = harness(); h.reminders.settings!.projects.reverse();
        const personal = fields(h).slice(2);
        expect(personal.map(n => n.props["aria-label"])).toEqual(["Личные напоминания · Россия Онлайн", "Личные напоминания · Majestic"]);
        expect(text(personal[0])).toContain("15 мин");
        expect(text(personal[1])).toContain("5 мин");
        range(personal[0]).props.onChange({ currentTarget: { value: "64" } });
        expect(h.setReminderTicketSound).toHaveBeenCalledExactlyOnceWith("russia-online", { volume: 64 });
    });

    it("shows master-off status for both servers and permits manual preview without changing the API toggle", () => {
        const h = harness(); h.reminders.settings!.discordEnabled = false;
        for (const personal of fields(h).slice(2)) {
            expect(text(personal)).toContain("Общий переключатель напоминаний выключен.");
            expect(text(personal)).not.toContain("Проверка:");
        expect(button(personal, "Проверить звук").props.title).toBe("Проверить на 30%, не включая уведомления");
            expect(button(personal, "Проверить звук").props.disabled).toBe(false);
            button(personal, "Проверить звук").props.onClick();
        }
        expect(h.testReminderSound.mock.calls).toEqual([["majestic"], ["russia-online"]]);
        expect(h.setReminderTicketSound).not.toHaveBeenCalled();
        expect(h.setDiscordReminders).not.toHaveBeenCalled();
        const section = nodes(h.render()).find(n => n.type === "section" && n.props["aria-label"] === "Личные напоминания")!;
        const master = checks(section)[0];
        expect(master.props).toMatchObject({ checked: false, disabled: false });
        master.props.onChange({ currentTarget: { checked: true } });
        expect(h.setDiscordReminders).toHaveBeenCalledExactlyOnceWith(true);
        expect(h.setReminderTicketSound).not.toHaveBeenCalled();
    });

    it.each(["majestic", "russia-online"] as const)("keeps %s upload errors and reset cancellation local to that card", project => {
        const h = harness();
        h.state.reminderAudio[project] = { customName: "", loadingSound: true, canReset: true, error: "Не удалось сохранить личный звук." };
        const all = fields(h);
        const affected = all[project === "majestic" ? 2 : 3];
        expect(picker(affected).props.disabled).toBe(true);
        expect(button(affected, "Проверить звук").props.disabled).toBe(true);
        expect(button(affected, "Вернуть стандартный").props.disabled).toBe(false);
        expect(nodes(affected).filter(n => n.props.role === "alert").map(text)).toEqual(["Не удалось сохранить личный звук."]);
        button(affected, "Вернуть стандартный").props.onClick();
        expect(h.resetReminderSound).toHaveBeenCalledExactlyOnceWith(project);
        for (const other of all.filter(n => n !== affected)) {
            expect(picker(other).props.disabled).toBe(false);
            expect(nodes(other).some(n => n.props.role === "alert")).toBe(false);
        }
    });
});


describe("A25 compact sound controls", () => {
    it.each([0, 30, 83.9506172839506, 100])("rounds every displayed percentage while preserving stored %s", volume => {
        const h = harness({ volume, enabled: false });
        h.state.playbackStatus = `Проверка при выключенном канале: ${volume}%, настройки не изменены.`;
        const tree = h.render();
        const ranges = nodes(tree).filter(n => n.type === "input" && n.props.type === "range");
        expect(ranges).toHaveLength(4);
        for (const range of ranges) expect(range.props).toMatchObject({ value: volume, "aria-valuetext": `${Math.round(volume)}%` });
        const labels = text(tree).match(/\d+(?:\.\d+)?%/g)!;
        expect(labels.length).toBeGreaterThan(3);
        for (const label of labels) expect(label).toMatch(/^\d+%$/);
        expect(text(tree)).not.toContain("Проверка:");
        expect(nodes(tree).find(n => n.type === "button" && text(n) === "Проверить звук")!.props.title).toBe(`Проверить на ${Math.round(volume || 30)}%, не включая уведомления`);
        const previews = nodes(tree).filter(n => n.type === "button" && text(n) === "Проверить звук");
        expect(previews).toHaveLength(4);
        expect(h.state.options.volume).toBe(volume);
        expect(h.setChannelTicketSound).not.toHaveBeenCalled();
        expect(h.setTicketSound).not.toHaveBeenCalled();
        expect(h.setReminderTicketSound).not.toHaveBeenCalled();
    });

    it("keeps preview labels stable for custom files and pending tests without changing keyboard access", () => {
        const h = harness({ enabled: true });
        h.state.reminderAudio.majestic = { customName: "very-long-personal-notification.wav", canReset: true, loadingSound: false, error: "" };
        const id = h.state.options.channelIds[0];
        h.state.channelAudio[id] = { customName: "channel.wav", canReset: true, loadingSound: false, error: "" };
        for (const testing of [false, true]) {
            h.state.testing = testing;
            const all = nodes(h.render());
            const previews = all.filter(n => n.type === "button" && text(n) === "Проверить звук");
            expect(previews).toHaveLength(4);
            for (const preview of previews) expect(preview.props).toMatchObject({ type: "button", disabled: testing, "aria-busy": testing });
            expect(all.filter(n => n.type === "input" && n.props.type === "file")).toHaveLength(4);
            expect(all.some(n => n.props.tabIndex === -1)).toBe(false);
        }
    });
});


describe("A27 playback and notification preview", () => {
    it("remembers the selected custom sound during playback without displaying the verbose runtime paragraph", () => {
        const h = harness(); const id = h.state.options.channelIds[0];
        h.state.channelAudio[id] = { customName: "selected.wav", canReset: true, loadingSound: false, error: "" };
        nodes(h.render()).find(n => n.type === "button" && text(n) === "Проверить звук")!.props.onClick();
        h.state.playing = true;
        h.state.playbackStatus = "Воспроизводится свой звук. Если его не слышно, проверьте громкость Discord.";
        const row = nodes(h.render()).find(n => n.props.className === "vc-stx-ticket-playback-row")!;
        expect(text(nodes(row).find(n => n.props.role === "status"))).toBe("Свой звук");
        expect(text(row)).not.toMatch(/Discord|громкость|selected/);
        const stop = nodes(row).find(n => n.type === "button")!;
        expect(stop.props).toMatchObject({ type: "button", "aria-label": "Остановить звук" });
        expect(text(stop)).toBe("Остановить"); stop.props.onClick();
        expect(h.stopTicketSoundPlayback).toHaveBeenCalledOnce();
        h.state.playing = false; h.state.playbackStatus = "Воспроизведение остановлено.";
        expect(text(nodes(h.render()).find(n => n.props.role === "status"))).toBe("Остановлено");
        expect(nodes(h.render()).some(n => n.props["aria-label"] === "Остановить звук")).toBe(false);
    });

    it("shows concise pending/completed status while retaining actual playback errors", () => {
        const h = harness(); h.state.testing = true;
        expect(text(nodes(h.render()).find(n => n.props.role === "status"))).toBe("Подготовка звука…");
        h.state.testing = false; h.state.playbackStatus = "Тест завершён. Если звука не было, проверьте устройство вывода и громкость Discord.";
        h.state.error = "Не удалось воспроизвести звук.";
        const tree = h.render();
        expect(text(nodes(tree).find(n => n.props.role === "status"))).toBe("Проверка завершена");
        expect(text(nodes(tree).find(n => n.props.role === "alert"))).toBe(h.state.error);
        expect(text(tree)).not.toContain("громкость Discord");
    });

    it("triggers notification preview only on its button and preserves both new-ticket checkboxes", () => {
        const h = harness(); const tree = h.render();
        expect(h.previewTicketReminderNotification).not.toHaveBeenCalled();
        const preview = nodes(tree).find(n => n.type === "button" && text(n) === "Показать уведомление")!;
        expect(preview.props).toMatchObject({ type: "button", title: "Локальное тестовое уведомление" });
        preview.props.onClick();
        expect(h.previewTicketReminderNotification).toHaveBeenCalledOnce();
        expect(h.setDiscordReminders).not.toHaveBeenCalled();
        expect(h.testTicketSound).not.toHaveBeenCalled(); expect(h.testReminderSound).not.toHaveBeenCalled();
        const channel = nodes(tree).find(n => n.type === "fieldset")!;
        expect(nodes(channel).filter(n => n.type === "input" && n.props.type === "checkbox")).toHaveLength(2);
        expect(text(channel)).toContain("Звук новых тикетов");
        expect(text(channel)).toContain("Тихо, если тикет открыт и Discord в фокусе");
        expect(text(tree)).not.toContain("Общий переключатель для всех серверов");
    });
});
