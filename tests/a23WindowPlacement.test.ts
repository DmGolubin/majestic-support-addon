import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { clampFloatingBox, moveFloatingBox, readWindowPosition, resizeFloatingBox, WINDOW_EDGES } from "../src/core/windowPlacement";
import { serverMode } from "../src/core/guard";

describe("movable picker geometry", () => {
    const box = { right: 100, bottom: 80, width: 400, height: 500 };
    it("moves within viewport and leaves the title bar usable", () => {
        expect(moveFloatingBox(box, -10000, -10000, 1280, 800)).toEqual({ right: 872, bottom: 268, width: 400, height: 500 });
        expect(moveFloatingBox(box, 10000, 10000, 1280, 800)).toEqual({ right: 8, bottom: 8, width: 400, height: 500 });
    });
    it("clamps saved placement and dimensions after switching to a smaller display", () => {
        expect(clampFloatingBox(box, 320, 250)).toEqual({ right: 8, bottom: 8, width: 304, height: 210 });
        expect(readWindowPosition({ right: Infinity, bottom: 0, pinned: false })).toBeNull();
        expect(readWindowPosition({ right: 30, bottom: 40, pinned: true })).toEqual({ right: 30, bottom: 40, pinned: false });
    });
    it("resizes from the right and bottom while preserving opposite edges", () => {
        const next = resizeFloatingBox(box, "se", 40, 30, 1280, 800, 720);
        expect(next).toEqual({ right: 60, bottom: 50, width: 440, height: 530 });
        expect(1280 - next.right - next.width).toBe(1280 - box.right - box.width);
        expect(800 - next.bottom - next.height).toBe(800 - box.bottom - box.height);
    });
    it("resizes top and left while preserving the anchored bottom/right", () => {
        expect(resizeFloatingBox(box, "nw", -40, -30, 1280, 800, 720)).toEqual({ ...box, width: 440, height: 530 });
    });
    it.each(WINDOW_EDGES)("keeps %s gestures bounded at extreme coordinates", edge => {
        for (const delta of [-10000, 10000]) {
            const next = resizeFloatingBox(box, edge, delta, delta, 1280, 800, 720);
            expect(next.width).toBeGreaterThanOrEqual(320);
            expect(next.width).toBeLessThanOrEqual(720);
            expect(next.height).toBeGreaterThanOrEqual(280);
            expect(next.right).toBeGreaterThanOrEqual(8);
            expect(next.bottom).toBeGreaterThanOrEqual(8);
            expect(800 - next.bottom - next.height).toBeGreaterThanOrEqual(32);
        }
    });
});

it("waits for a pending placement write before a newly opened picker restores it", async () => {
    type Instance = { slots: any[]; effects: (() => void)[]; cursor: number };
    let active: Instance;
    let stored: unknown = { right: 10, bottom: 20, pinned: false };
    let release!: () => void;
    const storage = {
        get: vi.fn(async () => stored),
        set: vi.fn((_key: string, value: unknown) => new Promise<void>(resolve => {
            release = () => { stored = value; resolve(); };
        })),
    };
    const api = {
        useState(initial: unknown) {
            const instance = active, slot = instance.cursor++;
            if (!(slot in instance.slots)) instance.slots[slot] = initial;
            return [instance.slots[slot], (value: unknown) => { instance.slots[slot] = value; }];
        },
        useRef(initial: unknown) { return active.slots[active.cursor++] ??= { current: initial }; },
        useEffect(fn: () => void) { active.effects.push(fn); },
    };
    const module: any = {};
    const code = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/WindowPlacement.tsx", import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
    }).outputText;
    runInNewContext(code, { exports: module, require: (name: string) => ({
        "@webpack/common": api, "../platform": { storage }, "../core/windowPlacement": { readWindowPosition },
        "../core/layout": {},
    } as Record<string, unknown>)[name] });
    const create = () => {
        const instance: Instance = { slots: [], effects: [], cursor: 0 };
        active = instance;
        const hook = module.useWindowPlacement();
        instance.effects.forEach(fn => fn());
        return { instance, hook };
    };
    const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    const first = create(); await tick();
    const wanted = { right: 300, bottom: 120, pinned: true };
    first.hook.set(wanted); await tick();
    const second = create(); await tick();
    expect(storage.get).toHaveBeenCalledTimes(1);
    release(); await tick();
    expect(storage.get).toHaveBeenCalledTimes(2);
    expect(second.instance.slots[0]).toEqual({ ...wanted, pinned: false });
});

describe("ticket switching with an open picker", () => {
    function harness(privateType?: number) {
        const ui = { state: { windowOpen: true, inline: {}, menu: {}, dialog: {}, channelRevision: 5 },
            get() { return this.state; }, set(patch: any) { Object.assign(this.state, patch); } };
        const supersede = vi.fn(), clearTargets = vi.fn(), nextGeneration = vi.fn();
        const exports: any = {};
        const code = ts.transpileModule(readFileSync(new URL("../src/vencord/index.tsx", import.meta.url), "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
        }).outputText;
        const deps: Record<string, unknown> = {
            "@utils/types": { default: (v: unknown) => v, OptionType: {} },
            "@api/Settings": { definePluginSettings: (v: unknown) => v },
            "./core/guard": { serverMode },
            "./platform": { currentChannelMode: () => serverMode(null, privateType) },
            "./ui/uiState": { ui }, "./ui/flow": { supersede },
            "./ui/op": { clearTargets, nextGeneration },
            "./ui/debug": { debugEnabled: () => false },
        };
        runInNewContext(code, { exports, require: (name: string) => deps[name] ?? {} });
        return { ui, supersede, clearTargets, nextGeneration, change: exports.channelChanged };
    }
    // IDs belong to the product's fixed supported-server table.
    it("keeps the picker but drops pending actions and targets when entering a supported ticket", () => {
        const h = harness();
        h.change("530693013622489088");
        expect(h.ui.state.windowOpen).toBe(true);
        expect(h.ui.state.inline).toBeNull();
        expect(h.ui.state.dialog).toBeNull();
        expect(h.ui.state.channelRevision).toBe(6);
        expect(h.supersede).toHaveBeenCalledOnce();
        expect(h.clearTargets).toHaveBeenCalledOnce();
        expect(h.nextGeneration).toHaveBeenCalledOnce();
    });
    it.each([1, 3])("keeps an open picker when entering private channel type %s and clears the old editor", type => {
        const h = harness(type);
        h.change(null);
        expect(h.ui.state.windowOpen).toBe(true);
        expect(h.ui.state.dialog).toBeNull();
        expect(h.clearTargets).toHaveBeenCalledOnce();
        expect(h.nextGeneration).toHaveBeenCalledOnce();
    });
    it("closes on an unknown channel and never reopens itself", () => {
        const h = harness();
        h.change(null);
        expect(h.ui.state.windowOpen).toBe(false);
        h.change("530693013622489088");
        expect(h.ui.state.windowOpen).toBe(false);
    });
});
