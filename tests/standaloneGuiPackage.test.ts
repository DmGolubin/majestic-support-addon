import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { copyInstaller } from "../standalone/package-installer.mjs";

describe("Lite GUI package", () => {
    it("ships GUI alongside retained CLI while leaving the payload and manifest untouched", () => {
        const output = mkdtempSync(join(tmpdir(), "stx-gui-package-"));
        try {
            mkdirSync(join(output, "payload"));
            writeFileSync(join(output, "payload", "loader.asar"), "owned payload");
            writeFileSync(join(output, "manifest.json"), "owned manifest");
            const source = fileURLToPath(new URL("../standalone/installer", import.meta.url));
            copyInstaller(source, output);
            for (const name of readdirSync(source)) expect(readFileSync(join(output, name))).toEqual(readFileSync(join(source, name)));
            expect(readFileSync(join(output, "payload", "loader.asar"), "utf8")).toBe("owned payload");
            expect(readFileSync(join(output, "manifest.json"), "utf8")).toBe("owned manifest");
            const bat = readFileSync(join(output, "install.bat"), "utf8");
            expect(bat).toContain('if not "%~1"=="" goto cli');
            expect(bat).toContain('-STA -WindowStyle Hidden');
            expect(bat).toContain('SupportTemplates.Gui.ps1');
            expect(bat).toContain('SupportTemplates.ps1" -Action Install %*');
            // Windows PowerShell 5.1 must decode Russian strings independently of system ANSI code page.
            for (const name of ["InstallerGui.psm1", "SupportTemplates.Gui.ps1"]) {
                expect([...readFileSync(join(output, name)).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
            }
        } finally {
            expect(dirname(output)).toBe(tmpdir().replace(/[\\/]$/, ""));
            rmSync(output, { recursive: true });
        }
    });
});
