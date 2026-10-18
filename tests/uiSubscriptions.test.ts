import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/core/state";
import { routeStore } from "../src/core/storeRouter";

type Hook = "useTechProject" | "useStore";
const names: Hook[] = ["useTechProject", "useStore"];
// Execute the actual hooks, with real store routing and separately controlled passive effects.
const source = ts.createSourceFile("uiState.ts", readFileSync(new URL("../src/vencord/ui/uiState.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const functions = source.statements.filter((n): n is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(n) && !!n.name && names.includes(n.name.text as Hook));
const code = ts.transpileModule(functions.map(n => n.getText(source)).join("\n"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const memoryStore = () => new Store({ get: async () => undefined, set: async () => {} });

function harness(name: Hook) {
    const router = routeStore(memoryStore());
    const subscriptions = new Set<() => void>();
    let state: unknown, initialized = false, effect: (() => () => void) | undefined;
    const update = vi.fn((next: unknown) => {
        const value = typeof next === "function" ? next(state) : next;
        if (!Object.is(state, value)) { state = value; rerender(); }
    });
    const rerender = vi.fn();
    const exports = {} as Record<Hook, () => unknown>;
    runInNewContext(code, {
        exports,
        store: {
            get data() { return router.store.data; },
            subscribe(fn: () => void) {
                subscriptions.add(fn);
                const off = router.store.subscribe(fn);
                return () => { subscriptions.delete(fn); off(); };
            },
        },
        useState(initial: unknown) {
            if (!initialized) { state = initial; initialized = true; }
            return [state, update];
        },
        useEffect(fn: () => () => void) { effect ??= fn; },
    });
    return {
        ...router, subscriptions, update, rerender,
        render: () => exports[name](),
        commit: () => effect!(),
    };
}

describe("uiState store subscription lifecycle", () => {
    it.each(["update", "replacement"])("catches a Tech project %s between render and effect", change => {
        const h = harness("useTechProject");
        expect(h.render()).toBe("mj");
        if (change === "update") h.store.setTechProject("ro");
        else {
            const next = memoryStore(); next.setTechProject("ro"); h.select(next);
        }
        expect(h.rerender).not.toHaveBeenCalled();
        const off = h.commit();
        expect(h.rerender).toHaveBeenCalled();
        expect(h.render()).toBe("ro");
        off();
    });

    it.each(["update", "replacement"])("invalidates a store consumer after a missed %s", change => {
        const h = harness("useStore");
        const version = h.render();
        const initialPrefix = h.store.data.prefix;
        if (change === "update") h.store.setPrefix("!");
        else {
            const next = memoryStore(); next.setPrefix("!"); h.select(next);
        }
        expect(h.rerender).not.toHaveBeenCalled();
        const off = h.commit();
        expect(h.rerender).toHaveBeenCalled();
        expect(h.render()).not.toBe(version);
        expect(h.store.data.prefix).toBe("!");
        expect(h.store.data.prefix).not.toBe(initialPrefix);
        off();
    });

    it("keeps an unchanged Tech project from requesting a render", () => {
        const h = harness("useTechProject");
        h.render(); const off = h.commit();
        h.store.setPrefix("!");
        expect(h.rerender).not.toHaveBeenCalled();
        expect(h.render()).toBe("mj");
        off();
    });

    it.each(names)("%s observes later changes and unsubscribes on cleanup", name => {
        const h = harness(name);
        h.render(); const off = h.commit(); h.render();
        h.update.mockClear(); h.rerender.mockClear();
        h.store.setTechProject("ro");
        expect(h.rerender).toHaveBeenCalledTimes(1);
        if (name === "useTechProject") expect(h.render()).toBe("ro");
        const next = memoryStore(); h.select(next);
        expect(h.rerender).toHaveBeenCalledTimes(2);
        expect(h.subscriptions.size).toBe(1);
        off();
        expect(h.subscriptions.size).toBe(0);
        h.update.mockClear();
        next.setTechProject("ro"); h.select(memoryStore());
        expect(h.update).not.toHaveBeenCalled();
    });

    it.each(names)("%s safely replays effect setup after cleanup", name => {
        const h = harness(name);
        h.render(); h.commit()();
        h.store.setTechProject("ro");
        h.rerender.mockClear();
        const off = h.commit();
        expect(h.subscriptions.size).toBe(1);
        expect(h.rerender).toHaveBeenCalledTimes(1);
        if (name === "useTechProject") expect(h.render()).toBe("ro");
        h.rerender.mockClear(); h.store.setTechProject("mj");
        expect(h.rerender).toHaveBeenCalledTimes(1);
        off(); expect(h.subscriptions.size).toBe(0);
    });
});
