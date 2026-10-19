import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { comboOf } from "../src/core/keys";

// Execute the actual adapter onKey/handleKey, without starting Discord, storage or a session.
const source = readFileSync(new URL("../src/vencord/index.tsx", import.meta.url), "utf8");
const handler = ts.transpileModule(source.slice(source.indexOf("const inForeignInput"), source.indexOf("let host:")), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function target(kind = "body") {
    const editor = { closest: () => kind === "chat" ? {} : null };
    return {
        isContentEditable: ["rich", "rich-child", "chat", "foreign-slate"].includes(kind),
        closest(selector: string): any {
            if (selector === ".vc-stx-root") return kind === "own" ? {} : null;
            if (selector === ".vc-stx-settings") return kind === "settings" ? {} : null;
            if (selector === "input, textarea, select") return ["input", "textarea", "select", "own", "settings"].includes(kind) ? {} : null;
            if (selector === '[data-slate-editor="true"]') return ["chat", "foreign-slate"].includes(kind) ? editor : null;
            if (selector.includes("[contenteditable]")) return ["rich", "rich-child", "chat", "foreign-slate", "textbox"].includes(kind) ? {} : null;
            return null;
        },
    };
}

function event(code: string, extra: Record<string, unknown> = {}) {
    return { code, key: code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
        repeat: false, defaultPrevented: false, target: target(),
        preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
}

function harness() {
    const state = { windowOpen: false, management: false, menu: null, dialog: null };
    const template = { id: "answer" };
    const favorites: unknown[] = [];
    const visible: unknown[] = [];
    const binds: Record<string, unknown> = {};
    const insert = vi.fn(), toggle = vi.fn(), latch = vi.fn();
    const swallow = vi.fn(() => false), inline = vi.fn(() => false), enabled = vi.fn(() => true);
    const context = {
        ui: { get: () => state }, swallowLatched: swallow, pluginOn: enabled,
        handleInlineKey: inline, comboOf, favoritesOf: () => favorites, visibleItems: visible,
        poolFor: () => [], activeScope: () => "mj",
        store: { ctx: () => ({}), templateForCombo: (combo: string) => binds[combo] },
        insertTemplate: insert, toggleWindow: toggle, latchKey: latch,
        debugEnabled: () => false, dlog: vi.fn(), noteKey: vi.fn(), keyDesc: () => "",
        costStart: () => 0, costEnd: vi.fn(),
    };
    const onKey = runInNewContext(handler + "\nonKey;", context) as (e: ReturnType<typeof event>) => void;
    return { onKey, state, template, favorites, visible, binds, insert, toggle, latch, swallow, inline, enabled };
}

describe("Role15 keyboard conflict regressions — actual onKey", () => {
    it.each([{ isComposing: true }, { keyCode: 229 }, { getModifierState: (key: string) => key === "AltGraph" }])(
        "does not treat text composition as a window, favorite or custom shortcut: %j", flags => {
            const h = harness(); h.favorites.push(h.template); h.binds["Ctrl+KeyK"] = h.template;
            for (const e of [event("KeyT", { ctrlKey: true, altKey: true, ...flags }),
                event("Digit1", { altKey: true, ...flags }), event("KeyK", { ctrlKey: true, ...flags })]) {
                e.target = target("chat"); h.onKey(e);
                expect(e.preventDefault).not.toHaveBeenCalled(); expect(e.stopPropagation).not.toHaveBeenCalled();
            }
            expect(h.toggle).not.toHaveBeenCalled(); expect(h.insert).not.toHaveBeenCalled();
            expect(h.inline).not.toHaveBeenCalled(); expect(h.latch).not.toHaveBeenCalled();
        },
    );

    it.each([false, true])("leaves missing Alt slots unclaimed (windowOpen=%s), including repeats", open => {
        const h = harness(); h.state.windowOpen = open;
        for (const repeat of [false, true]) {
            const e = event("Digit9", { altKey: true, repeat }); h.onKey(e);
            expect(e.preventDefault).not.toHaveBeenCalled(); expect(e.stopPropagation).not.toHaveBeenCalled();
        }
        expect(h.insert).not.toHaveBeenCalled(); expect(h.latch).not.toHaveBeenCalled();
    });

    it.each([false, true])("preserves populated Alt slots and repeat suppression (windowOpen=%s)", open => {
        const h = harness(); h.state.windowOpen = open;
        (open ? h.visible : h.favorites).push(h.template);
        for (const repeat of [false, true]) {
            const e = event("Digit1", { altKey: true, repeat }); h.onKey(e);
            expect(e.preventDefault).toHaveBeenCalledOnce(); expect(e.stopPropagation).toHaveBeenCalledOnce();
        }
        expect(h.insert).toHaveBeenCalledExactlyOnceWith(h.template, { via: "alt-1" });
        expect(h.latch).toHaveBeenCalledExactlyOnceWith("Digit1");
    });

    it.each(["input", "textarea", "select", "rich", "rich-child", "textbox", "foreign-slate"])("ignores all new shortcuts in foreign %s", kind => {
        const h = harness(); h.favorites.push(h.template); h.binds["Ctrl+KeyK"] = h.template;
        for (const e of [event("Digit1", { altKey: true }), event("KeyK", { ctrlKey: true }), event("KeyT", { ctrlKey: true, altKey: true })]) {
            e.target = target(kind); h.onKey(e);
            expect(e.preventDefault).not.toHaveBeenCalled(); expect(e.stopPropagation).not.toHaveBeenCalled();
        }
        expect(h.insert).not.toHaveBeenCalled(); expect(h.toggle).not.toHaveBeenCalled(); expect(h.inline).not.toHaveBeenCalled();
    });

    it.each(["chat", "own", "body"])("preserves shortcuts in %s", kind => {
        const h = harness(); h.binds["Ctrl+KeyK"] = h.template;
        const e = event("KeyK", { ctrlKey: true, target: target(kind) }); h.onKey(e);
        expect(e.preventDefault).toHaveBeenCalledOnce(); expect(h.insert).toHaveBeenCalledOnce();
        const hotkey = event("KeyT", { ctrlKey: true, altKey: true, target: target(kind) }); h.onKey(hotkey);
        expect(h.toggle).toHaveBeenCalledOnce();
    });

    it("respects earlier event claims for hotkeys, favorites, binds and inline", () => {
        const h = harness(); h.favorites.push(h.template); h.binds["Ctrl+KeyK"] = h.template;
        for (const e of [event("KeyT", { ctrlKey: true, altKey: true }), event("Digit1", { altKey: true }), event("KeyK", { ctrlKey: true })]) {
            e.defaultPrevented = true; h.onKey(e);
            expect(e.preventDefault).not.toHaveBeenCalled(); expect(e.stopPropagation).not.toHaveBeenCalled();
        }
        expect(h.toggle).not.toHaveBeenCalled(); expect(h.insert).not.toHaveBeenCalled(); expect(h.inline).not.toHaveBeenCalled();
    });

    it.each([{ metaKey: true }, { shiftKey: true }, { ctrlKey: false }, { altKey: false }])("requires the exact window chord: %j", modifiers => {
        const h = harness(); const e = event("KeyT", { ctrlKey: true, altKey: true, ...modifiers }); h.onKey(e);
        expect(h.toggle).not.toHaveBeenCalled(); expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it("retains explicit custom Meta chords and window-hotkey repeat behavior", () => {
        const h = harness(); h.binds["Ctrl+Alt+Meta+KeyT"] = h.template;
        h.onKey(event("KeyT", { ctrlKey: true, altKey: true, metaKey: true }));
        expect(h.insert).toHaveBeenCalledOnce(); expect(h.toggle).not.toHaveBeenCalled();
        const repeat = event("KeyT", { ctrlKey: true, altKey: true, repeat: true }); h.onKey(repeat);
        expect(repeat.preventDefault).toHaveBeenCalledOnce(); expect(h.toggle).not.toHaveBeenCalled();
    });

    it("keeps deliberate latch handling ahead of earlier claims", () => {
        const h = harness(); h.swallow.mockReturnValue(true);
        h.onKey(event("Digit1", { altKey: true, repeat: true, defaultPrevented: true }));
        expect(h.swallow).toHaveBeenCalledOnce(); expect(h.inline).not.toHaveBeenCalled(); expect(h.insert).not.toHaveBeenCalled();
    });

    it.each([{ ctrlKey: true }, { shiftKey: true }, { metaKey: true }])("does not claim modified Alt-number chords: %j", modifiers => {
        const h = harness(); h.favorites.push(h.template);
        const e = event("Digit1", { altKey: true, ...modifiers }); h.onKey(e);
        expect(e.preventDefault).not.toHaveBeenCalled(); expect(h.insert).not.toHaveBeenCalled();
    });

    it("leaves disabled-guild shortcuts and ordinary unbound input untouched", () => {
        const h = harness(); h.enabled.mockReturnValue(false);
        const e = event("KeyT", { ctrlKey: true, altKey: true }); h.onKey(e);
        expect(e.preventDefault).not.toHaveBeenCalled(); expect(h.toggle).not.toHaveBeenCalled();
        h.enabled.mockReturnValue(true);
        const plain = event("KeyQ"); h.onKey(plain);
        expect(plain.preventDefault).not.toHaveBeenCalled(); expect(h.insert).not.toHaveBeenCalled();
    });
});
