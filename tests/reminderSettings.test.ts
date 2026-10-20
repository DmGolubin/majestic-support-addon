import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const code = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/ReminderSettings.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
type Node = { type: unknown; props: Record<string, any>; };
const nodes = (node: any): Node[] => Array.isArray(node) ? node.flatMap(nodes)
    : node && typeof node === "object" ? [node, ...nodes(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join("")
    : node && typeof node === "object" ? text(node.props.children) : node == null || typeof node === "boolean" ? "" : String(node);

interface State {
    phase: "idle" | "permission" | "loading" | "ready" | "offline";
    settings: { discordEnabled: boolean; projects: { project: "majestic" | "russia-online"; personalReminderMinutes: number; }[]; } | null;
    busy: boolean;
    error: string;
    deliveryError: string;
}

function harness(patch: Partial<State> = {}) {
    let state: State = { phase: "idle", settings: null, busy: false, error: "", deliveryError: "", ...patch };
    const ticketRemindersState = {
        use: vi.fn(() => state),
        set: (next: Partial<State>) => { state = { ...state, ...next }; },
    };
    const previewTicketReminderNotification = vi.fn();
    const authorizePanelReminders = vi.fn(), refreshTicketReminders = vi.fn(), setDiscordReminders = vi.fn();
    // Unknown imports fail: UI uses the existing project icon and reminder adapters.
    const dependencies: Record<string, unknown> = {
        "./panel": { authorizePanelReminders },
        "./ProjectIcon": { ProjectIcon: "ProjectIcon" },
        "./ticketReminders": { ticketRemindersState, refreshTicketReminders, setDiscordReminders, previewTicketReminderNotification },
    };
    const exports: any = {};
    runInNewContext(code, {
        exports,
        require: (id: string) => { if (!(id in dependencies)) throw new Error(`Unexpected import: ${id}`); return dependencies[id]; },
        React: {
            Fragment: "Fragment",
            createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props: { ...props as object, children } }),
        },
    });
    return { previewTicketReminderNotification, ticketRemindersState, authorizePanelReminders, refreshTicketReminders, setDiscordReminders, render: (children?: Node) => exports.ReminderSettings({ children }) };
}

const settings = (discordEnabled = true): NonNullable<State["settings"]> => ({
    discordEnabled,
    projects: [
        { project: "majestic", personalReminderMinutes: 5 },
        { project: "russia-online", personalReminderMinutes: 15 },
    ],
});
const checkbox = (tree: Node) => nodes(tree).find(n => n.type === "input" && n.props.type === "checkbox");
const button = (tree: Node, label: string) => nodes(tree).find(n => n.type === "button" && text(n) === label);

describe("reminder settings", () => {
    it.each(["idle", "permission", "loading"] as const)("keeps explicit project previews local and available during %s", phase => {
        const h = harness({ phase }), tree = h.render();
        expect(h.previewTicketReminderNotification).not.toHaveBeenCalled();
        const previews = nodes(tree).filter(n => n.type === "button" && text(n).startsWith("Показать уведомление"));
        expect(previews.map(text)).toEqual(["Показать уведомление · Majestic", "Показать уведомление · Россия Онлайн"]);
        previews.forEach(n => { expect(n.props.disabled).not.toBe(true); n.props.onClick(); });
        expect(h.previewTicketReminderNotification.mock.calls).toEqual([["majestic"], ["russia-online"]]);
        expect(h.authorizePanelReminders).not.toHaveBeenCalled();
        expect(h.refreshTicketReminders).not.toHaveBeenCalled();
        expect(h.setDiscordReminders).not.toHaveBeenCalled();
    });

    it("asks an idle user to sign in without presenting an enabled reminder or fabricated threshold", () => {
        const h = harness();
        const tree = h.render();
        expect(tree.props["aria-label"]).toBe("Личные напоминания");
        expect(nodes(tree).filter(n => n.type === "h3").map(text)).toEqual(["Личные напоминания"]);
        expect(text(tree)).toContain("Войдите в аккаунт панели");
        expect(nodes(tree).filter(n => ["input", "select"].includes(n.type as string))).toHaveLength(0);
        expect(text(tree)).not.toContain(" мин");
        expect(h.ticketRemindersState.use).toHaveBeenCalledOnce();
        expect(h.authorizePanelReminders).not.toHaveBeenCalled();
        expect(h.refreshTicketReminders).not.toHaveBeenCalled();
        expect(h.setDiscordReminders).not.toHaveBeenCalled();
    });

    it("authorizes through the panel when permission is required", () => {
        const h = harness({ phase: "permission" });
        const tree = h.render();
        expect(text(tree)).toContain("Разрешите панели");
        expect(checkbox(tree)).toBeUndefined();
        const authorize = button(tree, "Подключить напоминания")!;
        expect(authorize.props.type).toBe("button");
        authorize.props.onClick();
        expect(h.authorizePanelReminders).toHaveBeenCalledExactlyOnceWith();
        expect(h.setDiscordReminders).not.toHaveBeenCalled();
        expect(h.refreshTicketReminders).not.toHaveBeenCalled();
    });

    it("shows loading status and enables the toggle only after ready settings arrive", () => {
        const h = harness({ phase: "loading" });
        const tree = h.render();
        expect(checkbox(tree)!.props).toMatchObject({ checked: false, disabled: true });
        expect(nodes(tree).filter(n => n.props.role === "status").map(text)).toContain("Загружаем настройки…");
        expect(text(tree)).not.toContain(" мин");
        h.ticketRemindersState.set({ phase: "ready", settings: settings() });
        const ready = h.render();
        expect(checkbox(ready)!.props).toMatchObject({ checked: true, disabled: false });
        expect(text(ready)).not.toContain("Загружаем настройки…");
        expect(h.setDiscordReminders).not.toHaveBeenCalled();
    });

    it.each([true, false])("passes only the boolean %s to the Discord toggle without changing Telegram thresholds", enabled => {
        const saved = settings(!enabled);
        const before = structuredClone(saved);
        saved.projects.forEach(Object.freeze);
        Object.freeze(saved.projects);
        Object.freeze(saved);
        const h = harness({ phase: "ready", settings: saved });
        const toggle = checkbox(h.render())!;
        expect(toggle.props).toMatchObject({ checked: !enabled, disabled: false });
        toggle.props.onChange({ currentTarget: { checked: enabled } });
        expect(h.setDiscordReminders).toHaveBeenCalledExactlyOnceWith(enabled);
        expect(saved).toEqual(before);
        expect(h.authorizePanelReminders).not.toHaveBeenCalled();
        expect(h.refreshTicketReminders).not.toHaveBeenCalled();
    });

    it("displays project thresholds as read-only Telegram settings", () => {
        const tree = harness({ phase: "ready", settings: settings() }).render();
        expect(nodes(tree).filter(n => n.type === "li").map(text)).toEqual(["Majestic5 мин", "Россия Онлайн15 мин"]);
        expect(nodes(tree).filter(n => n.type === "ProjectIcon").map(n => n.props.project)).toEqual(["mj", "ro"]);
        expect(text(tree)).toContain("Порог меняется в Telegram.");
        expect(text(tree)).toContain("Звук и громкость — отдельно для каждого сервера.");
        expect(text(tree)).toContain("Только назначенные вам тикеты, где игрок ждёт ответа.");
        const controls = nodes(tree).filter(n => ["input", "select", "Select", "textarea", "button"].includes(n.type as string) || n.props.contentEditable);
        expect(controls).toHaveLength(1);
        expect(controls[0].props.type).toBe("checkbox");
    });

    it("places supplied personal cards under the master control without duplicate fallback thresholds", () => {
        const h = harness({ phase: "ready", settings: settings() });
        const children: Node = { type: "div", props: { children: "Project audio cards" } };
        const tree = h.render(children);
        expect(nodes(tree).filter(n => n === children)).toHaveLength(1);
        expect(nodes(tree).filter(n => n.type === "li" || n.props["aria-label"] === "Пороги личных напоминаний")).toHaveLength(0);
        expect(nodes(tree).indexOf(checkbox(tree)!)).toBeLessThan(nodes(tree).indexOf(children));
        expect(text(tree)).not.toContain("Общий переключатель для всех серверов");
        expect(text(tree)).toContain("Порог меняется в Telegram.");
        expect(text(tree)).toContain("Звук и громкость — отдельно для каждого сервера.");
        expect(h.setDiscordReminders).not.toHaveBeenCalled();
        expect(h.refreshTicketReminders).not.toHaveBeenCalled();
        expect(h.authorizePanelReminders).not.toHaveBeenCalled();
    });

    it.each(["idle", "permission"] as const)("does not render personal children without authorization in %s", phase => {
        const child: Node = { type: "input", props: { type: "range", "aria-label": "Personal volume" } };
        const tree = harness({ phase, settings: settings() }).render(child);
        expect(nodes(tree)).not.toContain(child);
        expect(checkbox(tree)).toBeUndefined();
        expect(text(tree)).not.toContain(" мин");
    });

    it.each(["majestic", "russia-online"] as const)("keeps standalone thresholds limited to authorized %s", project => {
        const saved = settings(); saved.projects = saved.projects.filter(p => p.project === project);
        const tree = harness({ phase: "ready", settings: saved }).render();
        expect(nodes(tree).filter(n => n.type === "li").map(text)).toEqual([project === "majestic" ? "Majestic5 мин" : "Россия Онлайн15 мин"]);
        expect(nodes(tree).filter(n => n.type === "ProjectIcon").map(n => n.props.project)).toEqual([project === "majestic" ? "mj" : "ro"]);
    });

    it.each([
        { phase: "ready" as const, settings: null, busy: false },
        { phase: "offline" as const, settings: null, busy: false },
        { phase: "offline" as const, settings: settings(), busy: false },
        { phase: "loading" as const, settings: settings(), busy: false },
        { phase: "ready" as const, settings: settings(), busy: true },
    ])("disables the toggle without usable settings or while saving (%j)", patch => {
        const tree = harness(patch).render();
        expect(checkbox(tree)!.props).toMatchObject({ checked: patch.settings?.discordEnabled ?? false, disabled: true });
        if (patch.busy) expect(nodes(tree).filter(n => n.props.role === "status").map(text)).toContain("Сохраняем…");
    });

    it.each(["error", "deliveryError"] as const)("shows %s and retries through the reminder adapter", field => {
        const h = harness({ phase: "offline", [field]: "Не удалось получить напоминания." });
        const tree = h.render();
        expect(nodes(tree).filter(n => n.props.role === "alert").map(text)).toEqual(["Не удалось получить напоминания."]);
        const retry = button(tree, "Повторить проверку")!;
        expect(retry.props).toMatchObject({ type: "button", disabled: false });
        retry.props.onClick();
        expect(h.refreshTicketReminders).toHaveBeenCalledExactlyOnceWith();
        expect(h.setDiscordReminders).not.toHaveBeenCalled();
        expect(h.authorizePanelReminders).not.toHaveBeenCalled();
        h.ticketRemindersState.set({ phase: "ready", settings: settings(), error: "", deliveryError: "" });
        const recovered = h.render();
        expect(nodes(recovered).filter(n => n.props.role === "alert")).toHaveLength(0);
        expect(button(recovered, "Повторить проверку")).toBeUndefined();
    });

    it.each(["idle", "permission"] as const)("keeps errors visible without offering refresh during %s", phase => {
        const tree = harness({ phase, error: "Ошибка авторизации." }).render();
        expect(nodes(tree).filter(n => n.props.role === "alert").map(text)).toEqual(["Ошибка авторизации."]);
        expect(button(tree, "Повторить проверку")).toBeUndefined();
    });

    it.each([
        { phase: "loading" as const, busy: false },
        { phase: "ready" as const, busy: true },
    ])("disables retry while a request is in progress (%j)", patch => {
        const tree = harness({ ...patch, error: "Ошибка настроек.", deliveryError: "Ошибка доставки." }).render();
        expect(button(tree, "Повторить проверку")!.props.disabled).toBe(true);
        expect(nodes(tree).filter(n => n.props.role === "alert").map(text)).toEqual(["Ошибка настроек."]);
    });
});
