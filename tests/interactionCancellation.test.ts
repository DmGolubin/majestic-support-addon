import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinPieces } from "../src/core/compose";
import { orderHits } from "../src/core/rank";
import { search } from "../src/core/search";
import { Store } from "../src/core/state";
import { findTrigger } from "../src/core/trigger";

// Execute the actual UI modules. No copied plugin, browser, Discord, network or disk storage.
const compile = (file: string) => ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const inlineCode = compile("../src/vencord/ui/inline.ts");
const composeCode = compile("../src/vencord/ui/ComposeBar.tsx");
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
const button = (node: any): any => {
    if (!node || typeof node !== "object") return;
    if (node.type === "button" && node.props.children.includes("Вставить всё")) return node;
    for (const child of (node.props?.children ?? []).flat(Infinity)) {
        const found = button(child);
        if (found) return found;
    }
};

async function harness() {
    const store = new Store({ get: async () => undefined, set: async () => {} });
    const id = await store.savePersonal({ title: "Old", text: "Answer", project: "mj", command: "old", color: null, folderId: null });
    const t = store.byId(id)!;
    const ui = observable({ inline: null, compose: [], management: false });
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
            textContent: text, isConnected: true, caret: text.length,
            contains: (n: any) => n === ed || n === ed.node,
            closest: (selector: string) => selector.includes("slate") ? ed : null,
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
    const resetComposeTarget = vi.fn();
    const snapNow = () => ({ scope: "mj", setVersion: store.setVersion, editor: ed });
    const flow = {
        prepareText: vi.fn(async (template: any, _target: any, _options: any) => ({ t: template, text: template.text, snap: snapNow() })),
        stillCurrent: vi.fn((snap: any) => snap.setVersion === store.setVersion && ed.isConnected),
        snapNow, focusTarget: vi.fn(), fillFields: vi.fn(async (_title: string, text: string): Promise<string | null> => text),
        confirmedForeign: new Set<string>(),
    };
    // Persistent hook slots and explicit render/cleanup: exercise handlers across re-renders, not just one closure.
    const slots: any[] = [], effects: (() => void)[] = [], cleanups: (() => void)[] = [];
    let cursor = 0;
    const hooks = {
        useRef(value: any) { const i = cursor++; return slots[i] ??= { current: value }; },
        useState(value: any) {
            const i = cursor++;
            if (!(i in slots)) slots[i] = value;
            return [slots[i], (next: any) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }];
        },
        useEffect(effect: () => (() => void)) {
            const i = cursor++;
            if (!(i in slots)) { slots[i] = true; effects.push(() => cleanups.push(effect())); }
        },
    };
    const dependencies: Record<string, any> = {
        "@webpack/common": hooks,
        "../core/rank": { orderHits }, "../core/search": { search }, "../core/trigger": { findTrigger }, "../core/compose": { joinPieces },
        "../platform": { insertText, toast },
        "./debug": { costStart: () => 0, costEnd: () => {}, debugEnabled: () => false, dlog: () => {} },
        "./flow": flow, "./keylatch": { latchKey },
        "./op": { generationNow: () => 1, composeEditor: () => ed, composeTargetNow: () => ({ editor: ed, selection: "" }), resetComposeTarget },
        "./uiState": { store, ui, libraryIsFresh: () => true, ensureLibraryFresh: async () => true, activeScope: () => "mj", poolFor: () => store.templates, useStore: () => {}, useChatRect: () => ({ left: 0, width: 500, top: 600 }) },
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
    const inline = evaluate(inlineCode);
    const compose = evaluate(composeCode);
    const render = () => {
        cursor = 0;
        const tree = compose.ComposeBar();
        effects.splice(0).forEach(fn => fn());
        return button(tree);
    };
    render(); // Host keeps the component mounted even with an empty reply.
    const openInline = () => ui.set({ inline: { query: "old", length: 4, sel: 0, items: [t], note: "" } });
    const collect = () => { ui.set({ compose: [id] }); return render(); };
    return { store, id, t, ui, document, ed, makeEditor, setCaret, flow, inline, insertText, toast, latchKey, resetComposeTarget, openInline, collect, render, unmount: () => cleanups.splice(0).forEach(fn => fn()), selection: () => selection };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("inline cancellation", () => {
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
    it("still accepts plain Shift+Tab without a greeting and latches the key", async () => {
        const h = await harness(); h.openInline();
        expect(h.inline.handleInlineKey({ key: "Tab", code: "Tab", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, isComposing: false })).toBe(true);
        await vi.runAllTimersAsync();
        expect(h.flow.prepareText.mock.calls[0][2]).toEqual({ noGreeting: true });
        expect(h.latchKey).toHaveBeenCalledExactlyOnceWith("Tab");
        expect(h.insertText).toHaveBeenCalledTimes(1);
    });
});

describe("compose cancellation", () => {
    it("releases a disconnected target before preparation while retaining the collected reply", async () => {
        const h = await harness(); const b = h.collect();
        h.ed.isConnected = false;
        await b.props.onClick();
        expect(h.resetComposeTarget).toHaveBeenCalledTimes(1);
        expect(h.flow.fillFields).not.toHaveBeenCalled();
        expect(h.insertText).not.toHaveBeenCalled();
        expect(h.ui.get().compose).toEqual([h.id]);
        expect(h.render().props.disabled).toBe(false);
    });
    it("locks synchronously across double clicks and rerenders, then inserts once", async () => {
        const h = await harness(); const first = h.collect();
        const ready = deferred<string>(); h.flow.fillFields.mockImplementationOnce(() => ready.promise);
        const pending = first.props.onClick();
        await first.props.onClick();
        const next = h.render(); expect(next.props.disabled).toBe(true);
        await next.props.onClick();
        expect(h.flow.fillFields).toHaveBeenCalledTimes(1);
        ready.resolve("Reply"); await pending;
        expect(h.insertText).toHaveBeenCalledExactlyOnceWith("Reply");
        expect(h.ui.get().compose).toEqual([]);
    });
    it.each(["clear", "replace", "reorder in place", "template edit", "unmount"])("cancels %s while filling fields", async change => {
        const h = await harness(); const b = h.collect();
        const ready = deferred<string>(); h.flow.fillFields.mockImplementationOnce(() => ready.promise);
        const pending = b.props.onClick();
        if (change === "clear") h.ui.set({ compose: [] });
        if (change === "replace") h.ui.set({ compose: [h.id] });
        if (change === "reorder in place") h.ui.get().compose.push("another-id");
        if (change === "template edit") await h.store.savePersonal({ ...h.t, text: "Visit russia.online", folderId: null }, h.id);
        if (change === "unmount") h.unmount();
        ready.resolve("Old reply"); await pending;
        expect(h.insertText).not.toHaveBeenCalled();
    });
    it.each(["version", "identity", "content", "deletion"])("rejects template %s changes made before Insert all", async change => {
        const h = await harness(); const staleButton = h.collect();
        if (change === "version") h.store.setVersion++;
        if (change === "identity") h.store.templates = [{ ...h.t }];
        if (change === "content") h.t.text = "Visit russia.online";
        if (change === "deletion") h.store.templates = [];
        // Unrelated UI notification also exercises invalidation before a fresh render.
        h.ui.set({ inline: null });
        await staleButton.props.onClick();
        expect(h.ui.get().compose).toEqual([]);
        expect(h.flow.fillFields).not.toHaveBeenCalled();
        expect(h.insertText).not.toHaveBeenCalled();
    });
    it("clears an edited collected template and permits explicitly collecting it again", async () => {
        const h = await harness(); h.collect();
        await h.store.savePersonal({ ...h.t, text: "Updated", folderId: null }, h.id);
        expect(h.ui.get().compose).toEqual([]);
        expect(h.render()).toBeUndefined();
        await h.collect().props.onClick();
        expect(h.insertText).toHaveBeenCalledExactlyOnceWith("Updated");
    });
    it.each(["cancel", "reject", "insert failure"])("releases the busy lock after %s so a retry works", async outcome => {
        const h = await harness(); const b = h.collect();
        if (outcome === "cancel") h.flow.fillFields.mockResolvedValueOnce(null);
        if (outcome === "reject") h.flow.fillFields.mockRejectedValueOnce(new Error("Read failed"));
        if (outcome === "insert failure") h.insertText.mockReturnValueOnce(false);
        if (outcome === "reject") await expect(b.props.onClick()).rejects.toThrow("Read failed");
        else await b.props.onClick();
        const retry = h.render(); expect(retry.props.disabled).toBe(false);
        h.insertText.mockClear();
        await retry.props.onClick();
        expect(h.insertText).toHaveBeenCalledExactlyOnceWith("Answer");
    });
    it("keeps a reply through unrelated preference writes", async () => {
        const h = await harness(); const b = h.collect();
        h.store.setPreviewOpen(false);
        await b.props.onClick();
        expect(h.insertText).toHaveBeenCalledTimes(1);
    });
});
