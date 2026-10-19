# BetterDiscord packaged-version rejection

User's `.16` reports «Для подключения нужна новая версия плагина». No panel requests are visible in renderer DevTools. The BD transport uses native Net.fetch, so the renderer Network tab is not evidence of no request; requesting `/me` from that tab was an unsuitable diagnostic for this host.

Two confirmed causes:

1. `supportsVersion()` in the shared panel controller accepted only numeric x.y.z. Every canary distribution failed even against an equal/lower minimum.
2. Source client version was deliberately raised to 1.0.0 for the delivered API contract (`docs/contracts/panel-2026-10-18/discord-plugin-api.md`, earlier audit `2026-10-18-panel-client.md`). Distribution packaging then replaced that with 0.1.0-canary.N. This was below the contract minimum even with a correct comparator.

Fix: shared full SemVer comparator, preserving stable/prerelease precedence, numeric identifier ordering, metadata neutrality and fail-closed malformed versions. Distribution version is now `1.0.1-canary.17`: a patch prerelease following the supported v1 client baseline. No server minimum, authorization or permission gate was removed; 1.0.1 stable and later minima still reject this prerelease.

Regression evidence: a controller test using the actual distribution version failed on `.16` with the exact Russian error. After the fix the final bundled BD file, running under restricted require and bridge-shaped fs/Net, restored a real encrypted IndexedDB fixture and rendered FAQ with minimumPluginVersion=1.0.0 without device authorization. Unit tests cover old releases, canary ordering, metadata, malformed values, large numeric identifiers and future server minima. Full suite: 1631 tests in 74 files passed, report `2026-10-19-betterdiscord-version-tests.json`; core and read-only Vencord overlay typechecks passed. Graphify AST refreshed.

The exact live `/me` minimum was not read. Live acceptance remains required. The repair targets the delivered API contract and the locally reproduced failure, not an assertion that current production settings were independently confirmed. Existing Discord installations were not modified; only a BetterDiscord replacement release is prepared. Published `.16` assets remain immutable.
