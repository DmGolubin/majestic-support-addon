import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { loadAdapter } from "./betterdiscordHarness";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temporary = () => { const path = mkdtempSync(join(tmpdir(), "stx-bd-test-")); dirs.push(path); return path; };
const url = "https://panel.majestic-rp.tech/api/plugin/v1/me";
describe("BetterDiscord panel transport through BdApi.Net", () => {
    it("streams the response through Net.fetch with constrained endpoint, headers, TLS and redirects", async () => {
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start(c) { stream = c; } });
        const net = vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
        const { makePanelFetch } = loadAdapter("native/transport.ts");
        const fetch = makePanelFetch(net);
        const signal = new AbortController().signal;
        const response = await fetch(url, { signal, headers: { Authorization: "Bearer secret", Accept: "text/event-stream" } });
        expect(net.mock.calls[0]).toEqual([url, expect.objectContaining({ method: "GET", redirect: "error", maxRedirects: 0, rejectUnauthorized: true, timeout: null, credentials: "omit", signal, headers: { authorization: "Bearer secret", accept: "text/event-stream" } })]);
        const reader = response.body.getReader();
        stream.enqueue(new TextEncoder().encode("first"));
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
        stream.enqueue(new TextEncoder().encode("last")); stream.close();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("last");
        expect((await reader.read()).done).toBe(true);
        for (const denied of ["https://evil.test/api/plugin/v1/me", url + "?token=secret", url + "#fragment", "https://user:pass@panel.majestic-rp.tech/api/plugin/v1/me", "https://panel.majestic-rp.tech/not-api"]) await expect(fetch(denied)).rejects.toThrow();
        await expect(fetch(url, { headers: { Cookie: "bad" } })).rejects.toThrow();
        await expect(fetch(url, { method: "PUT" })).rejects.toThrow();
        await expect(fetch(url, { body: "a".repeat(1024 * 1024 + 1) })).rejects.toThrow();
        expect(net).toHaveBeenCalledTimes(1);
    });
    it("rejects and cancels redirects even if the host ignores redirect:error, preserves 204 and API errors", async () => {
        const { makePanelFetch } = loadAdapter("native/transport.ts");
        const cancelled = vi.fn();
        const redirect = new Response(new ReadableStream({ cancel: cancelled }), { status: 302 });
        await expect(makePanelFetch(async () => redirect)(url)).rejects.toThrow("network");
        expect(cancelled).toHaveBeenCalledOnce();
        for (const status of [204, 401, 429]) {
            const response = await makePanelFetch(async () => new Response(null, { status }))(url, { method: "DELETE" });
            expect(response.status).toBe(status);
        }
    });
    it("uses the actual BdApi.Net entrypoint, forwards cancellation and sanitizes request failures", async () => {
        const net = vi.fn(async (_input: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("private-token")), { once: true })));
        const { panelFetch } = loadAdapter("native/transport.ts", {}, { BdApi: { Net: { fetch: net } } });
        const controller = new AbortController();
        const pending = panelFetch(url, { signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toThrow("Panel network request failed");
        await expect(panelFetch(url, { signal: controller.signal })).rejects.toThrow("aborted");
        expect(net).toHaveBeenCalledOnce();
    });
});

describe("BetterDiscord protected session vault", () => {
    it("retains native rejection of a dangling storage ancestor", () => {
        const dir = temporary(), plugins = join(dir, "plugins"); mkdirSync(plugins);
        symlinkSync(join(dir, "missing-target"), join(dir, "SupportTemplates"), process.platform === "win32" ? "junction" : "dir");
        const { installationPaths } = loadAdapter("native/paths.ts", {}, { location: { origin: "https://discord.com" }, BdApi: { Plugins: { folder: plugins } } });
        expect(() => installationPaths()).toThrow("Unsafe storage path");
    });
    it("uses a session-only login without importing unsupported native modules on standard BetterDiscord", async () => {
        const requested: string[] = [];
        const { createPanelVault, closePanelVault } = loadAdapter("native/vaultHost.ts", {}, {
            process: { platform: "win32", env: {} },
            require(name: string) {
                requested.push(name);
                if (name === "fs" || name === "crypto") return {};
                throw new Error(`Unsupported host module: ${name}`);
            }
        });
        expect(await createPanelVault("123456789012345678")).toBeUndefined();
        await closePanelVault();
        expect(requested).toEqual(["fs", "crypto"]);
    });
    it("encrypts on disk, binds accounts, serializes snapshots, rejects competing owners, drains and releases", async () => {
        const dir = temporary();
        const { createVaultSession } = loadAdapter("native/vault.ts");
        const key = randomBytes(32);
        const crypto = {
            isEncryptionAvailable: () => true,
            encryptString(value: string) { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
                return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]); },
            decryptString(value: Buffer) { const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
                cipher.setAuthTag(value.subarray(-16)); return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString(); }
        };
        const one = createVaultSession({ root: dir, crypto, platform: "win32" });
        const account = "123456789012345678";
        expect(one.forAccount("../../outside")).toBeUndefined();
        const vault = one.forAccount(account);
        expect(one.forAccount(account)).toBe(vault);
        const record = { refreshToken: "private-refresh", accessToken: "private-access" };
        const saved = vault.save(record); record.refreshToken = "changed";
        await saved;
        expect(await vault.load()).toEqual({ refreshToken: "private-refresh", accessToken: "private-access" });
        expect(readFileSync(join(dir, account + ".bin")).includes(Buffer.from("private"))).toBe(false);
        const two = createVaultSession({ root: dir, crypto, platform: "win32" });
        expect(two.forAccount(account)).toBeUndefined();
        const pending = vault.save({ refreshToken: "last" });
        const closing = one.close(); await pending; await closing;
        await expect(vault.save({ refreshToken: "stale" })).rejects.toThrow();
        const replacement = two.forAccount(account);
        expect(await replacement.load()).toEqual({ refreshToken: "last" });
        expect(await two.forAccount("123456789012345679").load()).toBeNull();
        await replacement.clear(); await two.close();
        expect(readdirSync(dir)).toEqual([]);
    });
    it("fails closed when encryption is unavailable", async () => {
        const { createVaultSession } = loadAdapter("native/vault.ts");
        const session = createVaultSession({ root: temporary(), crypto: { isEncryptionAvailable: () => false } });
        expect(session.forAccount("123456789012345678")).toBeUndefined();
        await session.close();
    });
    it("passes DPAPI secret bytes only on stdin and hides the bounded PowerShell process", async () => {
        const { createDpapiCrypto, DPAPI_SCRIPT } = loadAdapter("native/dpapi.ts");
        const stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
        const execFile: any = vi.fn(() => ({ stdin }));
        const crypto = createDpapiCrypto({ execFile, executable: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" });
        const encrypted = crypto.encryptString("secret-token");
        const [file, args, options, callback] = execFile.mock.calls[0];
        callback(null, Buffer.from("ciphertext").toString("base64"), "");
        expect((await encrypted).toString()).toBe("ciphertext");
        expect(file).toContain("powershell.exe");
        expect(args.join(" ")).not.toContain("secret-token");
        expect(args.at(-1)).toBe(DPAPI_SCRIPT);
        expect(options).toMatchObject({ windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 });
        expect(Buffer.from(JSON.parse(stdin.end.mock.calls[0][0]).data, "base64").toString()).toBe("secret-token");
        const decrypted = crypto.decryptString(Buffer.from("bad"));
        execFile.mock.calls[1][3](new Error("secret-token"), "", "secret-token");
        await expect(decrypted).rejects.toThrow("Protected panel storage operation failed.");
    });
    it.skipIf(process.platform !== "win32")("q18 round-trips synthetic data through real Windows CurrentUser DPAPI with responsive timers", async () => {
        const { createDpapiCrypto } = loadAdapter("native/dpapi.ts");
        const crypto = createDpapiCrypto();
        const metrics: Record<string, unknown> = {};
        const measure = async <T>(name: string, operation: () => Promise<T>) => {
            const start = performance.now();
            let previous = start, maxGapMs = 0, beats = 0;
            const timer = setInterval(() => {
                const now = performance.now();
                maxGapMs = Math.max(maxGapMs, now - previous); previous = now; beats++;
            }, 10);
            try {
                const pending = operation();
                const returnedMs = performance.now() - start;
                const result = await pending;
                maxGapMs = Math.max(maxGapMs, performance.now() - previous);
                metrics[name] = { durationMs: performance.now() - start, returnedMs, beats, maxGapMs };
                expect(beats).toBeGreaterThan(0);
                return result;
            } finally { clearInterval(timer); }
        };
        expect(crypto.isEncryptionAvailable()).toBe(false);
        expect(await measure("initialize", () => crypto.initialize())).toBe(true);
        expect(crypto.isEncryptionAvailable()).toBe(true);
        const cipher = await measure<Buffer>("encrypt", () => crypto.encryptString("synthetic-test-value"));
        expect(cipher.includes(Buffer.from("synthetic-test-value"))).toBe(false);
        expect(await measure("decrypt", () => crypto.decryptString(cipher))).toBe("synthetic-test-value");
        console.log("Q18_DPAPI_HEARTBEAT " + JSON.stringify(metrics));
    }, 20000); // Three independently bounded 5s children, plus test/host overhead.
});
