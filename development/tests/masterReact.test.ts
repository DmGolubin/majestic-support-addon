import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Actual TSX, isolated hook lifecycle model; no React renderer/Discord/network.
const code = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/LocalStorageNotice.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
}).outputText;
function fixture() {
    const listeners = new Set<() => void>();
    const store = { loadError: true, load: vi.fn(() => Promise.resolve()), subscribe(fn: () => void) {
        listeners.add(fn); return () => { listeners.delete(fn); };
    } };
    let current: any, cursor = 0;
    const hooks = {
        useState(initial: any) {
            const owner = current, i = cursor++;
            if (!(i in owner.slots)) owner.slots[i] = initial;
            return [owner.slots[i], (value: any) => {
                if (owner.live) owner.slots[i] = value;
                else owner.late++;
            }];
        },
        useEffect(fn: () => any) { const i = cursor++; if (!(i in current.slots)) { current.slots[i] = true; current.pending.push(fn); } }
    };
    const exports: any = {};
    runInNewContext(code, { exports, React: { createElement: (type: any, props: any, ...children: any[]) => ({ type, props, children }) },
        require: (id: string) => {
            if (id === "@webpack/common") return hooks;
            if (id === "./uiState") return { realStore: store };
            throw Error(id);
        } });
    const mount = () => {
        const owner = { slots: [] as any[], pending: [] as any[], cleanups: [] as any[], live: true, late: 0 };
        const render = () => { current = owner; cursor = 0; return exports.LocalStorageNotice(); };
        const commit = () => owner.pending.splice(0).forEach(fn => owner.cleanups.push(fn()));
        const unmount = () => { owner.live = false; owner.cleanups.splice(0).forEach(fn => fn?.()); };
        return { owner, render, commit, unmount };
    };
    return { store, listeners, mount };
}
const drain = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe("Master Role08 LocalStorageNotice lifecycle", () => {
    it("catches a store change between render and subscription, and detaches on every remount", () => {
        const f = fixture();
        for (let i = 0; i < 3; i++) {
            f.store.loadError = true;
            const m = f.mount(); m.render();
            f.store.loadError = false; m.commit();
            expect(m.render()).toBeNull(); expect(f.listeners.size).toBe(1);
            m.unmount(); expect(f.listeners.size).toBe(0);
        }
    });
    it("updates the mounted notice after a failed/recovered storage notification", () => {
        const f = fixture(), m = f.mount(); m.render(); m.commit();
        expect(m.render()).not.toBeNull();
        f.store.loadError = false; f.listeners.forEach(fn => fn());
        expect(m.render()).toBeNull();
        f.store.loadError = true; f.listeners.forEach(fn => fn());
        expect(m.render()).not.toBeNull(); m.unmount();
    });
    it("late retry settlement reaches only the old setter, not a remounted notice", async () => {
        const f = fixture(); let reject!: (e: Error) => void;
        f.store.load.mockImplementation(() => new Promise<void>((_, no) => { reject = no; }));
        const old = f.mount(); const tree = old.render(); old.commit();
        tree.children[1].children[0].props.onClick();
        expect(old.owner.slots[1]).toBe(true);
        old.unmount(); const next = f.mount(); next.render(); next.commit();
        reject(Error("synthetic read failure")); await drain();
        expect(old.owner.late).toBe(1);
        expect(next.owner.slots[1]).toBe(false); expect(next.owner.late).toBe(0);
        expect(f.listeners.size).toBe(1); next.unmount(); expect(f.listeners.size).toBe(0);
    });
});
