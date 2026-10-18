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
    const state = { options: { ...defaultTicketSound(), ...patch }, loaded: true, testing: false, error: "" };
    const channels = new Map<string, { name?: string; guild_id?: string; }>();
    const ChannelStore = { getChannel: (id: string) => channels.get(id) };
    const useStateFromStores = vi.fn((_stores, read: () => unknown) => read());
    const setTicketSound = vi.fn(), testTicketSound = vi.fn();
    const dependencies: Record<string, unknown> = {
        "./ticket-settings.css": {},
        "@webpack/common": { ChannelStore, useStateFromStores },
        "../core/types": { PROJECTS },
        "./Select": { Select: "Select" },
        "./svg": { IconBell: "IconBell" },
        "./ticketSound": { ticketSoundState: { use: () => state }, setTicketSound, testTicketSound },
    };
    const exports: any = {};
    runInNewContext(code, {
        exports,
        require: (id: string) => { if (!(id in dependencies)) throw new Error(`Unexpected import: ${id}`); return dependencies[id]; },
        React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props: { ...props as object, children } }) },
    });
    return { state, channels, ChannelStore, useStateFromStores, setTicketSound, testTicketSound, render: () => exports.TicketSettings() };
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
        expect(nodes(tree).some(n => n.type === "form" || n.type === "input" && !["range", "checkbox"].includes(n.props.type))).toBe(false);
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

    it("labels controls and preserves saved volume without snapping to a five-percent step", () => {
        const h = harness({ volume: 37.5 });
        const all = nodes(h.render());
        const range = all.find(n => n.type === "input" && n.props.type === "range")!;
        expect(range.props).toMatchObject({
            "aria-label": "Громкость нового тикета", "aria-valuetext": "37.5%",
            min: 0, max: 100, step: "any", value: 37.5,
        });
        expect(all.find(n => n.type === "Select")!.props["aria-label"]).toBe("Пауза между сигналами");
        const labels = all.filter(n => n.type === "label" && nodes(n).some(child => child.type === "input" && child.props.type === "checkbox"));
        expect(labels.map(text)).toEqual([
            "Звук при создании тикета", "Без звука, когда тикет открыт и Discord в фокусе", "Напоминать в Discord",
        ]);
        const testButton = all.find(n => n.type === "button")!;
        expect(testButton.props).toMatchObject({ type: "button", disabled: false });
        expect(text(testButton)).toBe("Проверить звук");
        range.props.onChange({ currentTarget: { value: "38.5" } });
        expect(h.setTicketSound).toHaveBeenCalledWith({ volume: 38.5 });
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

    it("shows reminders as unavailable without fabricating a Telegram threshold or an enabled state", () => {
        const tree = harness().render();
        const waiting = nodes(tree).find(n => n.type === "section" && n.props["aria-label"] === "Игрок ждёт ответа")!;
        expect(text(waiting)).toContain("Не подключено");
        expect(text(waiting)).toContain("Порог ожидания задаётся в Telegram.");
        const controls = nodes(waiting).filter(n => n.type === "input" || n.type === "Select");
        expect(controls).toHaveLength(1);
        expect(controls[0].props).toMatchObject({ type: "checkbox", checked: false, disabled: true });
        expect(controls[0].props.onChange).toBeUndefined();
    });
});
