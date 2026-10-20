import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as guard from "../src/core/guard";
import * as text from "../src/core/text";
import * as tokens from "../src/core/tokens";
import * as types from "../src/core/types";

const code = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/flow.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
};
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function harness() {
    const clipboard = deferred<string>(), reading = deferred<void>(), freshness = deferred<boolean>();
    const templates = ["{{clipboard}}", "Latest: {{reason}}"].map((body, i) => ({
        id: `q18-ui-${i}`, title: `Answer ${i}`, text: body, project: "mj", source: "local", status: "actual", statusNote: null,
    }));
    const state: any = { dialog: null, windowOpen: false, management: false, menu: null };
    const editor = { isConnected: true, textContent: "Original draft", focus: vi.fn(), closest: () => null };
    const insert = vi.fn((value: string) => { editor.textContent += value; return true; });
    const markUsed = vi.fn(), ensureFresh = vi.fn(() => freshness.promise);
    let fresh = true;
    const ui = { get: () => state, set: (patch: any) => Object.assign(state, patch) };
    const store = { setVersion: 1, templates, byId: (id: string) => templates.find(t => t.id === id),
        isIntentional: () => false, markIntentional: vi.fn(), markUsed };
    const deps: Record<string, unknown> = {
        "../core/guard": guard, "../core/text": text, "../core/tokens": tokens, "../core/types": types,
        "../platform": { activeEditor: () => editor, currentChannel: () => ({ id: "channel", guildId: "guild", name: "chat" }),
            insertText: insert, toast: vi.fn(), readClipboard: () => { reading.resolve(); return clipboard.promise; } },
        "./debug": { debugEnabled: () => false, dlog() {} },
        "./op": { generationNow: () => 1, targetNow: () => ({ editor, selection: "" }), rememberComposeTarget() {} },
        "./uiState": { ui, store, activeScope: () => "mj", currentMode: () => "mj", libraryIsFresh: () => fresh, ensureLibraryFresh: ensureFresh },
    };
    const exports: any = {};
    runInNewContext(code, { exports, document: { activeElement: editor, body: {} }, require: (id: string) => {
        if (!(id in deps)) throw new Error("Unexpected dependency " + id);
        return deps[id];
    } });
    return { exports, clipboard, reading, freshness, ensureFresh, setFresh: (value: boolean) => { fresh = value; },
        templates, state, editor, insert, markUsed };
}

describe("Q18 UI insertion intent supersession", () => {
    it.each(["pending", "cancelled"])("an older clipboard read cannot write after a newer %s field prompt", async outcome => {
        const h = harness();
        const old = h.exports.insertTemplate(h.templates[0]);
        await h.reading.promise;
        const latest = h.exports.insertTemplate(h.templates[1]);
        await settle();
        const dialog = h.state.dialog;
        expect(dialog.kind).toBe("fields");
        if (outcome === "cancelled") { dialog.resolve(null); await latest; }
        h.clipboard.resolve("Old clipboard answer"); await old;
        expect(h.insert).not.toHaveBeenCalled();
        expect(h.markUsed).not.toHaveBeenCalled();
        expect(h.editor.textContent).toBe("Original draft");
        if (outcome === "pending") {
            expect(h.state.dialog).toBe(dialog);
            dialog.resolve({ reason: "new reason" }); await latest;
            expect(h.insert).toHaveBeenCalledExactlyOnceWith("Latest: new reason");
        }
    });

    it("does not open old fields when a superseded freshness check settles", async () => {
        const h = harness();
        h.templates[0].text = "Old: {{old field}}";
        h.setFresh(false);
        const old = h.exports.insertTemplate(h.templates[0]);
        expect(h.ensureFresh).toHaveBeenCalledOnce();
        h.setFresh(true);
        const latest = h.exports.insertTemplate(h.templates[1]);
        await settle();
        const dialog = h.state.dialog;
        expect(dialog.title).toBe("Answer 1");
        h.freshness.resolve(true); await settle();
        expect(h.state.dialog).toBe(dialog);
        dialog.resolve({ reason: "current" });
        await Promise.all([old, latest]);
        expect(h.insert).toHaveBeenCalledExactlyOnceWith("Latest: current");
    });

    it("does not continue an old foreign-template warning into a status dialog after a newer intent", async () => {
        const h = harness();
        Object.assign(h.templates[0], { project: "ro", status: "outdated", text: "Old answer" });
        const old = h.exports.insertTemplate(h.templates[0]);
        await settle();
        expect(h.state.dialog.kind).toBe("confirm");
        h.state.dialog.resolve({ ok: true, checked: false });
        h.setFresh(false);
        const latest = h.exports.insertTemplate(h.templates[1]);
        await settle();
        expect(h.state.dialog).toBeNull();
        h.setFresh(true); h.freshness.resolve(true); await settle();
        expect(h.state.dialog.title).toBe("Answer 1");
        h.state.dialog.resolve({ reason: "current" });
        await Promise.all([old, latest]);
        expect(h.insert).toHaveBeenCalledExactlyOnceWith("Latest: current");
    });
});
