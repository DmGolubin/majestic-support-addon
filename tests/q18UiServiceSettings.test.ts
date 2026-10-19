import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

type Node = { type: unknown; props: Record<string, any>; };
const nodes = (node: any): Node[] => Array.isArray(node) ? node.flatMap(nodes)
    : !node || typeof node !== "object" ? [] : [node, ...nodes(node.props?.children)];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join("")
    : node == null || typeof node === "boolean" ? "" : typeof node === "object" ? text(node.props?.children) : String(node);

// Render the actual component with persistent hook state and explicit effect cleanup.
// Native Settings and plugin host lifetimes are independent; no Discord/API calls occur.
function harness(active = true) {
    let host: object | null = active ? {} : null;
    let phase = "ready";
    let cursor = 0;
    const slots: any[] = [];
    const effects: { setup: () => (() => void); cleanup?: () => void; }[] = [];
    const hooks = {
        useRef(initial: any) { const i = cursor++; return slots[i] ??= { current: initial }; },
        useState(initial: any) {
            const i = cursor++;
            if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
            return [slots[i], (value: any) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
        },
        useEffect(setup: () => (() => void), deps: unknown[]) {
            const i = cursor++;
            // This component needs a mount/unmount effect, not a render-triggered handoff.
            expect(deps).toEqual([]);
            if (i in slots) return;
            const effect = { setup, cleanup: setup() };
            slots[i] = effect;
            effects.push(effect);
        },
    };
    const BuildIdentity = vi.fn(), DiagnosticControls = vi.fn(), set = vi.fn();
    const deps: Record<string, any> = {
        "./settings-layout.css": {},
        "@webpack/common": hooks,
        "./BuildIdentity": { BuildIdentity },
        "./DiagnosticControls": { DiagnosticControls },
        "./panel": { panel: { useSelect: (select: any) => select({ phase }) } },
        "./uiState": { ui: { set } },
    };
    const exports: any = {};
    const source = readFileSync(new URL("../src/vencord/ui/NativeServiceSettings.tsx", import.meta.url), "utf8");
    const code = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
    }).outputText;
    runInNewContext(code, {
        exports,
        React: { createElement: (type: unknown, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) },
        document: { getElementById: (id: string) => { expect(id).toBe("vc-stx-host"); return host; } },
        require: (id: string) => {
            if (!(id in deps)) throw new Error(`Unexpected import: ${id}`);
            return deps[id];
        },
    });
    const render = () => { cursor = 0; return exports.NativeServiceSettings(); };
    const unmount = () => effects.forEach(effect => effect.cleanup?.());
    const replayMountEffects = () => effects.forEach(effect => { effect.cleanup?.(); effect.cleanup = effect.setup(); });
    return {
        render, unmount, replayMountEffects, set, BuildIdentity, DiagnosticControls,
        stop: () => { host = null; }, restart: () => { host = {}; }, setPhase: (value: string) => { phase = value; },
    };
}

const button = (tree: Node) => nodes(tree).find(node => node.type === "button")!;
const phases = [
    ["idle", "Вход не выполнен"], ["connecting", "Подключение"], ["pending", "Ожидание подтверждения"],
    ["loading", "Загрузка библиотеки"], ["ready", "Подключено"], ["offline", "Нет связи с панелью"], ["error", "Ошибка подключения"],
];

describe("Q18 native service settings", () => {
    it("contains root build identity, status and diagnostics without editor or settings tabs", () => {
        const h = harness(), tree = h.render();
        const all = nodes(tree);
        expect(tree.props.children.some((child: Node) => child?.type === h.BuildIdentity)).toBe(true);
        expect(all.find(node => node.type === h.DiagnosticControls)?.props.available).toBe(true);
        expect(all.filter(node => node.type === "button")).toHaveLength(1);
        expect(text(button(tree))).toBe("Перейти в SupportTemplates");
        expect(text(tree)).toContain("Шаблоны, звук и параметры работы находятся в основном окне SupportTemplates.");
        expect(all.some(node => ["nav", "form", "input", "textarea"].includes(node.type as string)
            || ["tab", "tablist", "tabpanel"].includes(node.props.role) || node.props.contentEditable)).toBe(false);
        expect(all.filter(node => typeof node.type === "function").map(node => node.type)).toEqual([h.BuildIdentity, h.DiagnosticControls]);
        h.unmount();
        expect(h.set).not.toHaveBeenCalled();
    });

    it.each(phases)("shows the current %s connection phase", (phase, label) => {
        const h = harness();
        h.render();
        h.setPhase(phase);
        expect(nodes(h.render()).some(node => node.props.role === "status" && text(node) === label)).toBe(true);
        h.unmount();
        expect(h.set).not.toHaveBeenCalled();
    });

    it("disables handoff and recording when the plugin host is absent", () => {
        const h = harness(false), tree = h.render();
        expect(button(tree).props.disabled).toBe(true);
        expect(text(tree)).toContain("Плагин выключен");
        expect(nodes(tree).find(node => node.type === h.DiagnosticControls)?.props.available).toBe(false);
        button(tree).props.onClick(); // Even a stale/programmatic activation cannot queue an absent host.
        h.restart();
        h.unmount();
        expect(h.set).not.toHaveBeenCalled();
    });

    it("queues only an explicit click and opens management once after service panel unmount", () => {
        const h = harness(), tree = h.render();
        h.replayMountEffects(); // A mount effect replay must not open management.
        expect(h.set).not.toHaveBeenCalled();
        button(tree).props.onClick();
        const queued = h.render();
        expect(button(queued).props.disabled).toBe(true);
        expect(text(queued)).toContain("Закройте настройки Discord — откроется SupportTemplates.");
        expect(h.set).not.toHaveBeenCalled();
        h.unmount();
        expect(h.set).toHaveBeenCalledExactlyOnceWith({ management: true, windowOpen: false, menu: null, inline: null });
        h.unmount();
        expect(h.set).toHaveBeenCalledTimes(1);
    });

    it("does not open on sidebar navigation without a queued click", () => {
        const h = harness();
        h.render();
        h.unmount();
        h.restart();
        expect(h.set).not.toHaveBeenCalled();
    });

    it("does not open if the plugin stops after queueing, without requiring a settings rerender", () => {
        const h = harness();
        button(h.render()).props.onClick();
        h.stop();
        h.unmount();
        expect(h.set).not.toHaveBeenCalled();
    });

    it("does not carry queued intent into a restarted plugin host", () => {
        const h = harness();
        button(h.render()).props.onClick();
        h.stop();
        h.restart();
        h.unmount();
        expect(h.set).not.toHaveBeenCalled();
    });

    it("rechecks the host when a previously enabled button is activated after stop", () => {
        const h = harness(), tree = h.render();
        h.stop();
        button(tree).props.onClick();
        h.restart();
        h.unmount();
        expect(h.set).not.toHaveBeenCalled();
    });
});
