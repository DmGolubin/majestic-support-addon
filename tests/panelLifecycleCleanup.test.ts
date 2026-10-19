import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const code = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/panel.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const EVENTS = ["flux:LOGOUT", "flux:CONNECTION_OPEN", "user", "window:online", "window:focus", "document:visibilitychange"];

function harness() {
    const listeners = new Map<string, Set<() => void>>();
    const fault = { add: "", remove: "", remaining: 0, afterRemove: false, resume: false };
    const startupError = new Error("original startup failure");
    const add = vi.fn((name: string, fn: () => void) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(fn);
        if (fault.add === name) throw startupError; // Deliberately throw AFTER attaching.
    });
    const remove = vi.fn((name: string, fn: () => void) => {
        const fail = fault.remove === name && fault.remaining-- > 0;
        if (fail && !fault.afterRemove) throw Error("host unsubscribe unavailable");
        listeners.get(name)?.delete(fn);
        if (fail) throw Error("host unsubscribe failed after removal");
    });
    const user = vi.fn(() => { if (fault.resume) throw startupError; return null; });
    const nextGeneration = vi.fn(), setFreshnessCheck = vi.fn(), errors = vi.fn();
    const observable = (initial: any) => {
        let value = initial;
        return { get: () => value, set: vi.fn((patch: any) => { value = { ...value, ...patch }; }) };
    };
    const deps: Record<string, any> = {
        "@webpack/common": {
            FluxDispatcher: { subscribe: (name: string, fn: () => void) => add("flux:" + name, fn), unsubscribe: (name: string, fn: () => void) => remove("flux:" + name, fn) },
            UserStore: { getCurrentUser: user, addChangeListener: (fn: () => void) => add("user", fn), removeChangeListener: (fn: () => void) => remove("user", fn) },
        },
        "../buildInfo": {}, "../core/panelCatalog": {}, "../core/panelClient": {},
        "../core/panelEvents": { createPanelEventStream: () => vi.fn() },
        "../core/panelPreferences": {}, "../core/panelProtocol": {}, "../core/panelTransport": {}, "../core/state": {},
        "../panelHtml": {}, "../panelPermission": {}, "../panelVault": {}, "../platform": {}, "./demo": {},
        "./flow": { confirmedForeign: new Set(), supersede: vi.fn() },
        "./observable": { createObservable: observable }, "./ticketReminders": { stopTicketReminders: vi.fn() },
        "./op": { nextGeneration },
        "./uiState": { panelAccess: observable({ ready: true }), ui: observable({}), setFreshnessCheck },
    };
    const api: any = {};
    const target = (prefix: string) => ({
        addEventListener: (name: string, fn: () => void) => add(prefix + name, fn),
        removeEventListener: (name: string, fn: () => void) => remove(prefix + name, fn),
    });
    runInNewContext(code, { exports: api, require: (id: string) => {
        if (!(id in deps)) throw Error("Unexpected import " + id);
        return deps[id];
    }, clearTimeout, console: { error: errors }, window: target("window:"), document: { ...target("document:"), visibilityState: "visible" } });
    return { api, listeners, fault, add, remove, user, errors, startupError, nextGeneration, setFreshnessCheck,
        count: () => [...listeners.values()].reduce((n, group) => n + group.size, 0) };
}

describe("panel subscriptions under host failures", () => {
    it.each([...EVENTS, "resume"])("rolls back failure at %s, including subscribe-then-throw, and preserves the original error", stage => {
        const h = harness();
        h.fault.add = stage; h.fault.resume = stage === "resume";
        for (let i = 0; i < 10; i++) {
            expect(() => h.api.startPanel()).toThrow(h.startupError);
            expect(h.count()).toBe(0);
            expect(h.api.panel.get().phase).toBe("idle");
        }
        h.fault.add = ""; h.fault.resume = false;
        const off = h.api.startPanel();
        expect(h.count()).toBe(6); off(); expect(h.count()).toBe(0);
    });

    it.each(EVENTS)("retries a transient removal of %s immediately, while cleaning every other resource", event => {
        const h = harness(); const off = h.api.startPanel();
        h.fault.remove = event; h.fault.remaining = 1;
        off();
        expect(h.count()).toBe(0);
        expect(h.remove.mock.calls.filter(([name]) => name === event)).toHaveLength(2);
        expect(new Set(h.remove.mock.calls.map(([name]) => name))).toEqual(new Set(EVENTS));
        const attempts = h.remove.mock.calls.length;
        off(); h.api.disposePanel(); expect(h.remove).toHaveBeenCalledTimes(attempts);
    });

    it("also tolerates unsubscribe-then-throw without replaying successful removals", () => {
        const h = harness(); const off = h.api.startPanel();
        h.fault.remove = "flux:LOGOUT"; h.fault.remaining = 1; h.fault.afterRemove = true;
        off(); expect(h.count()).toBe(0);
        expect(h.remove.mock.calls.filter(([name]) => name === "flux:LOGOUT")).toHaveLength(2);
        expect(h.remove.mock.calls.filter(([name]) => name === "flux:CONNECTION_OPEN")).toHaveLength(1);
    });

    it("keeps permanently unremovable callbacks inert and blocks accumulating generations until recovery", () => {
        const h = harness(); const off = h.api.startPanel();
        const stale = [...h.listeners.values()].flatMap(group => [...group]);
        h.fault.remove = "flux:CONNECTION_OPEN"; h.fault.remaining = Infinity;
        off(); expect(h.count()).toBe(1);
        expect(h.remove.mock.calls.filter(([name]) => name === h.fault.remove)).toHaveLength(2);
        const reads = h.user.mock.calls.length, generations = h.nextGeneration.mock.calls.length;
        stale.forEach(fn => fn());
        expect(h.user).toHaveBeenCalledTimes(reads); expect(h.nextGeneration).toHaveBeenCalledTimes(generations);
        for (let i = 0; i < 5; i++) {
            expect(() => h.api.startPanel()).toThrow("could not be released");
            expect(h.count()).toBe(1); expect(h.add).toHaveBeenCalledTimes(6);
        }
        expect(h.errors).toHaveBeenCalled();
        h.fault.remaining = 0;
        const nextOff = h.api.startPanel(); expect(h.count()).toBe(6);
        off(); expect(h.count()).toBe(6); // A retired cleanup cannot remove the new generation.
        nextOff(); expect(h.count()).toBe(0);
    });

    it("does not mask startup failure when rollback removal also fails; dispose can retry later", () => {
        const h = harness();
        h.fault.add = "window:focus"; h.fault.remove = "flux:LOGOUT"; h.fault.remaining = Infinity;
        expect(() => h.api.startPanel()).toThrow(h.startupError);
        expect(h.count()).toBe(1); expect(h.errors).toHaveBeenCalled();
        h.fault.remaining = 0; h.api.disposePanel(); expect(h.count()).toBe(0);
    });

    it("detaches before invoking host removal, so reentrant disposal does not remove twice", () => {
        const h = harness(); const off = h.api.startPanel();
        const original = h.remove.getMockImplementation()!;
        h.remove.mockImplementation((name, fn) => { if (name === "flux:LOGOUT") h.api.disposePanel(); original(name, fn); });
        off(); expect(h.count()).toBe(0);
        expect(h.remove.mock.calls.filter(([name]) => name === "flux:LOGOUT")).toHaveLength(1);
    });
});
