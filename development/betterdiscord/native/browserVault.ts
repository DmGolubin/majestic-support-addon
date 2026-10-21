// SPDX-License-Identifier: GPL-3.0-or-later
import type { PanelSessionRecord, PanelVault } from "../../src/core/panelClient";
import { PANEL_CLIENT_ID, PANEL_ORIGIN, parsePanelTokens } from "../../src/core/panelProtocol";

const MAX_PLAIN = 32 * 1024;
const STORE = "sessions";
const failed = () => new Error("Profile-local panel storage operation failed.");
export const validBrowserVaultAccount = (value: unknown): value is string => typeof value === "string"
    && /^[1-9]\d{16,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;

export interface BrowserVaultDependencies {
    crypto: Crypto;
    indexedDB: IDBFactory;
    locks: Pick<LockManager, "request">;
    origin: string;
    root: string;
    platform?: string;
}

/** No Node modules: the host supplies its canonical installation path when available. */
function normalizedRoot(root: string, platform?: string): string {
    if (typeof root !== "string" || !root || root.length > 4096 || /[\u0000-\u001f]/.test(root)) throw failed();
    let value = root.replaceAll("\\", "/");
    if (!value.startsWith("/") && !/^[a-z]:\//i.test(value)) throw failed();
    const prefix = value.startsWith("//") ? "//" : value.startsWith("/") ? "/" : "";
    const parts: string[] = [];
    for (const part of value.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") {
            if (!parts.length || /^[a-z]:$/i.test(parts.at(-1)!)) throw failed();
            parts.pop();
        } else parts.push(part);
    }
    value = prefix + parts.join("/");
    return platform === "win32" ? value.toLowerCase() : value;
}

// Bound JSON before serialization; never invoke accessors/toJSON or silently drop values.
function recordJSON(value: unknown, accountId: string): string {
    let nodes = 0;
    let characters = 0;
    const visit = (item: unknown, depth: number): void => {
        if (++nodes > 2048 || depth > 16) throw failed();
        if (typeof item === "string") { characters += item.length; if (characters > MAX_PLAIN) throw failed(); return; }
        if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) return;
        if (!item || typeof item !== "object") throw failed();
        const array = Array.isArray(item);
        if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw failed();
        if (array && item.length > 2048) throw failed();
        const keys = Reflect.ownKeys(item);
        if (keys.length > 2049) throw failed();
        for (const key of keys) {
            if (array && key === "length") continue;
            if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) throw failed();
            characters += key.length;
            if (characters > MAX_PLAIN) throw failed();
            const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
            if (!descriptor.enumerable || !("value" in descriptor) || (array && !/^(0|[1-9]\d*)$/.test(key))) throw failed();
            visit(descriptor.value, depth + 1);
        }
        if (array && keys.length !== item.length + 1) throw failed();
    };
    if (!value || typeof value !== "object" || Array.isArray(value)) throw failed();
    visit(value, 0);
    const json = JSON.stringify(value);
    if (new TextEncoder().encode(json).byteLength > MAX_PLAIN) throw failed();
    const record = JSON.parse(json);
    if (record.version !== 1 || record.accountId !== accountId || record.origin !== PANEL_ORIGIN
        || record.clientId !== PANEL_CLIENT_ID || !["ready", "rotating"].includes(record.state)) throw failed();
    const keys = Object.keys(record).sort().join(",");
    if (record.state === "rotating") {
        if (keys !== "accountId,clientId,origin,state,version") throw failed();
    } else {
        if (keys !== "accountId,clientId,expiresAt,origin,state,tokens,version"
            || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= 0) throw failed();
        const t = record.tokens;
        if (!t || typeof t !== "object" || Array.isArray(t)
            || Object.keys(t).sort().join(",") !== "accessToken,connectionId,expiresIn,refreshToken,scopes"
            || !Array.isArray(t.scopes) || !t.scopes.every((s: unknown) => typeof s === "string" && /^[a-z]+:[a-z:]+$/.test(s))) throw failed();
        parsePanelTokens({ token_type: "Bearer", access_token: t.accessToken, refresh_token: t.refreshToken,
            expires_in: t.expiresIn, connectionId: t.connectionId, scope: t.scopes.join(" ") });
        if (!Number.isSafeInteger(t.expiresIn * 1000)) throw failed();
    }
    return json;
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = factory.open(name, 1);
        let abandoned = false;
        request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
        request.onblocked = () => { abandoned = true; reject(failed()); };
        request.onerror = () => reject(failed());
        request.onsuccess = () => {
            const db = request.result;
            if (abandoned) { db.close(); return; }
            db.onversionchange = () => db.close();
            resolve(db);
        };
    });
}

// A request succeeding is not a durable commit. Resolve only at transaction completion.
function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode, { durability: "strict" });
        let request: IDBRequest<T>;
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(failed());
        try { request = operation(tx.objectStore(STORE)); }
        // Request errors abort by default. Wait for onabort, not the earlier error
        // event, so close cannot release the session lock before the write drains.
        catch { tx.abort(); }
    });
}

interface Envelope { version: 1; key: CryptoKey; iv: Uint8Array; ciphertext: ArrayBuffer; }
function envelope(value: any): Envelope {
    // CryptoKey brand/algorithm is additionally checked by WebCrypto on use. Cross-realm
    // structured clones preclude instanceof checks against the renderer's constructors.
    if (!value || value.version !== 1 || Object.keys(value).sort().join(",") !== "ciphertext,iv,key,version"
        || value.key?.type !== "secret" || value.key.extractable !== false
        || value.key.algorithm?.name !== "AES-GCM" || value.key.algorithm.length !== 256
        || value.key.usages?.length !== 2 || !value.key.usages.includes("encrypt") || !value.key.usages.includes("decrypt")
        || Object.prototype.toString.call(value.iv) !== "[object Uint8Array]" || value.iv.byteLength !== 12
        || Object.prototype.toString.call(value.ciphertext) !== "[object ArrayBuffer]"
        || value.ciphertext.byteLength < 17 || value.ciphertext.byteLength > MAX_PLAIN + 16) throw failed();
    return value;
}

/** Profile-local encryption, NOT an OS keychain. The nonextractable key is stored in
 * IndexedDB with the ciphertext; malicious same-origin code can still use that key.
 * The exclusive Web Lock lasts until close, including network refresh-token rotation.
 */
export async function createBrowserVaultSession(deps: BrowserVaultDependencies) {
    if (!["https://discord.com", "https://ptb.discord.com", "https://canary.discord.com"].includes(deps.origin)) throw failed();
    const scope = [deps.origin, normalizedRoot(deps.root, deps.platform)];
    const encoder = new TextEncoder();
    let identity: string;
    try {
        const digest = await deps.crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(scope)));
        identity = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    } catch { throw failed(); }
    const name = `SupportTemplates.panel-vault.v1.${identity}`;
    let release!: () => void;
    let acquired!: () => void;
    let denied!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { acquired = resolve; denied = reject; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let lockTask: Promise<unknown>;
    try {
        lockTask = deps.locks.request(name, { mode: "exclusive", ifAvailable: true }, async lock => {
            if (!lock) { denied(failed()); return; }
            acquired();
            await held;
        });
    } catch { throw failed(); }
    // Attach immediately, including failures before the callback runs.
    const lockFinished = lockTask.then(() => {}, () => { denied(failed()); });
    await ready;
    let db: IDBDatabase;
    try { db = await openDatabase(deps.indexedDB, name); }
    catch { release(); await lockFinished; throw failed(); }
    let closed = false;
    let closing: Promise<void> | undefined;
    let tail: Promise<unknown> = Promise.resolve();
    const accounts = new Map<string, PanelVault>();
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        if (closed) return Promise.reject(failed());
        const task = tail.then(operation).catch(() => { throw failed(); });
        // Only the drain catches: each caller still observes its own failure.
        tail = task.then(() => {}, () => {});
        return task;
    };
    return {
        forAccount(accountId: string): PanelVault | undefined {
            if (closed || !validBrowserVaultAccount(accountId)) return undefined;
            if (!accounts.has(accountId)) {
                const aad = encoder.encode(JSON.stringify([1, ...scope, accountId]));
                const read = () => transaction(db, "readonly", store => store.get(accountId));
                accounts.set(accountId, {
                    load: () => enqueue(async () => {
                        const raw = await read();
                        if (raw === undefined) return null;
                        const saved = envelope(raw);
                        const bytes = await deps.crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(saved.iv), additionalData: aad, tagLength: 128 }, saved.key, saved.ciphertext);
                        if (bytes.byteLength > MAX_PLAIN) throw failed();
                        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
                        recordJSON(value, accountId);
                        return value;
                    }),
                    save: (record: PanelSessionRecord) => {
                        let plain: string;
                        try { plain = recordJSON(record, accountId); } catch { return Promise.reject(failed()); }
                        return enqueue(async () => {
                            const previous = await read();
                            const key = previous === undefined
                                ? await deps.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
                                : envelope(previous).key;
                            const iv = deps.crypto.getRandomValues(new Uint8Array(12));
                            const ciphertext = await deps.crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, encoder.encode(plain));
                            await transaction(db, "readwrite", store => store.put({ version: 1, key, iv, ciphertext }, accountId));
                        });
                    },
                    clear: () => enqueue(async () => { await transaction(db, "readwrite", store => store.delete(accountId)); })
                });
            }
            return accounts.get(accountId)!;
        },
        close(): Promise<void> {
            if (!closing) {
                closed = true;
                closing = (async () => {
                    await tail;
                    db.close();
                    accounts.clear();
                    release();
                    await lockFinished;
                })();
            }
            return closing;
        }
    };
}
