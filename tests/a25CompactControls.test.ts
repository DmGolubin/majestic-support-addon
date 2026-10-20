import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/core/state";
import * as types from "../src/core/types";
import * as layout from "../src/core/layout";
import * as geometry from "../src/core/windowPlacement";

type Node = { type: any; props: Record<string, any> };
const nodes = (n: any): Node[] => Array.isArray(n) ? n.flatMap(nodes)
    : n && typeof n === "object" ? [n, ...nodes(n.props?.children)] : [];
const text = (n: any): string => Array.isArray(n) ? n.map(text).join("")
    : n == null || typeof n === "boolean" ? "" : typeof n === "object" ? text(n.props?.children) : String(n);
const key = (extra: Record<string, any> = {}) => ({
    key: "ArrowLeft", altKey: true, nativeEvent: {}, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra,
});
const dragEvent = () => ({ preventDefault: vi.fn(), dataTransfer: { setData: vi.fn(), effectAllowed: "", dropEffect: "" } });
const code = (name: string) => ts.transpileModule(readFileSync(new URL(`../src/vencord/ui/${name}.tsx`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const compiled = { Settings: code("Settings"), WindowPlacement: code("WindowPlacement") };

// Actual TSX event handlers with persistent hook slots; browser pointer capture is covered by QA.
function harness(name: keyof typeof compiled) {
    let saved: any, cursor = 0, phase = "ready";
    const slots: any[] = [];
    const storage = { get: async () => saved, set: async (_key: string, value: unknown) => { saved = structuredClone(value); } };
    const store = new Store(storage);
    const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };
    const hooks = { React, useEffect() {},
        useRef(initial: any) { return slots[cursor++] ??= { current: initial }; },
        useState(initial: any) {
            const i = cursor++;
            if (!(i in slots)) slots[i] = initial;
            return [slots[i], (value: any) => { slots[i] = value; }];
        },
    };
    const deps: Record<string, any> = {
        "@webpack/common": hooks, "../core/types": types, "../core/layout": layout, "../core/windowPlacement": geometry,
        "../platform": { storage }, "../core/trigger": { validPrefix: () => true },
        "./uiState": { store, useStore() {} }, "./panel": { panel: { use: () => ({ phase }) } },
        "./svg": { IconBell: "IconBell", IconSettings: "IconSettings", IconTemplates: "IconTemplates" },
        "./PanelPersonalLibrary": { PanelPersonalLibrary: "PanelPersonalLibrary", discardPanelDraft() {} },
    };
    for (const component of ["DiagnosticControls", "PanelConnection", "TicketSettings", "LocalStorageNotice", "BuildIdentity"])
        deps["./" + component] = { [component]: component };
    const exports: any = {};
    runInNewContext(compiled[name], { exports, React, window: { innerWidth: 1280, innerHeight: 800 },
        require: (id: string) => {
            if (id.endsWith(".css")) return {};
            if (!(id in deps)) throw new Error("Unexpected dependency " + id);
            return deps[id];
        } });
    return { store, storage, phase: (value: string) => { phase = value; },
        render(props?: any): Node { cursor = 0; return name === "Settings" ? exports.Settings() : exports.WindowPlacementControls(props); } };
}
function settings() {
    const h = harness("Settings");
    nodes(h.render()).find(n => n.type === "button" && text(n) === "Настройки")!.props.onClick();
    return { ...h, chips: () => nodes(h.render()).filter(n => n.props["aria-keyshortcuts"]),
        chip: (label: string) => nodes(h.render()).find(n => n.props["aria-keyshortcuts"] && text(n) === label)! };
}

describe("A25 compact tab order", () => {
    it("persists a chip drag through the existing store and announces its position", async () => {
        const h = settings(), event = dragEvent();
        h.chip("Недавние").props.onDragStart(event);
        h.chip("Все").props.onDragOver(event);
        expect(event.dataTransfer.dropEffect).toBe("move");
        h.chip("Все").props.onDrop(event);
        expect(h.chips().map(text)).toEqual(["Недавние", "Все", "Мои", "Избранное"]);
        expect(nodes(h.render()).find(n => n.props.role === "status")!.props["aria-live"]).toBe("polite");
        expect(text(nodes(h.render()).find(n => n.props.role === "status"))).toBe("Недавние: позиция 1 из 4");
        await h.store.flush();
        const restored = new Store(h.storage); await restored.load();
        expect(restored.data.windowTabOrder).toEqual(["recent", "all", "personal", "fav"]);
    });

    it("ignores external/stale drops and leaves a concurrent reorder intact", () => {
        const h = settings(), event = dragEvent();
        h.chip("Все").props.onDrop(event);
        expect(event.preventDefault).not.toHaveBeenCalled();
        h.chip("Недавние").props.onDragStart(event);
        h.store.setWindowTabOrder(["personal", "all", "recent", "fav"]);
        h.chip("Все").props.onDragOver(event);
        expect(event.preventDefault).not.toHaveBeenCalled();
        h.chip("Все").props.onDrop(event);
        expect(h.store.data.windowTabOrder).toEqual(["personal", "all", "recent", "fav"]);
    });

    it("supports bounded Alt+arrows and ignores repeats, IME, other modifiers and drag-time arrows", () => {
        const h = settings();
        for (const extra of [{ altKey: false }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true },
            { nativeEvent: { isComposing: true } }, { keyCode: 229 }, { repeat: true }])
            h.chip("Мои").props.onKeyDown(key(extra));
        expect(h.store.data.windowTabOrder).toEqual(["all", "personal", "fav", "recent"]);
        h.chip("Мои").props.onKeyDown(key());
        expect(h.chip("Мои").props["aria-label"]).toBe("Мои, позиция 1 из 4");
        const boundary = key(); h.chip("Мои").props.onKeyDown(boundary);
        expect(boundary.preventDefault).toHaveBeenCalledOnce();
        expect(h.store.data.windowTabOrder).toEqual(["personal", "all", "fav", "recent"]);
        h.chip("Мои").props.onKeyDown(key({ key: "ArrowRight" }));
        expect(h.store.data.windowTabOrder).toEqual(["all", "personal", "fav", "recent"]);
        h.chip("Мои").props.onDragStart(dragEvent());
        h.chip("Мои").props.onKeyDown(key());
        expect(h.store.data.windowTabOrder).toEqual(["all", "personal", "fav", "recent"]);
        h.chip("Мои").props.onDragEnd();
        h.chip("Мои").props.onKeyDown(key());
        expect(h.store.data.windowTabOrder[0]).toBe("personal");
    });

    it("disables chips offline and rejects a drop after readiness is lost", () => {
        const h = settings(), event = dragEvent();
        h.chip("Мои").props.onDragStart(event); h.phase("offline");
        expect(h.chips()).toHaveLength(4);
        expect(h.chips().every(n => n.props.disabled && !n.props.draggable)).toBe(true);
        h.chip("Все").props.onDrop(event);
        h.chip("Мои").props.onKeyDown(key());
        expect(h.store.data.windowTabOrder).toEqual(["all", "personal", "fav", "recent"]);
    });
});

describe("A25 placement icons", () => {
    it("keeps labelled SVG controls, pin pressed state, keyboard movement and size reset", () => {
        const h = harness("WindowPlacement");
        const placement = { position: null as geometry.WindowPosition | null,
            set: vi.fn((value: geometry.WindowPosition | null) => { placement.position = value; }) };
        const props = { placement, box: { right: 100, bottom: 80, width: 400, height: 500 }, size: null, side: false,
            setSize: vi.fn(), saveSize: vi.fn() };
        const control = (label: string) => nodes(h.render(props)).find(n => n.props["aria-label"] === label)!;
        for (const label of ["Переместить окно", "Закрепить окно", "Сбросить положение и размер окна"]) {
            const button = control(label);
            expect(button.type).toBe("button"); expect(button.props.title).toBeTruthy(); expect(text(button)).toBe("");
            expect(nodes(button).find(n => n.type === "svg")!.props).toMatchObject({ "aria-hidden": "true", focusable: "false" });
        }
        const grip = control("Переместить окно");
        expect(grip.props.onPointerDown).toBeTypeOf("function");
        grip.props.onKeyDown(key({ altKey: false }));
        expect(placement.set).toHaveBeenLastCalledWith({ right: 120, bottom: 80, pinned: false }, true);
        control("Закрепить окно").props.onClick();
        expect(control("Закрепить окно").props["aria-pressed"]).toBe(true);
        expect(control("Переместить окно").props.disabled).toBe(true);
        expect(nodes(h.render(props)).filter(n => n.props.className?.includes("vc-stx-frame-resize"))).toHaveLength(0);
        control("Закрепить окно").props.onClick();
        expect(control("Закрепить окно").props["aria-pressed"]).toBe(false);
        control("Сбросить положение и размер окна").props.onClick();
        expect(placement.position).toBeNull();
        expect(props.setSize).toHaveBeenCalledExactlyOnceWith(null);
        expect(props.saveSize).toHaveBeenCalledExactlyOnceWith(layout.DEFAULT_WINDOW_SIZE);
    });
});
