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
type Node = { type: unknown; props: Record<string, any>; };
const nodes = (node: any): Node[] => Array.isArray(node) ? node.flatMap(nodes)
    : node && typeof node === "object" ? [node, ...nodes(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join("")
    : node && typeof node === "object" ? text(node.props.children) : node == null || typeof node === "boolean" ? "" : String(node);

function harness(patch: Partial<TicketSoundOptions> = {}) {
    const state = { options: soundCore.readTicketSound({ ...defaultTicketSound(), ...patch }), loaded: true, testing: false, playing: false, playbackStatus: "", canReset: false, error: "", customName: "", loadingSound: false, channelAudio: {} as Record<string, { customName: string; loadingSound: boolean; canReset: boolean; error: string; }> };
    const channels = new Map<string, { name?: string; guild_id?: string; }>();
    const ChannelStore = { getChannel: (id: string) => channels.get(id) };
    const useStateFromStores = vi.fn((_stores, read: () => unknown) => read());
    const setTicketSound = vi.fn(), testTicketSound = vi.fn(), setChannelTicketSound = vi.fn();
    const chooseTicketSound = vi.fn(), resetTicketSound = vi.fn();
    const retryTicketSoundSettings = vi.fn();
    const stopTicketSoundPlayback = vi.fn();
    const dependencies: Record<string, unknown> = {
        "./ticket-settings.css": {},
        "@webpack/common": { ChannelStore, useStateFromStores },
        "../core/types": { PROJECTS },
        "../core/ticketSound": soundCore,
        "./Select": { Select: "Select" },
        "./ProjectIcon": { ProjectIcon: "ProjectIcon" },
        "./svg": { IconBell: "IconBell" },
        "./ReminderSettings": { ReminderSettings: "ReminderSettings" },
        "./ticketSound": { ticketSoundState: { use: () => state }, setTicketSound, setChannelTicketSound, testTicketSound, chooseTicketSound, resetTicketSound, retryTicketSoundSettings, stopTicketSoundPlayback },
    };
    const exports: any = {};
    runInNewContext(code, {
        exports,
        require: (id: string) => { if (!(id in dependencies)) throw new Error(`Unexpected import: ${id}`); return dependencies[id]; },
        React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props: { ...props as object, children } }) },
    });
    return { state, channels, ChannelStore, useStateFromStores, setTicketSound, setChannelTicketSound, testTicketSound, chooseTicketSound, resetTicketSound, retryTicketSoundSettings, stopTicketSoundPlayback, render: () => exports.TicketSettings() };
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
        expect(text(tree)).toContain("Общий звук для ваших тикетов");
        expect(text(tree)).toContain("Не зависит от настроек новых тикетов");
        expect(fields(h)).toHaveLength(3);
        expect(nodes(tree).filter(n => n.type === "ReminderSettings")).toHaveLength(1);
        expect(nodes(tree).filter(n => n.type === "input" && n.props.type === "file")).toHaveLength(3);
        expect(checks(fields(h)[2])).toHaveLength(0);
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
    });

    it("keeps global volume solely in the personal reminder section", () => {
        const h = harness({ volume: 83.9506 }); const personal = fields(h)[2];
        expect(range(personal).props).toMatchObject({ "aria-label": "Громкость личных напоминаний", "aria-valuetext": "84%", min: 0, max: 100, step: 1, value: 83.9506 });
        range(personal).props.onChange({ currentTarget: { value: "85" } });
        expect(h.setTicketSound).toHaveBeenCalledExactlyOnceWith({ volume: 85 });
        expect(h.setChannelTicketSound).not.toHaveBeenCalled();
    });

    it("allows explicitly labelled channel previews at mute/zero while personal zero remains silent", () => {
        const h = harness({ enabled: false, volume: 0 });
        const [first, , personal] = fields(h);
        const preview = button(first, "Проверить звук");
        expect(preview.props.disabled).toBe(false);
        expect(text(first)).toContain("Проверка: 30%, без включения канала.");
        preview.props.onClick();
        expect(h.testTicketSound).toHaveBeenCalledExactlyOnceWith(h.state.options.channelIds[0]);
        expect(button(personal, "Проверить звук").props.disabled).toBe(true);
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
        expect(h.chooseTicketSound).toHaveBeenLastCalledWith(file, undefined);
    });

    it.each([[], null, undefined])("ignores empty file selections (%j)", files => {
        const h = harness(); const currentTarget = { files, value: "old" };
        picker(fields(h)[0]).props.onChange({ currentTarget });
        expect(currentTarget.value).toBe(""); expect(h.chooseTicketSound).not.toHaveBeenCalled();
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
        expect(fields(h)).toHaveLength(1); expect(fields(h)[0].props.disabled).toBe(true);
        expect(text(h.render())).toContain("Загрузка каналов…");
        h.state.error = "Не удалось прочитать настройки звука.";
        const retry = nodes(h.render()).find(n => n.type === "button" && text(n) === "Повторить загрузку настроек")!;
        expect(nodes(fields(h)[0])).not.toContain(retry);
        retry.props.onClick(); expect(h.retryTicketSoundSettings).toHaveBeenCalledOnce();
    });

    it("displays shared playback feedback and stop control without adding duplicate controls", () => {
        const h = harness(); h.state.playing = true; h.state.playbackStatus = "Воспроизводится свой звук.";
        const tree = h.render();
        expect(text(nodes(tree).find(n => n.props.role === "status"))).toBe(h.state.playbackStatus);
        const stops = nodes(tree).filter(n => n.type === "button" && text(n) === "Остановить звук");
        expect(stops).toHaveLength(1); stops[0].props.onClick();
        expect(h.stopTicketSoundPlayback).toHaveBeenCalledOnce();
    });
});


describe("A25 compact sound controls", () => {
    it.each([0, 30, 83.9506172839506, 100])("rounds every displayed percentage while preserving stored %s", volume => {
        const h = harness({ volume, enabled: false });
        h.state.playbackStatus = `Проверка при выключенном канале: ${volume}%, настройки не изменены.`;
        const tree = h.render();
        const ranges = nodes(tree).filter(n => n.type === "input" && n.props.type === "range");
        expect(ranges).toHaveLength(3);
        for (const range of ranges) expect(range.props).toMatchObject({ value: volume, "aria-valuetext": `${Math.round(volume)}%` });
        const labels = text(tree).match(/\d+(?:\.\d+)?%/g)!;
        expect(labels.length).toBeGreaterThan(3);
        for (const label of labels) expect(label).toMatch(/^\d+%$/);
        expect(text(tree)).toContain(`Проверка: ${Math.round(volume || 30)}%, без включения канала.`);
        const previews = nodes(tree).filter(n => n.type === "button" && text(n) === "Проверить звук");
        expect(previews).toHaveLength(3);
        expect(h.state.options.volume).toBe(volume);
        expect(h.setChannelTicketSound).not.toHaveBeenCalled();
        expect(h.setTicketSound).not.toHaveBeenCalled();
    });

    it("keeps preview labels stable for custom files and pending tests without changing keyboard access", () => {
        const h = harness({ enabled: true });
        h.state.customName = "very-long-personal-notification.wav";
        const id = h.state.options.channelIds[0];
        h.state.channelAudio[id] = { customName: "channel.wav", canReset: true, loadingSound: false, error: "" };
        for (const testing of [false, true]) {
            h.state.testing = testing;
            const all = nodes(h.render());
            const previews = all.filter(n => n.type === "button" && text(n) === "Проверить звук");
            expect(previews).toHaveLength(3);
            for (const preview of previews) expect(preview.props).toMatchObject({ type: "button", disabled: testing, "aria-busy": testing });
            expect(all.filter(n => n.type === "input" && n.props.type === "file")).toHaveLength(3);
            expect(all.some(n => n.props.tabIndex === -1)).toBe(false);
        }
    });
});
