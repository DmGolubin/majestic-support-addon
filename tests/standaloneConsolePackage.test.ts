import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { copyInstaller } from "../standalone/package-installer.mjs";

describe("Lite console package", () => {
    it("exposes two launchers with service files in one directory and preserves payload", () => {
        const root = mkdtempSync(join(tmpdir(), "stx-console-package-"));
        const output = join(root, "SupportTemplates");
        try {
            mkdirSync(join(output, "payload"), { recursive: true });
            writeFileSync(join(output, "payload", "loader.asar"), "owned payload");
            writeFileSync(join(output, "manifest.json"), "owned manifest");
            const source = fileURLToPath(new URL("../standalone/installer", import.meta.url));
            copyInstaller(source, output);
            expect(readdirSync(root).sort()).toEqual(["SupportTemplates", "install.bat", "uninstall.bat"]);
            expect(readdirSync(output).sort()).toEqual([
                "PackageUpdate.ps1", "RendererUpdate.ps1", "SupportTemplates.ps1", "manifest.json", "payload"
            ]);
            expect(readFileSync(join(output, "payload/loader.asar"), "utf8")).toBe("owned payload");
            expect(readFileSync(join(output, "manifest.json"), "utf8")).toBe("owned manifest");
            for (const file of ["install.bat", "uninstall.bat"]) {
                expect(readFileSync(join(root, file))).toEqual(readFileSync(join(source, file)));
            }
        } finally {
            expect(dirname(root)).toBe(tmpdir().replace(/[\\/]$/, ""));
            rmSync(root, { recursive: true });
        }
    });
});
