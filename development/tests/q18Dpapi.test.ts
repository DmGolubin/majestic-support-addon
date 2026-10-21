import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFile as realExecFile } from "node:child_process";
import { loadAdapter } from "./betterdiscordHarness";

const failure = "Protected panel storage operation failed.";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function controlled() {
    const calls: any[] = [];
    const execFile = vi.fn((file, args, options, callback) => {
        const stdin = Object.assign(new EventEmitter(), { end: vi.fn((input: string) => { call.request = JSON.parse(input); }) });
        const call = { file, args, options, callback, stdin, request: undefined as any, kill: vi.fn() };
        calls.push(call);
        return { stdin, kill: call.kill };
    });
    const sync = vi.fn(() => { throw new Error("Synchronous child forbidden"); });
    const { createDpapiCrypto, DPAPI_SCRIPT } = loadAdapter("native/dpapi.ts", { "node:child_process": { execFile, spawnSync: sync } });
    return { crypto: createDpapiCrypto({ platform: "win32" }), calls, execFile, sync, DPAPI_SCRIPT };
}
const complete = (call: any, output = "ciphertext") => call.callback(null, Buffer.from(output).toString("base64"), "");

describe("q18 DPAPI asynchronous process boundary", () => {
    it("initializes once with a real roundtrip probe and keeps availability synchronous and cached", async () => {
        const h = controlled();
        expect(h.crypto.isEncryptionAvailable()).toBe(false);
        expect(h.execFile).not.toHaveBeenCalled();
        const first = h.crypto.initialize(), second = h.crypto.initialize();
        expect(first).toBe(second);
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].request.operation).toBe("probe");
        expect(h.crypto.isEncryptionAvailable()).toBe(false);
        h.calls[0].callback(null, h.calls[0].request.data, "");
        expect(await first).toBe(true);
        expect(await second).toBe(true);
        expect(await h.crypto.initialize()).toBe(true);
        expect(h.crypto.isEncryptionAvailable()).toBe(true);
        expect(h.execFile).toHaveBeenCalledOnce();
        expect(h.sync).not.toHaveBeenCalled();
    });
    it.each(["mismatch", "error"])("caches failed probe (%s) without exposing process details or retry storms", async mode => {
        const h = controlled();
        const pending = h.crypto.initialize();
        if (mode === "error") h.calls[0].callback(new Error("private diagnostic"), "private output", "private stderr");
        else complete(h.calls[0], "wrong probe");
        expect(await pending).toBe(false);
        expect(await h.crypto.initialize()).toBe(false);
        expect(h.crypto.isEncryptionAvailable()).toBe(false);
        expect(h.calls).toHaveLength(1);
    });
    it("does not launch a child on unsupported platforms", async () => {
        const execFile = vi.fn();
        const { createDpapiCrypto } = loadAdapter("native/dpapi.ts", { "node:child_process": { execFile } });
        const crypto = createDpapiCrypto({ platform: "linux" });
        expect(await crypto.initialize()).toBe(false);
        expect(crypto.isEncryptionAvailable()).toBe(false);
        expect(execFile).not.toHaveBeenCalled();
    });
    it("keeps timers running during a pending child and sends secret bytes only to stdin", async () => {
        const h = controlled();
        let settled = false, beats = 0;
        const timer = setInterval(() => beats++, 5);
        try {
            const pending = h.crypto.encryptString("q18 synthetic secret").finally(() => { settled = true; });
            await delay(35);
            expect(beats).toBeGreaterThan(0);
            expect(settled).toBe(false);
            const call = h.calls[0];
            expect(call.file).toMatch(/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
            expect(call.args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", h.DPAPI_SCRIPT]);
            expect(call.options).toMatchObject({ encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 });
            expect(JSON.stringify([call.file, call.args, call.options])).not.toContain(Buffer.from("q18 synthetic secret").toString("base64"));
            expect(call.options.env).toBeUndefined();
            expect(call.options.shell).toBeUndefined();
            expect(Buffer.from(call.request.data, "base64").toString()).toBe("q18 synthetic secret");
            complete(call);
            expect((await pending).toString()).toBe("ciphertext");
        } finally { clearInterval(timer); }
    });
    it.each(["event", "throw"])("handles stdin %s failure, kills and drains the child before rejecting", async mode => {
        const h = controlled();
        if (mode === "throw") h.execFile.mockImplementationOnce((file, args, options, callback) => {
            const stdin = Object.assign(new EventEmitter(), { end: vi.fn((_input: string): void => { throw new Error("private EPIPE"); }) });
            const call = { file, args, options, callback, stdin, kill: vi.fn() };
            h.calls.push(call);
            return call;
        });
        let settled = false;
        const outcome = h.crypto.encryptString("private").then(() => "unexpected", (e: Error) => e.message).finally(() => { settled = true; });
        const call = h.calls[0];
        if (mode === "event") call.stdin.emit("error", Object.assign(new Error("private EPIPE"), { code: "EPIPE" }));
        expect(call.kill).toHaveBeenCalledOnce();
        await delay(10);
        expect(settled).toBe(false);
        complete(call);
        expect(await outcome).toBe(failure);
        // Late pipe errors must also have a listener after process completion.
        expect(() => call.stdin.emit("error", new Error("late private EPIPE"))).not.toThrow();
    });
    it("sanitizes launch and callback failures and validates callback output", async () => {
        const h = controlled();
        h.execFile.mockImplementationOnce(() => { throw new Error("private launch diagnostic"); });
        await expect(h.crypto.encryptString("private")).rejects.toThrow(failure);
        for (const [error, output] of [
            [new Error("private timeout diagnostic"), "private stdout"],
            [new Error("private maxBuffer diagnostic"), ""],
            [null, "invalid!"], [null, "YQ"], [null, "YR=="], [null, ""],
            [null, Buffer.alloc(64 * 1024 + 1).toString("base64")]
        ]) {
            const outcome = h.crypto.encryptString("private");
            h.calls.at(-1).callback(error, output, "private stderr");
            await expect(outcome).rejects.toThrow(failure);
        }
    });
    it("bounds input before spawning and bounds decrypted output", async () => {
        const h = controlled();
        await expect(h.crypto.encryptString("x".repeat(32 * 1024 + 129))).rejects.toThrow(failure);
        await expect(h.crypto.decryptString(Buffer.alloc(64 * 1024 + 1))).rejects.toThrow(failure);
        expect(h.calls).toHaveLength(0);
        const outcome = h.crypto.decryptString(Buffer.from("ciphertext"));
        complete(h.calls[0], "x".repeat(32 * 1024 + 129));
        await expect(outcome).rejects.toThrow(failure);
    });
    it.each(["stdout", "stderr", "timeout"])("enforces actual child %s bound without blocking timers", async mode => {
        const program = mode === "timeout" ? "setTimeout(() => {}, 15000)"
            : `process.${mode}.write('x'.repeat(300 * 1024)); setTimeout(() => {}, 15000)`;
        // Only the fixture executable is substituted; all production limits apply.
        const execFile = (_file: string, _args: string[], options: any, callback: any) => realExecFile(process.execPath, ["-e", program], options, callback);
        const { createDpapiCrypto } = loadAdapter("native/dpapi.ts", { "node:child_process": { execFile } });
        let beats = 0;
        const timer = setInterval(() => beats++, 10);
        try {
            await expect(createDpapiCrypto().encryptString("synthetic")).rejects.toThrow(failure);
            expect(beats).toBeGreaterThan(0);
        } finally { clearInterval(timer); }
    }, 8000);
});
