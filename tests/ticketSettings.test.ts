import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
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
    const state = { options: { ...defaultTicketSound(), ...patch }, loaded: true, testing: false, error: "", customName: "", loadingSound: false };
    const channels = new Map<string, { name?: string; guild_id?: string; }>();
    const ChannelStore = { getChannel: (id: string) => channels.get(id) };
    const useStateFromStores = vi.fn((_stores, read: () => unknown) => read());
    const setTicketSound = vi.fn(), testTicketSound = vi.fn();
    const chooseTicketSound = vi.fn(), resetTicketSound = vi.fn();
    const dependencies: Record<string, unknown> = {
        "./ticket-settings.css": {},
        "@webpack/common": { ChannelStore, useStateFromStores },
        "../core/types": { PROJECTS },
        "./Select": { Select: "Select" },
        "./svg": { IconBell: "IconBell" },
        "./ReminderSettings": { ReminderSettings: "ReminderSettings" },
        "./ticketSound": { ticketSoundState: { use: () => state }, setTicketSound, testTicketSound, chooseTicketSound, resetTicketSound },
    };
    const exports: any = {};
    runInNewContext(code, {
        exports,
        require: (id: string) => { if (!(id in dependencies)) throw new Error(`Unexpected import: ${id}`); return dependencies[id]; },
        React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props: { ...props as object, children } }) },
    });
    return { state, channels, ChannelStore, useStateFromStores, setTicketSound, testTicketSound, chooseTicketSound, resetTicketSound, render: () => exports.TicketSettings() };
}

describe("ticket settings", () => {
    it("subscribes to channel metadata and resolves names on the next render", () => {
        const h = harness({ channelIds: ["mj", "ro", "unknown", "other"] });
        h.channels.set("mj", { name: "support", guild_id: PROJECTS.mj.guildId });
        h.channels.set("ro", { name: "помощь", guild_id: PROJECTS.ro.guildId });
        h.channels.set("other", { name: "general", guild_id: "outside" });
        const tree = h.render();
        expect(nodes(tree).filter(n => n.type === "li").map(text)).toEqual([
            "Majestic#support", "Россия Онлайн#помощь", "Проект не определёнКанал 3: название недоступно",
            "Вне поддерживаемых проектов#generalСигнал для этого канала отключён",
        ]);
        expect(h.useStateFromStores).toHaveBeenCalledWith([h.ChannelStore], expect.any(Function), [h.state.options.channelIds]);
        h.channels.set("unknown", { name: "tickets", guild_id: PROJECTS.mj.guildId });
        expect(text(h.render())).toContain("Majestic#tickets");
        expect(nodes(tree).some(n => n.type === "form" || n.type === "input" && !["range", "checkbox", "file"].includes(n.props.type))).toBe(false);
        expect(h.setTicketSound).not.toHaveBeenCalled();
    });

    it("uses the current guild metadata rather than the default channel position and hides raw IDs", () => {
        const h = harness();
        const [first, second] = h.state.options.channelIds;
        h.channels.set(first, { name: "помощь", guild_id: PROJECTS.ro.guildId });
        h.channels.set(second, { name: "support", guild_id: PROJECTS.mj.guildId });
        const tree = h.render();
        expect(nodes(tree).filter(n => n.type === "li").map(text)).toEqual([
            "Россия Онлайн#помощь", "Majestic#support",
        ]);
        for (const id of h.state.options.channelIds) expect(text(tree)).not.toContain(id);
        h.channels.delete(first);
        h.state.options.channelIds = [second, first];
        expect(nodes(h.render()).filter(n => n.type === "li").map(text)).toEqual([
            "Majestic#support", "Проект не определёнКанал 2: название недоступно",
        ]);
        expect(h.setTicketSound).not.toHaveBeenCalled();
    });

    it("does not present default channels as loaded configuration", () => {
        const h = harness();
        h.state.loaded = false;
        const tree = h.render();
        expect(nodes(tree).find(n => n.type === "fieldset")!.props.disabled).toBe(true);
        expect(text(tree)).toContain("Загрузка каналов…");
        expect(nodes(tree).filter(n => n.type === "li")).toHaveLength(0);
        h.state.loaded = true;
        h.state.options.channelIds = [];
        expect(text(h.render())).toContain("Каналы не настроены.");
    });

    it("retains sound controls and the actual saved cooldown without writing channel IDs", () => {
        const h = harness({ cooldownMs: 2500 });
        const all = nodes(h.render());
        const checkboxes = all.filter(n => n.type === "input" && n.props.type === "checkbox");
        checkboxes[0].props.onChange({ currentTarget: { checked: true } });
        checkboxes[1].props.onChange({ currentTarget: { checked: false } });
        all.find(n => n.type === "input" && n.props.type === "range")!.props.onChange({ currentTarget: { value: "55" } });
        const select = all.find(n => n.type === "Select")!;
        expect(select.props.value).toBe("2500");
        expect(nodes(select).find(n => n.type === "option" && n.props.value === "2500")).toBeDefined();
        select.props.onChange({ currentTarget: { value: "5000" } });
        all.find(n => n.type === "button")!.props.onClick();
        expect(h.setTicketSound.mock.calls).toEqual([[{ enabled: true }], [{ quietWhenVisible: false }], [{ volume: 55 }], [{ cooldownMs: 5000 }]]);
        expect(h.testTicketSound).toHaveBeenCalledOnce();
    });

    it("rounds the volume label while preserving the saved value and using one-percent steps", () => {
        const h = harness({ volume: 83.9506 });
        const all = nodes(h.render());
        const range = all.find(n => n.type === "input" && n.props.type === "range")!;
        expect(range.props).toMatchObject({
            "aria-label": "Громкость нового тикета", "aria-valuetext": "84%",
            min: 0, max: 100, step: 1, value: 83.9506,
        });
        expect(text(all.find(n => n.type === "label" && nodes(n).includes(range)))).toBe("Громкость 84%");
        expect(h.setTicketSound).not.toHaveBeenCalled();
        expect(all.find(n => n.type === "Select")!.props["aria-label"]).toBe("Пауза между сигналами");
        const labels = all.filter(n => n.type === "label" && nodes(n).some(child => child.type === "input" && child.props.type === "checkbox"));
        expect(labels.map(text)).toEqual([
            "Звук при создании тикета", "Без звука, когда тикет открыт и Discord в фокусе",
        ]);
        const testButton = all.find(n => n.type === "button")!;
        expect(testButton.props).toMatchObject({ type: "button", disabled: false });
        expect(text(testButton)).toBe("Проверить звук");
        range.props.onChange({ currentTarget: { value: "85" } });
        expect(h.setTicketSound).toHaveBeenCalledWith({ volume: 85 });
    });

    it("disables the sound test while testing or muted and keeps runtime errors visible", () => {
        const h = harness();
        h.state.testing = true;
        expect(nodes(h.render()).find(n => n.type === "button")!.props.disabled).toBe(true);
        h.state.testing = false;
        h.state.options.volume = 0;
        h.state.error = "Не удалось прочитать настройки звука.";
        const all = nodes(h.render());
        expect(all.find(n => n.type === "button")!.props.disabled).toBe(true);
        expect(text(all.find(n => n.props.role === "alert"))).toBe(h.state.error);
    });

    it("keeps the new-ticket title and renders the dedicated reminder settings component", () => {
        const tree = harness().render();
        expect(nodes(tree).filter(n => n.type === "h3").map(text)).toEqual(["Новые тикеты"]);
        expect(nodes(tree).filter(n => n.type === "ReminderSettings")).toHaveLength(1);
    });

    it("dispatches the selected audio file and clears the picker so it can be selected again", () => {
        const h = harness();
        const tree = h.render();
        const picker = nodes(tree).find(n => n.type === "input" && n.props.type === "file")!;
        expect(picker.props).toMatchObject({ "aria-label": "Выбрать свой звук", disabled: false });
        expect(picker.props.accept.split(",")).toEqual([
            "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/flac", ".mp3", ".wav", ".ogg", ".m4a", ".flac",
        ]);
        expect(text(tree)).toContain("Стандартный звук");
        const file = { name: "notification.ogg", type: "audio/ogg" };
        const currentTarget = { files: [file, { name: "ignored.wav" }], value: "notification.ogg" };
        picker.props.onChange({ currentTarget });
        expect(h.chooseTicketSound).toHaveBeenCalledExactlyOnceWith(file);
        expect(currentTarget.value).toBe("");
        expect(h.setTicketSound).not.toHaveBeenCalled();
    });

    it.each([[], null, undefined])("does nothing when the file picker has no file (%j)", files => {
        const h = harness();
        const picker = nodes(h.render()).find(n => n.type === "input" && n.props.type === "file")!;
        const currentTarget = { files, value: "previous selection" };
        picker.props.onChange({ currentTarget });
        expect(currentTarget.value).toBe("");
        expect(h.chooseTicketSound).not.toHaveBeenCalled();
        expect(h.resetTicketSound).not.toHaveBeenCalled();
        expect(h.setTicketSound).not.toHaveBeenCalled();
    });

    it("shows the custom filename and only offers reset when a custom sound is selected", () => {
        const h = harness();
        const resetButton = () => nodes(h.render()).find(n => n.type === "button" && text(n) === "Вернуть стандартный");
        expect(resetButton()).toBeUndefined();
        h.state.customName = "notification.ogg";
        expect(text(h.render())).toContain("notification.ogg");
        expect(resetButton()!.props).toMatchObject({ type: "button", disabled: false });
        resetButton()!.props.onClick();
        expect(h.resetTicketSound).toHaveBeenCalledOnce();
        expect(h.chooseTicketSound).not.toHaveBeenCalled();
    });

    it.each(["loadingSound", "testing"] as const)("disables file selection and reset while %s", flag => {
        const h = harness();
        h.state.customName = "notification.ogg";
        h.state[flag] = true;
        const tree = h.render();
        const all = nodes(tree);
        expect(all.find(n => n.type === "input" && n.props.type === "file")!.props.disabled).toBe(true);
        expect(all.find(n => n.type === "button" && text(n) === "Вернуть стандартный")!.props.disabled).toBe(true);
        if (flag === "loadingSound") expect(text(tree)).toContain("Загружаем звук…");
        h.state[flag] = false;
        expect(nodes(h.render()).find(n => n.type === "input" && n.props.type === "file")!.props.disabled).toBe(false);
    });
});
