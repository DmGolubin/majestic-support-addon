# Standalone Canary: implementation and acceptance

Scope: an isolated, open-source Vencord-based prototype with one user plugin and a local BAT/PowerShell installer. The owner authorized Canary testing and explicitly excluded the working Stable installation. No public publication or GitHub updater is included.

## Composition and isolation

- Pinned Vencord source: `32c90633ce6a95d7e56c95479efbb431bacf1eac`, exported into TEMP without modifying its checkout.
- Renderer registry: SupportTemplates, ChatInputButtonAPI, replacement Settings, ConcatenatedComponentExtractor. Native plugin registry: SupportTemplates only.
- No stock plugin catalog/settings pages, cloud sync, updater, extension loader, or automatic host repatching implementation in the build inputs. A transitive Badges import initially pulled cloud/settings; the build rejected it and the unused import was removed in the isolated source.
- Native files live under `%LOCALAPPDATA%/SupportTemplates/channels/<channel>/`; IndexedDB has a separate database/store name. Loader binds the configured channel to its actual Discord installation and rejects redirected runtime/data paths. Original host paths are checked before either normal or fallback bootstrap.
- Package includes manifest hashes, exact prepared source, pinned lockfile/workspace definition, build recipe, tool versions, licenses and bundle input metadata. Hashes detect corruption; they do not authenticate a release publisher.
- See [dependency review](2026-10-18-standalone-dependencies.md). The full upstream toolchain's 66 advisory records are not claimed fixed by removing runtime modules. Only xxhash64 0.1.2 contributes third-party npm implementation to this bundle; the audit returned no advisory for it.

## Independent review and regressions

The first review blocked real installation. Fixes address:

1. Invalid recovery journals could describe an absent original. Journal validation now checks coherent clean/owned before-and-after states and unchanged original identity; recovery cannot delete `app.asar`.
2. A self-consistent Stable config could be read by a Canary loader. Host-derived channel checks and launch-time redirect checks now precede execution. Redirected original paths abort rather than becoming a fallback destination.
3. Missing cached runtime blocked uninstall and repair. Resource ownership/original validation is separated from runtime health; missing files can be restored from the matching verified package.
4. Uninstall selected only the newest host version. It now preflights and restores all owned app versions within the selected channel, leaving other channels alone.

Partial runtime initialization errors deliberately do not start a second Discord bootstrap. Pre-initialization configuration/runtime failures may fall back only to the validated original. Manual `--vanilla`, repair and uninstall remain recovery paths.

## Validation record

- Core/loader/build suite: 781 tests in 41 files passed; core types and isolated Vencord source types passed.
- Installer agent: 23 broad fixture groups plus 2 focused groups passed on Windows PowerShell 5.1.26100.9711, including real payload, junctions, injected write failures/crashes, recovery, rollback, missing cache and BAT exit codes. Physical power loss was not tested. Multi-version uninstall is transactional per app version.
- Independent reviewer reproduced and then closed all four findings. Parent additionally installed/uninstalled the built payload in a fresh TEMP fixture and verified the real Canary `install.bat -WhatIf` target without writes.
- Implementation commit: `40d5895`. Package `0.1.0-canary.1` was rebuilt from that checkpoint and retained under ignored `artifacts/standalone/0.1.0-canary.1-40d5895/`, with its source archive and metadata.
- Real Canary 1.0.1219: `install.bat`, `status.bat`, `uninstall.bat`, original SHA-256 comparison, and `repair.bat` all passed. Stable hash and its original seven process IDs remained unchanged.
- On launching Canary, Discord's own updater installed 1.0.1251. Its resources were pristine and `status.bat` reported Not installed: the omitted automatic repatching did not silently modify the new version. New original archive SHA-256: `0025C02C7241045A12464309604EC4D5B8EC7ED2CE43CCE05D5DACB8F253F672`.
- After the owner closed only Canary through the tray, repair and status passed on 1.0.1251. Actual startup reported SupportTemplates 0.1.0-canary.1 and all four expected renderer entries started; the native registry contains only SupportTemplates.
- Live UI: the dedicated SupportTemplates entry opens in Discord settings. Personal library, Settings, Connection and Tickets tabs render; the Settings tab and close control were exercised. No stock Vencord plugin catalog is exposed. The chat button/window was not completed: concurrent user interaction interrupted navigation, so further inputs were stopped.
- Read-only native checks: panelVaultAvailable=true; CSP permits the panel origin for connect-src and rejects example.com. No token was read, transferred or written and no authorization was initiated.
- Captured runtime exception: EADDRINUSE on 127.0.0.1:6463, consistent with two Discord clients competing for the RPC listener. No SupportTemplates startup exception was observed. Stable was not stopped to clear the conflict.
- Final Stable archive hash and all seven baseline process IDs remained unchanged; the pinned Vencord checkout remained clean. Canary 1.0.1251 preserved _app.asar with the original hash above.
- This Canary session was started with a temporary loopback CDP listener at 127.0.0.1:47836 for diagnostics. No persistent launch setting was changed. Fully quitting Canary and starting it normally ends that diagnostic listener; the active user session was not interrupted to do so.

Stable baseline: running `Discord/app-1.0.9262`, original observed SHA-256 `11A4BB6D1FA8D09D9E298D064E138DEE909A666A8B12374DB38D341B313C2EF9`. Canary baseline: stopped `DiscordCanary/app-1.0.1219`, original SHA-256 `CBD26748B01C1B4847DC5471C4D2E1E46D69B0EB6F6C3347AA66CA992267E9B8`.

## Release boundaries

- Canary acceptance does not establish Stable or BetterDiscord compatibility.
- Real panel authorization, snapshot and SSE remain unaccepted while access is unavailable. No token or Stable credentials are copied into Canary.
- No signed public release channel or GitHub updater has been implemented here.
- Stock chat-button context-menu integration is omitted; settings remain available through the plugin window and its dedicated settings section.
- Local/demo UI still belongs to this prototype; production permission policy must be enforced before public release as specified in RELEASE-V1.md.
