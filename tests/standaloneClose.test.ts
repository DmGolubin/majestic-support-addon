import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")("closes only validated selected process doubles under Windows PowerShell 5.1", () => {
    const shell = path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
    env.PSModulePath = path.join(path.dirname(shell), "Modules");
    const output = execFileSync(shell, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", path.resolve("tests/standaloneClose.Tests.ps1")], { encoding: "utf8", timeout: 30_000, env });
    expect(output).toContain("Passed 11 native close process-double tests.");
}, 35_000);

it.skipIf(process.platform !== "win32")("closes real isolated Windows processes and accepts an exited snapshot", () => {
    const shell = path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
    env.PSModulePath = path.join(path.dirname(shell), "Modules");
    const output = execFileSync(shell, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", path.resolve("tests/standaloneCloseWindows.Tests.ps1")], { encoding: "utf8", timeout: 30_000, env });
    expect(output).toContain("PASS real selected processes close; unrelated installation stays running");
    expect(output).toContain("PASS exited Windows process snapshot permits installation");
}, 35_000);
