import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PanelClient } from "../src/core/panelClient";
import { bdRequire, loadAdapter, source } from "./betterdiscordHarness";

const { IDBFactory, IDBObjectStore } = bdRequire("fake-indexeddb");
const A = "123456789012345678";
const B = "223456789012345678";
const message = "Profile-local panel storage operation failed.";
const scopes = ["profile:read", "faq:read", "personal:read", "folders:read", "sync:read"];
const record = (accountId = A, suffix = "one") => ({ version: 1 as const, state: "ready" as const,
    origin: "https://panel.majestic-rp.tech", clientId: "support-templates", accountId, expiresAt: 100_000,
    tokens: { accessToken: `private-access-${suffix}`, refreshToken: `private-refresh-${suffix}`, expiresIn: 60,
        scopes: [...scopes], connectionId: "11111111-1111-4111-8111-111111111111" } });
const marker = (accountId = A) => ({ version: 1 as const, state: "rotating" as const,
    origin: "https://panel.majestic-rp.tech", clientId: "support-templates", accountId });
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
};

function harness() {
    const indexedDB = new IDBFactory();
    const held = new Set<string>();
    const locks = { request: vi.fn(async (name: string, options: any, callback: (lock: any) => Promise<void>) => {
        expect(options).toEqual({ mode: "exclusive", ifAvailable: true });
        if (held.has(name)) return callback(null);
        held.add(name);
        try { await callback({ name, mode: "exclusive" }); }
        finally { held.delete(name); }
    }) };
    const deps = { crypto: webcrypto, indexedDB, locks, origin: "https://discord.com", root: "C:/BD/SupportTemplates/install", platform: "win32" };
    // The VM intentionally gets browser primitives explicitly, not Node crypto globals.
    const module = () => loadAdapter("native/browserVault.ts", {}, { crypto: webcrypto, indexedDB, navigator: { locks } });
    const open = (overrides: Record<string, unknown> = {}) => module().createBrowserVaultSession({ ...deps, ...overrides });
    async function db(name?: string): Promise<any> {
        const request = indexedDB.open(name ?? (await indexedDB.databases())[0].name, 1);
        return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    }
    async function stored(accountId = A, replacement?: any, name?: string): Promise<any> {
        const connection = await db(name);
        try {
            return await new Promise((resolve, reject) => {
                const tx = connection.transaction("sessions", replacement === undefined ? "readonly" : "readwrite");
                const request = replacement === undefined ? tx.objectStore("sessions").get(accountId) : tx.objectStore("sessions").put(replacement, accountId);
                tx.oncomplete = () => resolve(request.result);
                tx.onabort = () => reject(tx.error);
            });
        } finally { connection.close(); }
    }
    return { indexedDB, locks, held, deps, open, stored };
}

describe("BetterDiscord profile-local browser vault", () => {
    it("persists restart and rotation, stores nonextractable keys with ciphertext only, and durably logs out", async () => {
        const h = harness();
        const first = await h.open();
        const vault = first.forAccount(A);
        expect(first.forAccount(A)).toBe(vault);
        await vault.save(record());
        const raw = await h.stored();
        expect(Object.keys(raw).sort()).toEqual(["ciphertext", "iv", "key", "version"]);
        expect(raw.key.extractable).toBe(false);
        await expect(webcrypto.subtle.exportKey("raw", raw.key)).rejects.toThrow();
        expect(JSON.stringify(raw)).not.toContain("private");
        expect(Buffer.from(raw.ciphertext).includes(Buffer.from("private"))).toBe(false);
        await first.close();
        const second = await h.open();
        const resumed = second.forAccount(A);
        expect(await resumed.load()).toEqual(record());
        await resumed.save(marker());
        await resumed.save(record(A, "rotated"));
        expect((await h.stored()).iv).not.toEqual(raw.iv);
        await second.close();
        const third = await h.open();
        expect(await third.forAccount(A).load()).toEqual(record(A, "rotated"));
        await third.forAccount(A).clear();
        expect(await h.stored()).toBeUndefined();
        await third.close();
        const fourth = await h.open();
        expect(await fourth.forAccount(A).load()).toBeNull();
        await fourth.close();
        expect(h.held.size).toBe(0);
    });

    it("restores PanelClient without device flow, persists rotation across restart and durably logs out", async () => {
        const h = harness();
        let session = await h.open();
        await session.forAccount(A).save(record());
        await session.close();
        session = await h.open();
        const transport = vi.fn(async (path: string) => {
            if (path === "/oauth/token") {
                expect(await session.forAccount(A).load()).toEqual(marker());
                return { access_token: "private-access-two", refresh_token: "private-refresh-two", token_type: "Bearer",
                    expires_in: 60, scope: scopes.join(" "), connectionId: record().tokens.connectionId };
            }
            return {};
        });
        const client = new PanelClient(transport, { vault: session.forAccount(A), accountId: A, now: () => 100_000 });
        expect(await client.restore()).toBe(true);
        expect(transport).not.toHaveBeenCalled();
        await client.get("/me");
        expect((await session.forAccount(A).load()).tokens.refreshToken).toBe("private-refresh-two");
        expect(transport.mock.calls.filter(([path]) => path === "/oauth/token")).toHaveLength(1);
        client.dispose();
        await session.close();
        session = await h.open();
        const resumed = new PanelClient(transport, { vault: session.forAccount(A), accountId: A, now: () => 100_000 });
        const callsBeforeRestore = transport.mock.calls.length;
        expect(await resumed.restore()).toBe(true);
        expect(transport).toHaveBeenCalledTimes(callsBeforeRestore);
        expect((await session.forAccount(A).load()).tokens.refreshToken).toBe("private-refresh-two");
        await resumed.logout();
        expect(await h.stored()).toBeUndefined();
        expect(transport.mock.calls.map(([path]) => path)).toEqual(["/oauth/token", "/me", "/oauth/revoke"]);
        await session.close();
        session = await h.open();
        const loggedOut = new PanelClient(transport, { vault: session.forAccount(A), accountId: A, now: () => 100_000 });
        expect(await loggedOut.restore()).toBe(false);
        loggedOut.dispose();
        // Crash after the write-ahead marker: the original single-use pair is gone.
        await session.forAccount(A).save(marker());
        await session.close();
        session = await h.open();
        const afterCrash = new PanelClient(transport, { vault: session.forAccount(A), accountId: A, now: () => 100_000 });
        expect(await afterCrash.restore()).toBe(false);
        expect(await session.forAccount(A).load()).toBeNull();
        afterCrash.dispose();
        await session.close();
    });

    it("isolates accounts and rejects swapped ciphertext even when its key travels with it", async () => {
        const h = harness();
        const session = await h.open();
        await session.forAccount(A).save(record());
        await session.forAccount(B).save(record(B));
        await h.stored(B, await h.stored(A));
        await expect(session.forAccount(B).load()).rejects.toThrow(message);
        await session.forAccount(B).clear();
        expect(await session.forAccount(A).load()).toEqual(record());
        await session.close();
    });

    it("binds ciphertext to normalized installation root and Discord origin", async () => {
        const h = harness();
        const first = await h.open();
        await first.forAccount(A).save(record());
        const raw = await h.stored();
        await first.close();
        const alias = await h.open({ root: "c:\\bd\\SupportTemplates\\temp\\..\\install\\" });
        expect(await alias.forAccount(A).load()).toEqual(record());
        await alias.close();
        for (const override of [{ root: "C:/Other/install" }, { origin: "https://canary.discord.com" }]) {
            const other = await h.open(override);
            expect(await other.forAccount(A).load()).toBeNull();
            const name = [...h.held][0];
            await h.stored(A, raw, name);
            await expect(other.forAccount(A).load()).rejects.toThrow(message);
            await other.close();
        }
        await expect(h.open({ root: "relative/path" })).rejects.toThrow(message);
        await expect(h.open({ origin: "https://evil.test" })).rejects.toThrow(message);
    });

    it("rejects competing session owners until close, even when no vault operation is running", async () => {
        const h = harness();
        const one = await h.open();
        await one.forAccount(A).save(record());
        await expect(h.open()).rejects.toThrow(message);
        expect(h.held.size).toBe(1);
        // Accounts share the installation-wide session lease, not separate rotation locks.
        expect(one.forAccount(B)).toBeDefined();
        await one.close();
        const two = await h.open();
        expect(await two.forAccount(A).load()).toEqual(record());
        await two.close();
    });

    it("snapshots accepted writes, drains before releasing, and fences stale vaults", async () => {
        const h = harness();
        const entered = deferred(), release = deferred();
        const subtle = new Proxy(webcrypto.subtle, { get(target, key) {
            if (key === "encrypt") return async (...args: any[]) => {
                entered.resolve(); await release.promise;
                return (target.encrypt as any)(...args);
            };
            const value = (target as any)[key];
            return typeof value === "function" ? value.bind(target) : value;
        } });
        const first = await h.open({ crypto: { subtle, getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } });
        const vault = first.forAccount(A);
        const input = record();
        const saved = vault.save(input);
        input.tokens.refreshToken = "mutated-after-save";
        await entered.promise;
        const closing = first.close();
        expect(first.close()).toBe(closing);
        await expect(vault.clear()).rejects.toThrow(message);
        await expect(h.open()).rejects.toThrow(message);
        release.resolve();
        await saved; await closing;
        const second = await h.open();
        expect(await second.forAccount(A).load()).toEqual(record());
        await expect(vault.save(record(A, "stale"))).rejects.toThrow(message);
        await second.close();
    });

    it("rejects tampering, oversized/malformed envelopes and missing keys; clear still removes corruption", async () => {
        const h = harness();
        const session = await h.open();
        const vault = session.forAccount(A);
        await vault.save(record());
        const raw = await h.stored();
        const damaged = structuredClone(raw);
        new Uint8Array(damaged.ciphertext)[0] ^= 1;
        for (const bad of [damaged, { ...raw, key: null }, { ...raw, iv: new Uint8Array(11) },
            { ...raw, ciphertext: new ArrayBuffer(32785) }, { ...raw, version: 2 }]) {
            await h.stored(A, bad);
            await expect(vault.load()).rejects.toThrow(message);
            await vault.clear();
            expect(await vault.load()).toBeNull();
        }
        await session.close();
    });

    it("bounds JSON, validates account and record binding without invoking user code", async () => {
        const h = harness();
        const session = await h.open();
        for (const account of ["../bad", "18446744073709551616", "012345678901234567", "1", A + "\n"]) expect(session.forAccount(account)).toBeUndefined();
        const vault = session.forAccount(A);
        const getter = vi.fn(() => "secret");
        const accessor = Object.defineProperty(record(), "tokens", { enumerable: true, get: getter });
        const toJSON = vi.fn(() => record());
        const cycle: any = record(); cycle.self = cycle;
        for (const input of [accessor, { ...record(), toJSON }, cycle, record(B), { ...record(), origin: "https://evil.test" },
            { ...record(), extra: undefined }, { ...record(), extra: "x".repeat(32769) }, { ...record(), extra: "😀".repeat(9000) },
            { ...record(), extra: NaN }, { ...record(), extra: new Date() }, { ...marker(), tokens: record().tokens },
            { ...record(), extra: JSON.parse('{"__proto__":{}}') }]) await expect(vault.save(input)).rejects.toThrow(message);
        expect(getter).not.toHaveBeenCalled();
        expect(toJSON).not.toHaveBeenCalled();
        expect(await vault.load()).toBeNull();
        await session.close();
    });

    it("reports aborted writes and failed logout deletion instead of claiming persistence succeeded", async () => {
        const h = harness();
        const session = await h.open();
        const vault = session.forAccount(A);
        await vault.save(record());
        const put = IDBObjectStore.prototype.put;
        const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(function (this: any, ...args: any[]) {
            const request = put.apply(this, args);
            this.transaction.abort();
            return request;
        });
        try { await expect(vault.save(record(A, "lost"))).rejects.toThrow(message); }
        finally { spy.mockRestore(); }
        expect(await vault.load()).toEqual(record());
        const deletion = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementationOnce(() => { throw new Error("private-refresh-one"); });
        try { await expect(vault.clear()).rejects.toThrow(message); }
        finally { deletion.mockRestore(); }
        expect(await vault.load()).toEqual(record());
        await vault.clear();
        await session.close();
    });

    it("selects browser storage on restricted hosts and serializes close/reopen during initialization", async () => {
        const h = harness();
        const requested: string[] = [];
        const browserGlobals = {
            crypto: webcrypto, indexedDB: h.indexedDB, navigator: { locks: h.locks },
            location: { origin: h.deps.origin }, process: { platform: "win32", env: {} },
            BdApi: { Plugins: { folder: "C:/BD/plugins" }, Data: { save: () => { throw Error("No BdApi.Data secrets"); } } },
        };
        const host = loadAdapter("native/vaultHost.ts", {}, {
            // evaluate runs CJS at VM top level without Node's module wrapper: its
            // bundled `var crypto = require("crypto")` must not replace WebCrypto.
            ...browserGlobals, globalThis: browserGlobals,
            require(name: string) {
                const bare = name.replace(/^node:/, ""); requested.push(bare);
                if (bare === "fs") return { existsSync: () => true, realpathSync: (path: string) => path, lstatSync: () => ({ isSymbolicLink: () => false }) };
                if (bare === "crypto") return { createHash: bdRequire("crypto").createHash };
                if (bare === "path") return bdRequire("path").win32;
                throw Error(`Unsupported module: ${name}`);
            }
        });
        const first = host.createPanelVault(A);
        const closing = host.closePanelVault();
        const reopened = host.createPanelVault(A);
        const stale = await first;
        await closing;
        const current = await reopened;
        expect(current).not.toBe(stale);
        expect(await host.createPanelVault(A)).toBe(current);
        await expect(stale.save(record())).rejects.toThrow(message);
        await current.save(record());
        await host.closePanelVault();
        expect(await (await host.createPanelVault(A)).load()).toEqual(record());
        await host.closePanelVault();
        expect(new Set(requested)).toEqual(new Set(["fs", "crypto", "path"]));
        expect(h.held.size).toBe(0);
        expect(source("betterdiscord/native/browserVault.ts")).not.toMatch(/(?:from\s+["'](?:node:|fs|crypto|child_process)|require\s*\()/);
    });

    it("falls back honestly on initialization denial, but surfaces operations failing after opening", async () => {
        const h = harness();
        const browserGlobals = { crypto: webcrypto, indexedDB: h.indexedDB, navigator: { locks: h.locks },
            location: { origin: h.deps.origin }, BdApi: { Plugins: { folder: "C:/BD/plugins" } } };
        const host = () => loadAdapter("native/vaultHost.ts", {}, {
            ...browserGlobals, globalThis: browserGlobals, process: { platform: "win32", env: {} },
            require(name: string) {
                const bare = name.replace(/^node:/, "");
                if (bare === "fs") return { existsSync: () => true, realpathSync: (path: string) => path, lstatSync: () => ({ isSymbolicLink: () => false }) };
                if (bare === "crypto") return { createHash: bdRequire("crypto").createHash };
                if (bare === "path") return bdRequire("path").win32;
                throw Error(`Unsupported module: ${name}`);
            }
        });
        const owner = host(), contender = host();
        const vault = await owner.createPanelVault(A);
        await vault.save(record());
        expect(await contender.createPanelVault(A)).toBeUndefined();
        expect(await vault.load()).toEqual(record());
        await owner.closePanelVault();
        const reopened = await contender.createPanelVault(A);
        const deletion = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementationOnce(() => { throw Error("private"); });
        try { await expect(reopened.clear()).rejects.toThrow(message); }
        finally { deletion.mockRestore(); }
        await contender.closePanelVault();
        const open = vi.spyOn(h.indexedDB, "open").mockImplementationOnce(() => { throw Error("database blocked"); });
        try { expect(await owner.createPanelVault(A)).toBeUndefined(); }
        finally { open.mockRestore(); }
        expect(h.held.size).toBe(0);
        expect(await (await owner.createPanelVault(A)).load()).toEqual(record());
        await owner.closePanelVault();
    });
});
