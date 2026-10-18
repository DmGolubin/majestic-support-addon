import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { loadAdapter } from "./betterdiscordHarness";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temporary = () => { const path = mkdtempSync(join(tmpdir(), "stx-bd-test-")); dirs.push(path); return path; };
const url = "https://panel.majestic-rp.tech/api/plugin/v1/me";
function requestFixture(status = 200, contentType = "application/json") {
    let incoming: any;
    const req: any = new EventEmitter();
    req.end = vi.fn(() => {});
    req.destroy = vi.fn((error: Error) => { req.emit("error", error); req.emit("close"); });
    const request = vi.fn((_url, _options, callback) => {
        incoming = new PassThrough(); incoming.statusCode = status; incoming.headers = { "content-type": contentType };
        queueMicrotask(() => callback(incoming)); return req;
    });
    return { request, req, incoming: () => incoming };
}

describe("BetterDiscord native panel transport", () => {
    it("streams JSON and SSE without cookies, credentials, redirects or arbitrary endpoints", async () => {
        for (const mime of ["application/json", "text/event-stream"]) {
            const f = requestFixture(200, mime);
            const { makePanelFetch } = loadAdapter("native/transport.ts");
            const fetch = makePanelFetch(f.request);
            const response = await fetch(url, { headers: { Authorization: "Bearer secret", Accept: mime } });
            expect(f.request.mock.calls[0][1]).toMatchObject({ agent: false, rejectUnauthorized: true, headers: { authorization: "Bearer secret" } });
            expect(f.request.mock.calls[0][1].headers).not.toHaveProperty("cookie");
            f.incoming().write("first");
            const reader = response.body.getReader();
            expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
            f.incoming().end("last");
            expect(new TextDecoder().decode((await reader.read()).value)).toBe("last");
            expect((await reader.read()).done).toBe(true);
            const calls = f.request.mock.calls.length;
            for (const denied of ["https://evil.test/api/plugin/v1/me", url + "?token=secret", url + "#fragment", "https://user:pass@panel.majestic-rp.tech/api/plugin/v1/me", "https://panel.majestic-rp.tech/not-api"]) {
                await expect(fetch(denied)).rejects.toThrow();
            }
            await expect(fetch(url, { headers: { Cookie: "bad" } })).rejects.toThrow();
            expect(f.request).toHaveBeenCalledTimes(calls);
        }
    });
    it("rejects redirects without forwarding bearer credentials and preserves 204", async () => {
        const { makePanelFetch } = loadAdapter("native/transport.ts");
        const redirect = requestFixture(302);
        await expect(makePanelFetch(redirect.request)(url)).rejects.toThrow("network");
        expect(redirect.request).toHaveBeenCalledTimes(1);
        expect(redirect.incoming().destroyed).toBe(true);
        const noContent = requestFixture(204);
        const response = await makePanelFetch(noContent.request)(url, { method: "DELETE" });
        expect(response.status).toBe(204); expect(response.body).toBeNull();
        noContent.incoming().end();
    });
    it("aborts both a pending request and a streaming body with sanitized errors", async () => {
        const f = requestFixture();
        const { makePanelFetch } = loadAdapter("native/transport.ts");
        const controller = new AbortController();
        const response = await makePanelFetch(f.request)(url, { signal: controller.signal });
        const read = response.body.getReader().read();
        controller.abort("private-secret");
        await expect(read).rejects.toThrow();
        expect(f.req.destroy).toHaveBeenCalledOnce();
        expect(String(f.req.destroy.mock.calls[0][0])).not.toContain("private-secret");
        const pre = new AbortController(); pre.abort();
        await expect(makePanelFetch(f.request)(url, { signal: pre.signal })).rejects.toThrow();
        expect(f.request).toHaveBeenCalledOnce();
    });
});

describe("BetterDiscord protected session vault", () => {
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
    it("passes DPAPI secret bytes only on stdin and hides the bounded PowerShell process", () => {
        const { createDpapiCrypto, DPAPI_SCRIPT } = loadAdapter("native/dpapi.ts");
        const spawn: any = vi.fn(() => ({ status: 0, stdout: Buffer.from("ciphertext").toString("base64") }));
        const crypto = createDpapiCrypto({ spawn, executable: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" });
        expect(crypto.encryptString("secret-token").toString()).toBe("ciphertext");
        const [file, args, options] = spawn.mock.calls[0];
        expect(file).toContain("powershell.exe");
        expect(args.join(" ")).not.toContain("secret-token");
        expect(args.at(-1)).toBe(DPAPI_SCRIPT);
        expect(options).toMatchObject({ windowsHide: true, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
        expect(Buffer.from(JSON.parse(options.input).data, "base64").toString()).toBe("secret-token");
        spawn.mockReturnValue({ status: 1, stderr: "secret-token" });
        expect(() => crypto.decryptString(Buffer.from("bad"))).toThrow("Protected panel storage operation failed.");
    });
    it.skipIf(process.platform !== "win32")("round-trips synthetic data through real Windows CurrentUser DPAPI", () => {
        const { createDpapiCrypto } = loadAdapter("native/dpapi.ts");
        const crypto = createDpapiCrypto();
        expect(crypto.isEncryptionAvailable()).toBe(true);
        const cipher = crypto.encryptString("synthetic-test-value");
        expect(cipher.includes(Buffer.from("synthetic-test-value"))).toBe(false);
        expect(crypto.decryptString(cipher)).toBe("synthetic-test-value");
    }, 15000);
});
