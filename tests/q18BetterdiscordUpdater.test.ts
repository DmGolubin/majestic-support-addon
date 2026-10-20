import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { loadAdapter, source } from "./betterdiscordHarness";

const directories: string[] = [];
afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Q18 BetterDiscord updater cancellation", () => {
    it("cancels a late response body after its owning request was aborted", async () => {
        const { hostTransport } = loadAdapter("native/hostUpdater.ts");
        let respond!: (value: Response) => void;
        const net = vi.fn(() => new Promise<Response>(resolve => { respond = resolve; }));
        const abort = new AbortController();
        const request = hostTransport(net)("https://api.github.com/fixture", { signal: abort.signal });
        abort.abort();
        const cancel = vi.fn();
        respond(new Response(new ReadableStream({ cancel })));
        await expect(request).rejects.toThrow("ABORTED");
        expect(cancel).toHaveBeenCalledOnce();
    });

    it("does not begin a host request whose owner already stopped", async () => {
        const { hostTransport } = loadAdapter("native/hostUpdater.ts");
        const net = vi.fn(async () => new Response("[]"));
        const abort = new AbortController(); abort.abort();
        await expect(hostTransport(net)("https://api.github.com/fixture", { signal: abort.signal })).rejects.toThrow("ABORTED");
        expect(net).not.toHaveBeenCalled();
    });
});

describe.skipIf(process.platform !== "win32")("Q18 BetterDiscord native startup recovery", () => {
    it("retains repair checks at the bundled version when a verified cache has an incompatible class", async () => {
        const directory = fs.mkdtempSync(join(tmpdir(), "stx-q18-bd-incompatible-")); directories.push(directory);
        const plugins = join(directory, "plugins"); fs.mkdirSync(plugins);
        const config = JSON.parse(source("distribution/config.json"));
        const origin = "https://discord.com";
        const globals = { process: { ...process, platform: "win32" }, location: { origin }, BdApi: { Plugins: { folder: plugins } } };
        const { installationPaths } = loadAdapter("native/paths.ts", {}, globals);
        const binding = createHash("sha256").update(JSON.stringify([config.releaseRepository, config.channel])).digest("hex");
        const runtime = join(installationPaths().root, "updates", binding, "runtime");
        fs.mkdirSync(runtime, { recursive: true });
        const bytes = Buffer.from("module.exports = class IncompatibleRuntime {};");
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        fs.writeFileSync(join(runtime, `${sha256}.plugin.js`), bytes);
        fs.writeFileSync(join(runtime, "runtime.json"), JSON.stringify({ schema: 1, manifest: {
            schema: 1, product: "SupportTemplates", repository: config.releaseRepository, channel: config.channel,
            version: "1.0.1-canary.99", assets: [{ variant: "betterdiscord", platform: "win32", kind: "renderer",
                name: "SupportTemplates.plugin.js", size: bytes.length, sha256 }]
        } }));
        const network = vi.fn((_url, _options, callback) => {
            queueMicrotask(() => callback(Object.assign(Readable.from([Buffer.from("[]")]), { statusCode: 200, headers: {} })));
            return new EventEmitter();
        });
        const { prepareUpdates } = loadAdapter("native/updater.ts", { "node:https": { get: network } }, globals);
        const prepared = await prepareUpdates(() => true, () => {});
        try {
            expect(prepared.Plugin).toBeNull();
            expect(network).not.toHaveBeenCalled();
            // A cache that cannot run must not masquerade as the installed version.
            expect(await prepared.updater.check()).toMatchObject({ status: "up-to-date", version: config.version });
        } finally { await prepared.updater.stop(); }
    });

    it("keeps checks available to quarantine corrupt pending metadata after startup apply fails", async () => {
        const directory = fs.mkdtempSync(join(tmpdir(), "stx-q18-bd-startup-")); directories.push(directory);
        const plugins = join(directory, "plugins"); fs.mkdirSync(plugins);
        const config = JSON.parse(source("distribution/config.json"));
        const origin = "https://discord.com";
        const identity = createHash("sha256").update(JSON.stringify([fs.realpathSync(plugins).toLowerCase(), origin])).digest("hex");
        const binding = createHash("sha256").update(JSON.stringify([config.releaseRepository, config.channel])).digest("hex");
        const staging = join(directory, "SupportTemplates", identity, "updates", binding, "staging");
        fs.mkdirSync(staging, { recursive: true });
        fs.writeFileSync(join(staging, "pending.json"), "{broken");
        const network = vi.fn((_url, _options, callback) => {
            queueMicrotask(() => {
                const body = Readable.from([Buffer.from("[]")]);
                callback(Object.assign(body, { statusCode: 200, headers: {} }));
            });
            return new EventEmitter();
        });
        const { prepareUpdates } = loadAdapter("native/updater.ts", { "node:https": { get: network } }, {
            // The harness injects host JSON, so inject its exception brand too.
            SyntaxError, process: { ...process, platform: "win32" }, location: { origin }, BdApi: { Plugins: { folder: plugins } }
        });
        const events: any[] = [];
        const prepared = await prepareUpdates(() => true, (event: any) => events.push(event));
        try {
            expect(prepared.Plugin).toBeNull();
            expect(network).not.toHaveBeenCalled();
            expect(events.some(event => event.type === "error")).toBe(true);
            expect(await prepared.updater.check()).toMatchObject({ status: "up-to-date" });
            expect(network).toHaveBeenCalledOnce();
            expect(fs.existsSync(join(staging, "pending.json"))).toBe(false);
            expect(fs.readdirSync(staging).some(name => name.startsWith(".invalid-pending-"))).toBe(true);
        } finally { await prepared.updater.stop(); }
    });
});
