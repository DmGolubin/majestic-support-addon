import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as guard from "../src/core/guard";
import * as text from "../src/core/text";
import * as tokens from "../src/core/tokens";
import * as types from "../src/core/types";

// Real flow and core transformations; platform/storage/UI are isolated from Discord and the network.
const code = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/flow.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
};

function harness(body = "{{clipboard}}") {
    const clipboard = deferred<string>();
    const clipboardStarted = deferred<void>();
    const freshness = deferred<boolean>();
    const freshnessStarted = deferred<void>();
    const dialogOpened = deferred<any>();
    const context = { channel: "A", generation: 1, fresh: true, focused: "editor", scope: "mj" as string | null };
    const editor = {
        isConnected: true, textContent: "Original draft",
        focus: vi.fn(() => { context.focused = "editor"; }),
    };
    const bodyElement = {};
    const closingDialogInput = { closest: (selector: string) => selector === ".vc-stx-dialog" ? {} : null };
    const otherInput = { closest: () => null };
    const document = {
        body: bodyElement,
        get activeElement() {
            return context.focused === "body" ? bodyElement : context.focused === "dialog" ? closingDialogInput
                : context.focused === "editor" ? editor : otherInput;
        },
    };
    const template: types.Template = {
        id: "t", title: "Answer", text: body, project: "mj", source: "faq", status: "actual",
        category: null, statusNote: null, teamUses: 0, command: null, color: null, updatedAt: null,
    };
    const store = { setVersion: 1, templates: [template], byId: (id: string) => id === template.id ? template : undefined, markUsed: vi.fn() };
    let state: any = { windowOpen: false, menu: null, dialog: null };
    const ui = {
        get: () => state,
        set: (patch: any) => {
            state = { ...state, ...patch };
            if (patch.dialog) {
                context.focused = "dialog";
                dialogOpened.resolve(patch.dialog);
            }
        },
    };
    const insertText = vi.fn(() => true);
    const toast = vi.fn();
    const dlog = vi.fn();
    const dependencies: Record<string, unknown> = {
        "../core/guard": guard, "../core/text": text, "../core/tokens": tokens, "../core/types": types,
        "../platform": {
            activeEditor: () => editor,
            currentChannel: () => ({ id: context.channel, name: context.channel, guildId: types.PROJECTS.mj.guildId }),
            insertText, toast,
            readClipboard: () => { clipboardStarted.resolve(); return clipboard.promise; },
        },
        "./debug": { debugEnabled: () => false, dlog },
        "./op": {
            generationNow: () => context.generation, targetNow: () => ({ editor, selection: "" }),
        },
        "./uiState": {
            store, ui, activeScope: () => context.scope, currentMode: () => "mj",
            libraryIsFresh: () => context.fresh,
            ensureLibraryFresh: async () => {
                freshnessStarted.resolve();
                context.fresh = await freshness.promise;
                return context.fresh;
            },
        },
    };
    const module = { exports: {} as {
        insertTemplate(t: types.Template): Promise<void>;
        confirm(args: Record<string, string>): Promise<unknown>;
        supersede(): void;
    } };
    runInNewContext(code, {
        module, exports: module.exports, document,
        require: (name: string) => {
            if (!(name in dependencies)) throw Error("Unmocked dependency: " + name);
            return dependencies[name];
        },
    });
    return { context, editor, template, store, ui, insertText, toast, dlog, clipboard, clipboardStarted,
        freshness, freshnessStarted, dialogOpened, insert: () => module.exports.insertTemplate(template),
        supersede: module.exports.supersede,
        confirm: () => module.exports.confirm({ tone: "warn", label: "Replacement", title: "Replacement", body: "Confirm", ok: "OK" }) };
}

describe("actual template flow draft cancellation", () => {
    for (const wait of ["clipboard", "initial freshness", "final freshness"] as const) {
        it.each([false, true])(`${wait}: draft changed=%s`, async changed => {
            const h = harness(wait === "initial freshness" ? "Answer" : "{{clipboard}}");
            if (wait === "initial freshness") h.context.fresh = false;
            const pending = h.insert();
            if (wait !== "initial freshness") await h.clipboardStarted.promise;
            if (wait === "final freshness") {
                h.context.fresh = false;
                h.clipboard.resolve("Answer");
            }
            if (wait !== "clipboard") await h.freshnessStarted.promise;
            if (changed) h.editor.textContent = "New draft typed while waiting";
            if (wait === "clipboard") h.clipboard.resolve("Answer");
            else h.freshness.resolve(true);
            await pending;
            if (changed) {
                expect(h.insertText).not.toHaveBeenCalled();
                expect(h.store.markUsed).not.toHaveBeenCalled();
                expect(h.editor.focus).not.toHaveBeenCalled();
                expect(h.toast).toHaveBeenCalledExactlyOnceWith("Черновик изменился — выберите шаблон снова", "message");
                expect(JSON.stringify(h.dlog.mock.calls)).not.toContain(h.editor.textContent);
            } else {
                expect(h.insertText).toHaveBeenCalledExactlyOnceWith("Answer");
                expect(h.store.markUsed).toHaveBeenCalledExactlyOnceWith("t");
            }
        });
    }

    for (const kind of ["fields", "confirm"] as const) {
        it.each([false, true])(`${kind} focus handoff: draft changed=%s`, async changed => {
            const h = harness(kind === "fields" ? "Hello {{name}}" : "Answer");
            if (kind === "confirm") h.template.status = "outdated";
            const pending = h.insert();
            const dialog = await h.dialogOpened.promise;
            expect(dialog.kind).toBe(kind);
            expect(h.context.focused).toBe("dialog");
            if (changed) h.editor.textContent = "Changed draft";
            dialog.resolve(kind === "fields" ? { name: "Player" } : { ok: true, checked: false });
            await pending;
            expect(h.ui.get().dialog).toBeNull();
            if (changed) {
                expect(h.insertText).not.toHaveBeenCalled();
                expect(h.editor.focus).not.toHaveBeenCalled();
            } else {
                expect(h.context.focused).toBe("editor");
                expect(h.insertText).toHaveBeenCalledExactlyOnceWith(kind === "fields" ? "Hello Player" : "Answer");
            }
        });
    }

    it.each(["channel", "stop", "disconnect"])("still cancels %s during clipboard preparation", async change => {
        const h = harness();
        const pending = h.insert();
        await h.clipboardStarted.promise;
        if (change === "channel") h.context.channel = "B";
        if (change === "stop") h.context.generation++;
        if (change === "disconnect") h.editor.isConnected = false;
        h.clipboard.resolve("Answer");
        await pending;
        expect(h.insertText).not.toHaveBeenCalled();
        expect(h.store.markUsed).not.toHaveBeenCalled();
    });
});

describe("actual template flow cancellation focus", () => {
    for (const kind of ["fields", "confirm"] as const) {
        it.each(["body", "dialog"])(`${kind} cancellation restores focus from %s`, async focused => {
            const h = harness(kind === "fields" ? "Hello {{name}}" : "Answer");
            if (kind === "confirm") h.template.status = "outdated";
            const pending = h.insert();
            const dialog = await h.dialogOpened.promise;
            h.context.focused = focused;
            dialog.resolve(kind === "fields" ? null : { ok: false, checked: false });
            await pending;
            expect(h.editor.focus).toHaveBeenCalledTimes(1);
            expect(h.context.focused).toBe("editor");
            expect(h.insertText).not.toHaveBeenCalled();
            expect(h.store.markUsed).not.toHaveBeenCalled();
        });
    }

    it.each(["other input", "management", "window", "channel", "scope", "stop", "disconnect"])(
        "does not restore focus after %s changes", async change => {
            const h = harness("Hello {{name}}");
            const pending = h.insert();
            const dialog = await h.dialogOpened.promise;
            h.context.focused = "body";
            if (change === "other input") h.context.focused = "other input";
            if (change === "management") h.ui.set({ management: true });
            if (change === "window") h.ui.set({ windowOpen: true });
            if (change === "channel") h.context.channel = "B";
            if (change === "scope") h.context.scope = null;
            if (change === "stop") h.context.generation++;
            if (change === "disconnect") h.editor.isConnected = false;
            dialog.resolve(null);
            await pending;
            expect(h.editor.focus).not.toHaveBeenCalled();
            expect(h.insertText).not.toHaveBeenCalled();
        },
    );

    it.each([false, true])("does not steal focus from a superseding dialog (already closed=%s)", async closed => {
        const h = harness("Hello {{name}}");
        const pending = h.insert();
        await h.dialogOpened.promise;
        const replacement = h.confirm();
        const dialog = h.ui.get().dialog;
        if (closed) {
            dialog.resolve({ ok: false, checked: false });
            h.context.focused = "body";
        }
        await pending;
        expect(h.editor.focus).not.toHaveBeenCalled();
        expect(h.insertText).not.toHaveBeenCalled();
        if (!closed) dialog.resolve({ ok: false, checked: false });
        await replacement;
    });

    it("does not restore a cancelled operation after a newer dialog opens and closes", async () => {
        const h = harness("Hello {{name}}");
        const pending = h.insert();
        const dialog = await h.dialogOpened.promise;
        dialog.resolve(null);
        const replacement = h.confirm();
        h.ui.get().dialog.resolve({ ok: false, checked: false });
        h.context.focused = "body";
        await Promise.all([pending, replacement]);
        expect(h.editor.focus).not.toHaveBeenCalled();
    });

    it("does not restore a superseded dialog even without a replacement", async () => {
        const h = harness("Hello {{name}}");
        const pending = h.insert();
        await h.dialogOpened.promise;
        h.supersede();
        h.context.focused = "body";
        await pending;
        expect(h.editor.focus).not.toHaveBeenCalled();
    });

    it("does not restore the old cancellation while a newer insertion is preparing", async () => {
        const h = harness("Hello {{name}}");
        const pending = h.insert();
        const dialog = await h.dialogOpened.promise;
        dialog.resolve(null);
        h.context.focused = "body";
        h.template.text = "{{clipboard}}";
        const newer = h.insert();
        await pending;
        await h.clipboardStarted.promise;
        expect(h.editor.focus).not.toHaveBeenCalled();
        h.clipboard.resolve("New answer");
        await newer;
        expect(h.editor.focus).toHaveBeenCalledTimes(1);
        expect(h.insertText).toHaveBeenCalledExactlyOnceWith("New answer");
    });
});
