import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { poolOf, Scope, templateFitsProject } from "../src/core/guard";
import { comboOf } from "../src/core/keys";
import { orderHits } from "../src/core/rank";
import { search } from "../src/core/search";
import { Store } from "../src/core/state";
import { findTrigger } from "../src/core/trigger";

// Execute the actual UI modules. No copied plugin, browser, Discord, network or disk storage.
const compile = (file: string) => ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const inlineCode = compile("../src/vencord/ui/inline.ts");
const latchCode = compile("../src/vencord/ui/keylatch.ts");
const keySource = readFileSync(new URL("../src/vencord/index.tsx", import.meta.url), "utf8");
const keyCode = ts.transpileModule(keySource.slice(keySource.indexOf("const inForeignInput"), keySource.indexOf("let host:")), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const keyEvent = (key: string, extra: Record<string, unknown> = {}) => ({
    key, code: key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    isComposing: false, repeat: false, defaultPrevented: false, ...extra,
    preventDefault: vi.fn(function (this: { defaultPrevented: boolean; }) { this.defaultPrevented = true; }),
    stopPropagation: vi.fn(),
});
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const observable = (initial: any) => {
    let value = initial;
    const subs = new Set<() => void>();
    return {
        get: () => value,
        set: (patch: any) => { value = { ...value, ...patch }; subs.forEach(fn => fn()); },
        subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
        useSelect: (fn: (v: any) => any) => fn(value),
    };
};

async function harness() {
    const store = new Store({ get: async () => undefined, set: async () => {} });
    const id = await store.savePersonal({ title: "Old", text: "Answer", project: "mj", command: "old", color: null, folderId: null });
    const t = store.byId(id)!;
    const ui = observable({ inline: null, management: false });
    const document: any = { body: {}, activeElement: null };
    let selection: any;
    const range = () => ({
        startContainer: null as any, startOffset: 0, endContainer: null as any, endOffset: 0, block: null as any,
        selectNodeContents(block: any) { this.block = block; },
        setStart(node: any, off: number) { this.startContainer = node; this.startOffset = off; },
        setEnd(node: any, off: number) { this.endContainer = node; this.endOffset = off; },
        toString() { return this.block.textContent.slice(0, this.endOffset); },
    });
    document.createRange = range;
    const setCaret = (ed: any, offset = ed.textContent.length) => {
        ed.caret = offset;
        selection = {
            rangeCount: 1, isCollapsed: true, anchorNode: ed.node, focusNode: ed.node, anchorOffset: offset, focusOffset: offset,
            getRangeAt: () => ({ startContainer: ed.node, startOffset: offset }),
            removeAllRanges() {},
            addRange(r: any) {
                this.anchorNode = r.startContainer; this.anchorOffset = r.startOffset;
                this.focusNode = r.endContainer; this.focusOffset = r.endOffset; this.isCollapsed = false;
            },
        };
    };
    const makeEditor = (text: string) => {
        const ed: any = {
            textContent: text, isConnected: true, isContentEditable: true, caret: text.length,
            contains: (n: any) => n === ed || n === ed.node,
            closest: (selector: string) => selector.includes("slate") || selector.includes("channelTextArea") ? ed : null,
            focus: vi.fn(() => {
                document.activeElement = ed;
                if (selection?.focusNode !== ed.node) setCaret(ed, ed.caret);
            }),
        };
        ed.node = { nodeType: 3, parentElement: { closest: () => ed } };
        return ed;
    };
    const ed = makeEditor(";old");
    setCaret(ed); ed.focus();
    const window = { getSelection: () => selection, innerHeight: 800 };
    const insertText = vi.fn(() => true);
    const toast = vi.fn();
    const latchKey = vi.fn();
    let scope: Scope | null = "mj";
    const snapNow = () => ({ scope, setVersion: store.setVersion, editor: ed });
    const flow = {
        prepareText: vi.fn(async (template: any, _target: any, _options: any) => ({ t: template, text: template.text, snap: snapNow() })),
        stillCurrent: vi.fn((snap: any) => snap.setVersion === store.setVersion && ed.isConnected),
        snapNow,
    };
    const dependencies: Record<string, any> = {
        "../core/guard": { templateFitsProject },
        "../core/rank": { orderHits }, "../core/search": { search }, "../core/trigger": { findTrigger },
        "../platform": { insertText, toast },
        "./debug": { costStart: () => 0, costEnd: () => {}, debugEnabled: () => false, dlog: () => {}, noteKey: () => {} },
        "./flow": flow, "./keylatch": { latchKey },
        "./op": { generationNow: () => 1 },
        "./uiState": { store, ui, libraryIsFresh: () => true, ensureLibraryFresh: async () => true, activeScope: () => scope, poolFor: () => poolOf(store.templates, scope, store.data.techProject), useStore: () => {}, useChatRect: () => ({ left: 0, width: 500, top: 600 }) },
        "./ProjectIcon": {}, "./svg": {},
    };
    const evaluate = (code: string) => {
        const module = { exports: {} as any };
        runInNewContext(code, {
            module, exports: module.exports, document, window, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, setTimeout,
            React: { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) },
            require: (name: string) => {
                if (!(name in dependencies)) throw Error("Unmocked dependency: " + name);
                return dependencies[name];
            },
        });
        return module.exports;
    };
    const latch = evaluate(latchCode);
    latchKey.mockImplementation(latch.latchKey);
    const inline = evaluate(inlineCode + "\nexports.runCheck = runCheck;");
    const onKey = runInNewContext(keyCode + "\nonKey;", {
        ...dependencies["./debug"], ...dependencies["./uiState"], ...latch,
        document, handleInlineKey: inline.handleInlineKey, pluginOn: () => !!scope,
        comboOf, templateFitsProject, toast, favoritesOf: () => [], visibleItems: [],
        toggleWindow: vi.fn(), insertTemplate: vi.fn(),
    });
    const openInline = () => ui.set({ inline: { query: "old", length: 4, sel: 0, items: [t], note: "" } });
    return { store, id, t, ui, document, ed, makeEditor, setCaret, flow, inline, onKey, latch, insertText, toast, latchKey, openInline, setScope: (next: Scope | null) => { scope = next; }, selection: () => selection };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("inline cancellation", () => {
    it.each(["Enter", "NumpadEnter"])("Ctrl+%s accepts without a greeting and latches the insertion key", async code => {
        const h = await harness(); h.openInline();
        expect(h.inline.handleInlineKey({ key: "Enter", code, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, isComposing: false })).toBe(true);
        await vi.runAllTimersAsync();
        expect(h.flow.prepareText).toHaveBeenCalledExactlyOnceWith(h.t, { editor: h.ed, selection: "" }, { noGreeting: true });
        expect(h.latchKey).toHaveBeenCalledExactlyOnceWith(code);
        expect(h.insertText).toHaveBeenCalledExactlyOnceWith("Answer");
        expect(h.selection()).toMatchObject({ anchorOffset: 0, focusOffset: 4, isCollapsed: false });
        expect(h.ui.get().inline).toBeNull();
    });
    it.each(["Enter", "NumpadEnter"])("Ctrl+%s and held-key repeats never reach the host send handler", async code => {
        const h = await harness(); h.openInline();
        const send = vi.fn();
        const dispatch = (extra: Record<string, unknown>) => {
            const e = keyEvent("Enter", { code, target: h.ed, ...extra });
            h.onKey(e);
            if (!e.defaultPrevented) send(h.ed.textContent);
            return e;
        };
        const press = dispatch({ ctrlKey: true });
        expect(press.defaultPrevented).toBe(true);
        expect(press.stopPropagation).toHaveBeenCalledOnce();
        await vi.runAllTimersAsync();
        expect(h.insertText).toHaveBeenCalledExactlyOnceWith("Answer");
        expect(h.latch.latchedCode()).toBe(code);
        // Releasing Ctrl first must not let the held Enter send the newly inserted reply.
        for (const ctrlKey of [true, false]) expect(dispatch({ repeat: true, ctrlKey }).defaultPrevented).toBe(true);
        expect(send).not.toHaveBeenCalled();
        expect(h.insertText).toHaveBeenCalledTimes(1);
        expect(dispatch({}).defaultPrevented).toBe(false); // A later deliberate press remains the user's.
        expect(send).toHaveBeenCalledTimes(1);
    });
    it.each([
        ["Enter", {}], ["Tab", {}], ["Tab", { shiftKey: true }], ["Enter", { ctrlKey: true }],
    ])("consumes repeated %s %j without starting an insertion", async (key, modifiers) => {
        const h = await harness(); h.openInline();
        expect(h.inline.handleInlineKey(keyEvent(key, { ...modifiers, repeat: true }))).toBe(true);
        await vi.runAllTimersAsync();
        expect(h.flow.prepareText).not.toHaveBeenCalled();
        expect(h.latchKey).not.toHaveBeenCalled();
        expect(h.insertText).not.toHaveBeenCalled();
    });
    it.each([
        ["Alt", { altKey: true }], ["Meta", { metaKey: true }],
        ["Ctrl+Shift", { ctrlKey: true, shiftKey: true }], ["Ctrl+Alt", { ctrlKey: true, altKey: true }],
        ["Ctrl+Meta", { ctrlKey: true, metaKey: true }], ["Alt+Shift", { altKey: true, shiftKey: true }],
        ["Meta+Shift", { metaKey: true, shiftKey: true }], ["Alt+Meta", { altKey: true, metaKey: true }],
    ])("does not accept Enter or Tab with %s", async (_label, modifiers) => {
        const h = await harness(); h.openInline();
        const state = h.ui.get().inline;
        for (const key of ["Enter", "Tab"]) expect(h.inline.handleInlineKey(keyEvent(key, modifiers))).toBe(false);
        expect(h.ui.get().inline).toBe(state);
        expect(h.flow.prepareText).not.toHaveBeenCalled();
        expect(h.latchKey).not.toHaveBeenCalled();
        expect(h.insertText).not.toHaveBeenCalled();
    });
    it.each([["Enter", { shiftKey: true }], ["Tab", { ctrlKey: true }]])("leaves %s %j to the host", async (key, modifiers) => {
        const h = await harness(); h.openInline();
        expect(h.inline.handleInlineKey(keyEvent(key, modifiers))).toBe(false);
        expect(h.flow.prepareText).not.toHaveBeenCalled();
        expect(h.latchKey).not.toHaveBeenCalled();
    });
    it.each([
        ["Enter", {}], ["Tab", {}], ["Tab", { shiftKey: true }], ["Enter", { ctrlKey: true }],
    ])("consumes %s %j for a note-only popup without inserting or repeating the note", async (key, modifiers) => {
        const h = await harness(); h.openInline();
        h.ui.set({ inline: { ...h.ui.get().inline, items: [], note: "Choose a project" } });
        expect(h.inline.handleInlineKey(keyEvent(key, modifiers))).toBe(true);
        expect(h.inline.handleInlineKey(keyEvent(key, { ...modifiers, repeat: true }))).toBe(true);
        expect(h.toast).toHaveBeenCalledExactlyOnceWith("Choose a project", "message");
        expect(h.flow.prepareText).not.toHaveBeenCalled();
        expect(h.latchKey).not.toHaveBeenCalled();
        expect(h.insertText).not.toHaveBeenCalled();
    });
    it.each(["query", "caret", "prefix", "focus", "scope", "management", "closed"])("does not accept Ctrl+Enter after %s changes", async change => {
        const h = await harness(); h.openInline();
        if (change === "query") h.ed.textContent = ";new";
        if (change === "caret") h.setCaret(h.ed, 2);
        if (change === "prefix") h.store.setPrefix("!");
        if (change === "focus") h.document.activeElement = { closest: () => null };
        if (change === "scope") h.setScope(null);
        if (change === "management") h.ui.set({ management: true });
        if (change === "closed") h.ui.set({ inline: null });
        expect(h.inline.handleInlineKey(keyEvent("Enter", { ctrlKey: true }))).toBe(false);
        expect(h.ui.get().inline).toBeNull();
        expect(h.flow.prepareText).not.toHaveBeenCalled();
        expect(h.latchKey).not.toHaveBeenCalled();
    });
    it.each([{ isComposing: true }, { keyCode: 229 }])("leaves IME Ctrl+Enter untouched: %j", async composition => {
        const h = await harness(); h.openInline();
        const state = h.ui.get().inline;
        expect(h.inline.handleInlineKey(keyEvent("Enter", { ctrlKey: true, ...composition }))).toBe(false);
        expect(h.ui.get().inline).toBe(state);
        expect(h.flow.prepareText).not.toHaveBeenCalled();
        expect(h.latchKey).not.toHaveBeenCalled();
    });
    it.each(["cancel", "draft", "reset"])("Ctrl+Enter preserves %s cancellation and swallows double taps during preparation", async change => {
        const h = await harness(); h.openInline();
        const ready = deferred<any>(); h.flow.prepareText.mockImplementationOnce(() => ready.promise);
        expect(h.inline.handleInlineKey(keyEvent("Enter", { ctrlKey: true }))).toBe(true);
        expect(h.inline.isAccepting()).toBe(true);
        for (const key of ["Enter", "Tab"]) {
            for (const repeat of [true, false]) expect(h.inline.handleInlineKey(keyEvent(key, { repeat }))).toBe(true);
        }
        expect(h.flow.prepareText).toHaveBeenCalledTimes(1);
        expect(h.latchKey).toHaveBeenCalledExactlyOnceWith("Enter");
        if (change === "draft") h.ed.textContent = "Changed";
        if (change === "reset") h.inline.resetInline();
        ready.resolve(change === "cancel" ? null : { t: h.t, text: "Answer", snap: h.flow.snapNow() });
        await vi.runAllTimersAsync();
        expect(h.insertText).not.toHaveBeenCalled();
        expect(h.inline.isAccepting()).toBe(false);
    });
    it.each(["selection", "focus", "draft", "library", "reset"])("Ctrl+Enter cancels %s changes during Slate's delay", async change => {
        const h = await harness(); h.openInline();
        expect(h.inline.handleInlineKey(keyEvent("Enter", { ctrlKey: true }))).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.selection().isCollapsed).toBe(false);
        if (change === "selection") h.setCaret(h.ed, 1);
        if (change === "focus") h.makeEditor("Other").focus();
        if (change === "draft") h.ed.textContent = "Changed";
        if (change === "library") h.store.setVersion++;
        if (change === "reset") h.inline.resetInline();
        await vi.runAllTimersAsync();
        expect(h.insertText).not.toHaveBeenCalled();
        expect(h.inline.isAccepting()).toBe(false);
    });
    it("A27 refreshes quick-input suggestions across projects while keeping FAQ scoped and closing on access loss", async () => {
        const h = await harness();
        Object.assign(h.t, { project: "ro", personalVisibleIn: ["mj", "ro"] });
        const faq = { ...h.t, id: "faq:russia-online:1", source: "faq" as const, personalVisibleIn: undefined };
        h.store.templates.push(faq);
        h.inline.runCheck();
        expect(h.ui.get().inline.items).toEqual([h.t]);
        h.setScope("ro"); h.inline.runCheck();
        expect(h.ui.get().inline.items).toEqual([h.t, faq]);
        h.setScope("mj"); h.inline.runCheck();
        expect(h.ui.get().inline.items).toEqual([h.t]);
        h.setScope(null); h.inline.runCheck();
        expect(h.ui.get().inline).toBeNull();
    });
    it.each(["ArrowDown", "ArrowUp", "Enter", "Tab"])("does not consume %s after focus leaves its editor", async key => {
        const h = await harness(); h.openInline();
        h.document.activeElement = { closest: () => null };
        expect(h.inline.handleInlineKey({ key, code: key })).toBe(false);
        expect(h.ui.get().inline).toBeNull();
        expect(h.flow.prepareText).not.toHaveBeenCalled();
    });
    it("does not consume a key from a stale trigger before the next animation frame", async () => {
        const h = await harness(); h.openInline(); h.ed.textContent = "plain text"; h.setCaret(h.ed);
        expect(h.inline.handleInlineKey({ key: "Enter", code: "Enter" })).toBe(false);
        expect(h.ui.get().inline).toBeNull();
    });
    it("replaces an unchanged trigger once", async () => {
        const h = await harness(); h.openInline();
        const pending = h.inline.acceptInline(0, false);
        await vi.runAllTimersAsync(); await pending;
        expect(h.insertText).toHaveBeenCalledExactlyOnceWith("Answer");
        expect(h.selection()).toMatchObject({ anchorOffset: 0, focusOffset: 4, isCollapsed: false });
    });
    it.each(["dialog", "body"])("restores the original caret after a normal %s focus handoff", async owner => {
        const h = await harness(); h.ed.textContent = ";old suffix"; h.setCaret(h.ed, 4); h.openInline();
        const ready = deferred<any>();
        h.flow.prepareText.mockImplementationOnce(() => ready.promise);
        const pending = h.inline.acceptInline(0, false);
        h.document.activeElement = owner === "body" ? h.document.body : { closest: () => ({}) };
        // The dialog owns the DOM selection too. Editor.focus restores its remembered Slate caret.
        h.selection().anchorNode = h.selection().focusNode = { dialogText: true };
        ready.resolve({ t: h.t, text: "Filled", snap: h.flow.snapNow() });
        await vi.runAllTimersAsync(); await pending;
        expect(h.document.activeElement).toBe(h.ed);
        expect(h.insertText).toHaveBeenCalledExactlyOnceWith("Filled");
        expect(h.selection()).toMatchObject({ anchorOffset: 0, focusOffset: 4 });
    });
    it.each(["query", "caret", "prefix", "other editor", "foreign input"])("cancels a changed %s during preparation", async change => {
        const h = await harness(); h.openInline();
        const ready = deferred<any>(); h.flow.prepareText.mockImplementationOnce(() => ready.promise);
        const pending = h.inline.acceptInline(0, false);
        if (change === "query") { h.ed.textContent = ";other"; h.setCaret(h.ed); }
        if (change === "caret") h.setCaret(h.ed, 2);
        if (change === "prefix") h.store.setPrefix("!");
        if (change === "other editor") h.makeEditor("Other draft").focus();
        if (change === "foreign input") h.document.activeElement = { closest: () => null };
        ready.resolve({ t: h.t, text: "Answer", snap: h.flow.snapNow() });
        await vi.runAllTimersAsync(); await pending;
        expect(h.insertText).not.toHaveBeenCalled();
    });
    it.each(["selection", "focus", "draft", "library", "reset"])("cancels %s changes during Slate's 30ms delay", async change => {
        const h = await harness(); h.openInline();
        const pending = h.inline.acceptInline(0, false);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.selection().isCollapsed).toBe(false);
        if (change === "selection") h.setCaret(h.ed, 1);
        if (change === "focus") h.makeEditor("Other").focus();
        if (change === "draft") h.ed.textContent = "Changed";
        if (change === "library") h.store.setVersion++;
        if (change === "reset") h.inline.resetInline();
        await vi.runAllTimersAsync(); await pending;
        expect(h.insertText).not.toHaveBeenCalled();
    });
    it("rejects a popup whose query no longer matches before preparation", async () => {
        const h = await harness(); h.openInline(); h.ed.textContent = ";new";
        await h.inline.acceptInline(0, false);
        expect(h.flow.prepareText).not.toHaveBeenCalled();
        expect(h.insertText).not.toHaveBeenCalled();
    });
    it.each(["Tab", "Enter", "ArrowDown", "Escape"])("leaves IME %s untouched, including keyCode 229", async key => {
        const h = await harness(); h.openInline();
        const state = h.ui.get().inline;
        for (const composition of [{ isComposing: true, keyCode: 0 }, { isComposing: false, keyCode: 229 }]) {
            expect(h.inline.handleInlineKey({ key, code: key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...composition })).toBe(false);
        }
        expect(h.ui.get().inline).toBe(state);
        expect(h.latchKey).not.toHaveBeenCalled();
        expect(h.flow.prepareText).not.toHaveBeenCalled();
    });
    it("leaves IME Tab untouched even while an acceptance is pending", async () => {
        const h = await harness(); h.openInline();
        const ready = deferred<any>(); h.flow.prepareText.mockImplementationOnce(() => ready.promise);
        const pending = h.inline.acceptInline(0, false);
        expect(h.inline.isAccepting()).toBe(true);
        expect(h.inline.handleInlineKey({ key: "Tab", code: "Tab", isComposing: true })).toBe(false);
        expect(h.latchKey).not.toHaveBeenCalled();
        ready.resolve(null); await pending;
        expect(h.insertText).not.toHaveBeenCalled();
    });
    it.each([
        ["Tab", false, false], ["Enter", false, false], ["Tab", true, true],
    ])("preserves %s with Shift=%s and noGreeting=%s", async (key, shiftKey, noGreeting) => {
        const h = await harness(); h.openInline();
        expect(h.inline.handleInlineKey(keyEvent(key, { shiftKey }))).toBe(true);
        await vi.runAllTimersAsync();
        expect(h.flow.prepareText).toHaveBeenCalledExactlyOnceWith(h.t, { editor: h.ed, selection: "" }, { noGreeting });
        expect(h.latchKey).toHaveBeenCalledExactlyOnceWith(key);
        expect(h.insertText).toHaveBeenCalledExactlyOnceWith("Answer");
    });
});
