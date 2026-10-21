import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the real observable with render and passive-effect subscription kept separate.
const code = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/observable.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness() {
    const force = vi.fn();
    let effect: (() => () => void) | undefined;
    const exports: any = {};
    runInNewContext(code, {
        exports,
        require: (id: string) => {
            if (id !== "@webpack/common") throw new Error(`Unexpected import: ${id}`);
            return {
                useState: () => [0, force],
                useEffect: (fn: () => () => void) => { effect ??= fn; },
            };
        },
    });
    const observable = exports.createObservable({ loaded: false, volume: 30 }) as {
        use(): { loaded: boolean; volume: number; };
        set(patch: { loaded?: boolean; volume?: number; }): void;
    };
    return { observable, force, commit: () => effect!() };
}

describe("observable.use subscription lifecycle", () => {
    it("requests a render when loading finishes between render and subscription", () => {
        const { observable, force, commit } = harness();
        expect(observable.use()).toEqual({ loaded: false, volume: 30 });
        observable.set({ loaded: true, volume: 60 });
        expect(force).not.toHaveBeenCalled();

        commit();

        expect(force).toHaveBeenCalledTimes(1);
        expect(observable.use()).toEqual({ loaded: true, volume: 60 });
    });

    it("does not request an extra render when the initial snapshot is unchanged", () => {
        const { observable, force, commit } = harness();
        observable.use();
        commit();
        expect(force).not.toHaveBeenCalled();
    });

    it("keeps notifying subsequent changes and unsubscribes on cleanup", () => {
        const { observable, force, commit } = harness();
        observable.use();
        const cleanup = commit();
        observable.set({ loaded: true });
        observable.set({ volume: 60 });
        expect(force).toHaveBeenCalledTimes(2);

        cleanup();
        observable.set({ volume: 90 });
        expect(force).toHaveBeenCalledTimes(2);
    });
});
