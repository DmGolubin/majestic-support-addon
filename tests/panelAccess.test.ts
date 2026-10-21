import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

function functions(file: string, names: string[], context: object) {
    const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const picked = source.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && !!s.name && names.includes(s.name.text));
    const js = ts.transpileModule(picked.map(f => f.getText(source)).join("\n"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    return runInNewContext(js + `\n({${names.join(",")}})`, { exports: {}, ...context });
}

describe("panel access gates from actual adapter functions", () => {
    it("requires a fresh check, same Discord account and allowed server", () => {
        const p = { enabled: true, ready: true, accountId: "123", projects: ["mj"], checkedAt: 10000 };
        let now = 10000, mode = "mj", id = "123";
        const gates = functions("../src/vencord/ui/uiState.ts", ["libraryIsFresh", "activeScope"], {
            Date: { now: () => now }, panelAccess: { get: () => p }, demoAccess: { get: () => ({ enabled: false }) },
            UserStore: { getCurrentUser: () => ({ id }) }, currentMode: () => mode
        });
        expect(gates.libraryIsFresh()).toBe(true); expect(gates.activeScope()).toBe("mj");
        mode = "ro"; expect(gates.activeScope()).toBeNull();
        mode = "all"; expect(gates.activeScope()).toBe("all");
        now = 40001; expect(gates.libraryIsFresh()).toBe(false);
        now = 9999; expect(gates.libraryIsFresh()).toBe(false);
        now = 10000; id = "456"; expect(gates.libraryIsFresh()).toBe(false); expect(gates.activeScope()).toBeNull();
        id = "123"; p.ready = false; expect(gates.libraryIsFresh()).toBe(false);
        p.enabled = false; mode = "mj"; expect(gates.libraryIsFresh()).toBe(true); expect(gates.activeScope()).toBe("mj");
        mode = "off"; expect(gates.activeScope()).toBeNull();
    });

    it.each(["before", "after fields", "changed snapshot"])("cancels preparation on failed freshness %s", async at => {
        const template = { id: "faq:7", title: "FAQ", text: "{{field}}" };
        const store = { setVersion: 1, byId: () => template };
        let fresh = at !== "before";
        const ensure = vi.fn(async () => { if (at === "changed snapshot") { fresh = true; store.setVersion++; return true; } return false; });
        const fillFields = vi.fn(async () => { fresh = false; return "Filled answer"; });
        const api = functions("../src/vencord/ui/flow.ts", ["snapNow", "stillCurrent", "scopeHere", "prepareText"], {
            preparationSequence: 0, dialogSequence: 0,
            store, currentChannel: () => ({ id: "channel" }), activeScope: () => "mj", currentMode: () => "mj",
            generationNow: () => 1, libraryIsFresh: () => fresh, ensureLibraryFresh: ensure,
            dlog: vi.fn(), toast: vi.fn(), guard: async (t: unknown) => t, stripMarker: (s: string) => s, fillFields
        });
        expect(await api.prepareText(template, { editor: null, selection: "" })).toBeNull();
        expect(ensure).toHaveBeenCalledOnce();
        if (at === "before") expect(fillFields).not.toHaveBeenCalled();
    });
    it("rejects stale objects before running insertion guards", async () => {
        const old = { id: "faq:7", text: "Old answer" };
        const guard = vi.fn();
        const api = functions("../src/vencord/ui/flow.ts", ["prepareText"], {
            preparationSequence: 0, dialogSequence: 0,
            store: { byId: () => ({ ...old, text: "New answer" }) }, guard
        });
        expect(await api.prepareText(old, { editor: null, selection: "" })).toBeNull();
        expect(guard).not.toHaveBeenCalled();
    });
});
