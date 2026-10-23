// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from "node:child_process";
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
    } elseif ($request.operation -eq 'probe') {
        $protected = [Security.Cryptography.ProtectedData]::Protect($inputBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $result = [Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    } else { throw 'operation' }
    [Console]::Out.Write([Convert]::ToBase64String($result))
} catch { exit 1 }
`;

const MAX_PLAIN = 32 * 1024 + 128; // Includes the vault envelope.
const MAX_ENCRYPTED = 64 * 1024;
const MAX_OUTPUT = 256 * 1024;
const failed = () => new Error("Protected panel storage operation failed.");

export function createDpapiCrypto(deps: { platform?: string; executable?: string; execFile?: typeof execFile } = {}) {
    const executable = deps.executable ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const run = deps.execFile ?? execFile;
    let available = false;
    let initializing: Promise<boolean> | undefined;
    const transform = async (operation: "protect" | "unprotect" | "probe", bytes: Buffer): Promise<Buffer> => {
        if (!Buffer.isBuffer(bytes) || bytes.length > (operation === "unprotect" ? MAX_ENCRYPTED : MAX_PLAIN)) throw failed();
        const input = JSON.stringify({ operation, data: bytes.toString("base64") });
        return new Promise((resolve, reject) => {
            let inputFailed = false, completed = false;
            let child: ReturnType<typeof execFile>;
            try {
                child = run(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT], {
                    encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: MAX_OUTPUT
                }, (error, stdout) => {
                    completed = true;
                    try {
                        if (error || inputFailed || typeof stdout !== "string" || stdout.length > MAX_OUTPUT) throw failed();
                        const output = stdout.trim();
                        if (output.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) throw failed();
                        const result = Buffer.from(output, "base64");
                        if (result.toString("base64") !== output || result.length > (operation === "protect" ? MAX_ENCRYPTED : MAX_PLAIN)) throw failed();
                        resolve(result);
                    } catch { reject(failed()); }
                });
            } catch { reject(failed()); return; }
            // EPIPE can arrive after end() returns. Keep its listener through close,
            // and let execFile's callback drain the bounded child before settling.
            const failInput = () => {
                if (completed || inputFailed) return;
                inputFailed = true;
                try { child.kill(); } catch {}
            };
            try {
                if (!child.stdin) { failInput(); return; }
                child.stdin.on("error", failInput);
                child.stdin.end(input);
            } catch { failInput(); }
        });
    };
    return {
        initialize(): Promise<boolean> {
            return initializing ??= (async () => {
                if ((deps.platform ?? process.platform) !== "win32") return false;
                const probe = Buffer.from("SupportTemplates DPAPI availability");
                try { available = (await transform("probe", probe)).equals(probe); }
                catch { available = false; }
                return available;
            })();
        },
        isEncryptionAvailable() { return available; },
        encryptString(value: string) { return transform("protect", Buffer.from(value, "utf8")); },
        async decryptString(value: Buffer) { return (await transform("unprotect", value)).toString("utf8"); }
    };
}
