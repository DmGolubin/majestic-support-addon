# Canary .13 — authorized local installation

On 19 October 2026 (Europe/Bucharest), the owner explicitly requested installing `.13` and confirmed Canary was closed. No DiscordCanary process was found before installation.

Package: `artifacts/standalone/0.1.0-canary.13-e8d089b/SupportTemplates-0.1.0-canary.13`, source commit `e8d089bda0a83fc3539ec8c8ef88e9d6db801db6`. All ten payload sizes and SHA-256 hashes matched the package manifest immediately before installation.

Before: package Status confirmed native `.6`, renderer overlay `.12`, Canary host `app-1.0.1251`. Ran the packaged `SupportTemplates.ps1 -Action Install -Channel Canary`; exit 0, `Install complete: SupportTemplates 0.1.0-canary.13 (canary)`.

After: packaged Status exited 0 and confirmed installed `.13` at `C:/Users/oblako/AppData/Local/DiscordCanary/app-1.0.1251/resources`; no previous renderer overlay was reported. Launched that host's `DiscordCanary.exe` for the owner's requested live check. Processes and a native window were observed afterward. Ordinary Discord was not targeted.

This records successful installation/status and process/window startup, not visual acceptance or a production API/session/audio test. The owner will verify the actual interface, login, editing and sound. Prior Master QA limits, including build dependency-tree attestation and upstream maintenance exposure, remain open. The earlier audit describes its pre-installation snapshot and is retained unchanged.
