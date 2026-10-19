import { describe, expect, it, vi } from "vitest";
import { bdRequire, loadAdapter } from "./betterdiscordHarness";

const { JSDOM } = bdRequire("jsdom");

function fixture() {
    const dom = new JSDOM('<div class="channelTextArea_test"><div tabindex="0" contenteditable="true" data-slate-editor="true"></div></div>');
    const editor = dom.window.document.querySelector('[data-slate-editor="true"]');
    const slate = { children: [{ children: [{ text: "draft" }] }], operations: [] as any[] };
    // The observed Discord composer contract: handleInsertText -> appendText ->
    // ref.current.insertText. Slate changes synchronously; React paints later.
    const handle = { getSlateEditor: () => slate, focus: vi.fn(() => editor.focus()), insertText: vi.fn((_plain: string, raw: string) => {
        slate.children[0].children[0].text += raw;
        slate.operations.push({ type: "insert_text", text: raw });
    }) };
    const owner = {
        props: { disabled: false, submitting: false }, ref: { current: handle },
        getSlateEditor() { return this.ref.current?.getSlateEditor(); },
        focus: vi.fn(() => editor.focus()),
        handleInsertText: vi.fn(function (this: any, payload: any) {
            if (!this.props.disabled) { this.ref.current?.insertText(payload.plainText, payload.rawText, payload.addSpace); this.focus(); }
        })
    };
    const dispatcher = { subscribe() {}, dispatchToLastSubscribed: vi.fn() }; // may return without delivery
    const fiber: any = { stateNode: editor, return: { stateNode: owner, return: null } };
    const host = {
        ReactUtils: { getInternalInstance: vi.fn((node: any) => node === editor ? fiber : null) },
        Webpack: { getModule: () => dispatcher }
    };
    const { insertTextIntoChatInputBox: insert } = loadAdapter("shims/discord.ts", {}, { document: dom.window.document, BdApi: host });
    editor.focus();
    return { editor, slate, owner, dispatcher, fiber, host, insert, dom };
}

describe("BetterDiscord targeted insertion", () => {
    it("delivers once to the focused composer's own handler, not the global last subscriber", () => {
        const f = fixture();
        f.insert("answer\n**bold**");
        expect(f.slate.children[0].children[0].text).toBe("draftanswer\n**bold**");
        expect(f.owner.handleInsertText).toHaveBeenCalledExactlyOnceWith({ plainText: "answer\n**bold**", rawText: "answer\n**bold**", addSpace: false });
        expect(f.dispatcher.dispatchToLastSubscribed).not.toHaveBeenCalled();
        expect(f.editor.textContent).toBe(""); // no DOM mutation masquerading as a Slate update
    });
    it("rejects a handler that silently leaves the draft unchanged", () => {
        const f = fixture(); f.owner.ref.current.insertText.mockImplementation(() => {});
        expect(() => f.insert("answer")).toThrow("did not change");
        expect(f.owner.handleInsertText).toHaveBeenCalledOnce();
        expect(f.dispatcher.dispatchToLastSubscribed).not.toHaveBeenCalled();
    });
    it("does not route to another composer when the focused editor has no owner", () => {
        const f = fixture(); f.fiber.return = null;
        expect(() => f.insert("answer")).toThrow("composer");
        expect(f.owner.handleInsertText).not.toHaveBeenCalled();
        expect(f.dispatcher.dispatchToLastSubscribed).not.toHaveBeenCalled();
    });
    it.each(["disabled", "submitting"] as const)("does not insert while %s", flag => {
        const f = fixture(); f.owner.props[flag] = true;
        expect(() => f.insert("answer")).toThrow("unavailable");
        expect(f.owner.handleInsertText).not.toHaveBeenCalled();
    });
    it("rejects disconnected editors and unrelated textboxes", () => {
        const f = fixture(); f.editor.remove();
        expect(() => f.insert("answer")).toThrow("No focused chat editor");
        f.dom.window.document.body.innerHTML = '<input id="search">'; f.dom.window.document.querySelector("input").focus();
        expect(() => f.insert("answer")).toThrow("No focused chat editor");
    });
    it("recognizes replacing a selection with identical text as a real insertion", () => {
        const f = fixture();
        f.owner.ref.current.insertText.mockImplementation((_plain, raw) => { f.slate.operations.push({ type: "remove_text", text: raw }, { type: "insert_text", text: raw }); });
        expect(() => f.insert("draft")).not.toThrow();
        expect(f.owner.handleInsertText).toHaveBeenCalledOnce();
    });
    it("does not offer a duplicate retry after a post-insertion focus error", () => {
        const f = fixture();
        f.owner.focus.mockImplementationOnce(() => { throw new Error("focus failed"); });
        expect(() => f.insert("answer")).not.toThrow();
        expect(f.slate.children[0].children[0].text).toBe("draftanswer");
        expect(f.owner.handleInsertText).toHaveBeenCalledOnce();
    });
    it("does not call a deletion followed by an exception successful insertion", () => {
        const f = fixture();
        f.owner.ref.current.insertText.mockImplementation(() => {
            f.slate.children[0].children[0].text = "";
            f.slate.operations.push({ type: "remove_text", text: "draft" });
            throw new Error("transform failed");
        });
        expect(() => f.insert("answer")).toThrow("insertion failed");
    });
    it("rejects an insertion rolled back before the handler returns", () => {
        const f = fixture();
        f.owner.ref.current.insertText.mockImplementation((_plain, raw) => {
            f.slate.operations.push({ type: "insert_text", text: raw }, { type: "remove_text", text: raw });
        });
        expect(() => f.insert("answer")).toThrow("did not change");
    });
    it("rejects a model or focus switch before delivery", () => {
        const f = fixture();
        f.owner.ref.current.focus.mockImplementation(() => { f.owner.getSlateEditor = () => ({ children: [], operations: [] }); });
        expect(() => f.insert("answer")).toThrow("changed");
        expect(f.owner.handleInsertText).not.toHaveBeenCalled();
    });
    it("does not verify an old model after the editor has been replaced", () => {
        const f = fixture();
        f.owner.handleInsertText.mockImplementation(() => {
            f.slate.children[0].children[0].text += "answer";
            f.slate.operations.push({ type: "insert_text", text: "answer" });
            f.owner.getSlateEditor = () => ({ children: [], operations: [] });
        });
        expect(() => f.insert("answer")).toThrow("changed");
    });
});
