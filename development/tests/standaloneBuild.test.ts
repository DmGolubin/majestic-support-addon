import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createLoaderAsar } from "../standalone/asar.mjs";

describe("standalone bootstrap archive", () => {
    it("encodes pickle lengths and byte offsets for UTF-8 contents", () => {
        const contents = { "package.json": '{"main":"index.js"}', "index.js": "// проверка\n" };
        const archive = createLoaderAsar(contents);
        expect(archive.readUInt32LE(0)).toBe(4);
        const headerSize = archive.readUInt32LE(4);
        expect(archive.readUInt32LE(8)).toBe(headerSize - 4);
        const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)).toString());
        for (const [name, content] of Object.entries(contents)) {
            const file = header.files[name], start = 8 + headerSize + Number(file.offset);
            expect(archive.subarray(start, start + file.size).toString()).toBe(content);
        }
    });
    it.each(["../index.js", "a/b", "..", "."])("rejects unsafe archive path %s", name => {
        expect(() => createLoaderAsar({ [name]: "x" })).toThrow();
    });
    it("pins one application plugin and explicitly scoped framework helpers", () => {
        const config = JSON.parse(readFileSync(new URL("../standalone/config.json", import.meta.url), "utf8"));
        expect(config.product).toBe("SupportTemplates");
        expect(config.rendererPlugins).toEqual(["SupportTemplates", "ChatInputButtonAPI", "Settings", "ConcatenatedComponentExtractor"]);
        expect(config.nativePlugins).toEqual(["SupportTemplates"]);
        expect(config.upstreamCommit).toMatch(/^[0-9a-f]{40}$/);
        expect(config).not.toHaveProperty("version");
    });
});
