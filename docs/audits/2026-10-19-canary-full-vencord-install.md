# Full Vencord .14 in Canary

The owner initially requested the full Vencord variant in ordinary Discord, then explicitly changed the target to **Canary**. Stable was inspected and its existing development Vencord loader/original Discord archive backed up; no Stable installation/uninstallation occurred. Both Stable archive hashes were unchanged afterward.

Validated the final `SupportTemplates-vencord-0.1.0-canary.14.zip` SHA-256 (`77729e0409f5d07732ca26c39d7cd3f1b3d1e373bc6bdee0c54dd5e53602d151`) and all 35 payload sizes/hashes. Extracted package: `artifacts/distribution/install-vencord-0.1.0-canary.14/SupportTemplates-vencord-0.1.0-canary.14`.

Canary was closed when the target changed. Standalone Status confirmed `.14` on `app-1.0.1251`. Ran its packaged `SupportTemplates.ps1 -Action Uninstall -Channel Canary`, which restored Discord's original archive and retained settings/runtime versions. Ran the full package's `VencordFull.ps1 -Action Install -Channel Canary`; exit 0. Its Status then exited 0 and reported `full Vencord + SupportTemplates 0.1.0-canary.14, canary`.

Started `DiscordCanary/app-1.0.1251/DiscordCanary.exe`. Installation and process/window startup were verified; live plugin-list, UI, API, sound and account acceptance are still for the owner. This replaces the standalone variant only in Canary. Source and published `.14` binaries are unchanged; no new release or application test run was needed.
