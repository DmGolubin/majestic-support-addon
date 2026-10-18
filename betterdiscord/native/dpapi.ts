// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Fixed program, no interpolation. Secret bytes travel ONLY on stdin/stdout,
// never in argv, environment, logs, scripts on disk or BdApi.Data.
export const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Security
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $inputBytes = [Convert]::FromBase64String($request.data)
    $entropy = [Text.Encoding]::UTF8.GetBytes('SupportTemplates/BetterDiscord/panel-vault/v1')
    if ($request.operation -eq 'protect') {
        $result = [Security.Cryptography.ProtectedData]::Protect($inputBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    } elseif ($request.operation -eq 'unprotect') {
        $result = [Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    } else { throw 'operation' }
    [Console]::Out.Write([Convert]::ToBase64String($result))
} catch { exit 1 }
`;

export function createDpapiCrypto(deps: { platform?: string; executable?: string; spawn?: typeof spawnSync } = {}) {
    const executable = deps.executable ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const spawn = deps.spawn ?? spawnSync;
    let available: boolean | undefined;
    const transform = (operation: string, bytes: Buffer) => {
        const result = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT], {
            input: JSON.stringify({ operation, data: bytes.toString("base64") }),
            encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024,
            stdio: ["pipe", "pipe", "pipe"]
        });
        const output = String(result.stdout ?? "").trim();
        if (result.error || result.status !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) throw new Error("Protected panel storage operation failed.");
        return Buffer.from(output, "base64");
    };
    return {
        isEncryptionAvailable() {
            if (available !== undefined) return available;
            if ((deps.platform ?? process.platform) !== "win32" || !existsSync(executable)) return available = false;
            try {
                const probe = Buffer.from("SupportTemplates DPAPI availability");
                available = transform("unprotect", transform("protect", probe)).equals(probe);
            } catch { available = false; }
            return available;
        },
        encryptString(value: string) { return transform("protect", Buffer.from(value, "utf8")); },
        decryptString(value: Buffer) { return transform("unprotect", value).toString("utf8"); }
    };
}
