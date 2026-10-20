import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the actual entrypoint with a controllable Electron lifecycle. No client,
// network, native plugin or filesystem writes are involved.
const source = ts.transpileModule(
    readFileSync(new URL("../standalone/runtime/main.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText;

function harness(vanilla = false, nativeFailure = false) {
    const events: string[] = [];
    let ready = false, resolveReady!: () => void;
    const readiness = new Promise<void>(resolve => { resolveReady = resolve; });
    const app = Object.assign(new EventEmitter(), { isReady: () => ready, whenReady: () => readiness });
    // A pending updater must never delay the native bootstrap.
    const update = vi.fn(() => new Promise<void>(() => {}));
    const emit = app.emit;
    const execute = () => runInNewContext(source, { exports: {}, require(name: string) {
        if (name === "./ipc") { events.push("ipc"); return {}; }
        if (name === "electron") return { app };
        if (name === "@main/csp") return { initCsp: () => events.push("csp") };
        if (name === "@main/utils/constants") return { IS_VANILLA: vanilla };
        if (name === "./update") return { startAutoUpdate: update };
        if (name === "../main/patcher") {
            events.push("native");
            if (app.isReady()) throw Error("Native startup was delayed past ready");
            app.on("will-finish-launching", () => events.push("will-finish-launching"));
            app.on("ready", () => events.push("ready"));
            if (nativeFailure) throw Error("Partial native startup");
            return {};
        }
        throw Error("Unexpected module: " + name);
    } });
    const finishLaunch = () => {
        app.emit("will-finish-launching");
        ready = true;
        app.emit("ready");
        resolveReady();
    };
    return { events, app, emit, update, execute, finishLaunch };
}

describe("Lite native startup ordering", () => {
    it("loads IPC and native on the bootstrap stack, then starts updates after real ready events", async () => {
        const h = harness();
        h.execute();
        expect(h.events).toEqual(["ipc", "native"]);
        expect(h.update).not.toHaveBeenCalled();
        expect(h.app.emit).toBe(h.emit);
        h.finishLaunch();
        expect(h.events).toEqual(["ipc", "native", "will-finish-launching", "ready"]);
        await Promise.resolve();
        expect(h.events).toEqual(["ipc", "native", "will-finish-launching", "ready", "csp"]);
        expect(h.update).toHaveBeenCalledTimes(1);
        expect(h.app.emit).toBe(h.emit);
    });
    it("does not start the updater or CSP hooks in vanilla mode", async () => {
        const h = harness(true);
        h.execute();
        expect(h.events).toEqual(["ipc", "native"]);
        h.finishLaunch();
        await Promise.resolve();
        expect(h.events).toEqual(["ipc", "native", "will-finish-launching", "ready"]);
        expect(h.update).not.toHaveBeenCalled();
    });
    it("propagates a partial native failure synchronously without a second bootstrap", () => {
        const h = harness(false, true);
        expect(h.execute).toThrow("Partial native startup");
        expect(h.events).toEqual(["ipc", "native"]);
        expect(h.update).not.toHaveBeenCalled();
    });
});
