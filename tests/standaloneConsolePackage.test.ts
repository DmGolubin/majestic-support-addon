import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { copyInstaller } from "../standalone/package-installer.mjs";

const launchers = ["install.bat", "uninstall.bat"];
const helpers = ["SupportTemplates.ps1", "RendererUpdate.ps1", "PackageUpdate.ps1", "ConsoleInput.ps1", "Migration.ps1"];
function withFixture(run: (source: string, archive: string, output: string) => void) {
    const root = mkdtempSync(join(tmpdir(), "stx-console-package-"));
    const source = join(root, "inputs"), archive = join(root, "archive"), output = join(archive, "SupportTemplates");
    try {
        mkdirSync(source);
        mkdirSync(join(output, "payload"), { recursive: true });
        writeFileSync(join(output, "payload/loader.asar"), "owned payload");
        writeFileSync(join(output, "manifest.json"), "owned manifest");
        writeFileSync(join(output, "LICENSE-Vencord"), "preserved upstream license");
        writeFileSync(join(output, "source.tar"), "corresponding modified sources");
        const production = fileURLToPath(new URL("../standalone/installer", import.meta.url));
        for (const file of launchers) copyFileSync(join(production, file), join(source, file));
        for (const file of helpers) writeFileSync(join(source, file), `# Fixture ${file}`);
        writeFileSync(join(source, "SupportTemplates.Gui.ps1"), "obsolete UI");
        writeFileSync(join(source, "unrelated.ps1"), "not distributable");
        run(source, archive, output);
    } finally {
        expect(dirname(root)).toBe(tmpdir().replace(/[\\/]$/, ""));
        rmSync(root, { recursive: true });
    }
}

describe("SupportTemplates console package", () => {
    it("keeps the compact layout, required migration helper and GPL materials", () => {
        withFixture((source, archive, output) => {
            copyInstaller(source, output);
            expect(readdirSync(archive).sort()).toEqual(["SupportTemplates", ...launchers]);
            expect(readdirSync(output).sort()).toEqual([
                ...helpers, "LICENSE-Vencord", "source.tar", "manifest.json", "payload"
            ].sort());
            expect(readFileSync(join(output, "payload/loader.asar"), "utf8")).toBe("owned payload");
            expect(readFileSync(join(output, "manifest.json"), "utf8")).toBe("owned manifest");
            expect(readFileSync(join(output, "LICENSE-Vencord"), "utf8")).toBe("preserved upstream license");
            expect(readFileSync(join(output, "source.tar"), "utf8")).toBe("corresponding modified sources");
            for (const file of launchers) expect(readFileSync(join(archive, file))).toEqual(readFileSync(join(source, file)));
            for (const file of helpers) {
                expect(readFileSync(join(output, file))).toEqual(readFileSync(join(source, file)));
            }
        });
    });
    it("refuses a directory disguised as the required migration helper", () => {
        withFixture((source, _archive, output) => {
            rmSync(join(source, "Migration.ps1"));
            mkdirSync(join(source, "Migration.ps1"));
            expect(() => copyInstaller(source, output)).toThrow("Missing installer entry: Migration.ps1");
            expect(existsSync(join(output, "Migration.ps1"))).toBe(false);
        });
    });
    it("refuses a missing required migration helper before writing any launcher or helper", () => {
        withFixture((source, archive, output) => {
            rmSync(join(source, "Migration.ps1"));
            expect(() => copyInstaller(source, output)).toThrow("Missing installer entry: Migration.ps1");
            expect(readdirSync(archive)).toEqual(["SupportTemplates"]);
            for (const file of helpers) expect(existsSync(join(output, file))).toBe(false);
            writeFileSync(join(source, "Migration.ps1"), "# migration fixture");
            copyInstaller(source, output);
            expect(readFileSync(join(output, "Migration.ps1"), "utf8")).toBe("# migration fixture");
        });
    });
    it("copies every required production helper byte for byte", () => {
        withFixture((_source, _archive, output) => {
            const production = fileURLToPath(new URL("../standalone/installer", import.meta.url));
            copyInstaller(production, output);
            for (const file of helpers) {
                expect(readFileSync(join(output, file))).toEqual(readFileSync(join(production, file)));
            }
        });
    });
});
