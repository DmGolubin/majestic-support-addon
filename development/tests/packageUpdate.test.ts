import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")("verifies the offline BAT package updater under Windows PowerShell 5.1", () => {
    // PS5.1 otherwise reads Cyrillic source using the system ANSI code page.
    expect([...readFileSync("standalone/installer/PackageUpdate.ps1").subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const shell = path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
    // Node inherits the agent's PowerShell 7 module path. Use PS5.1's built-ins
    // so a same-named PS7 Utility module cannot shadow Get-FileHash.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
    env.PSModulePath = path.join(path.dirname(shell), "Modules");
    const output = execFileSync(shell, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", path.resolve("tests/packageUpdate.Tests.ps1")], { encoding: "utf8", timeout: 90_000, env });
    expect(output).toMatch(/PASS \d+ package updater tests \(offline, Windows PowerShell 5\.1/);
}, 95_000);
