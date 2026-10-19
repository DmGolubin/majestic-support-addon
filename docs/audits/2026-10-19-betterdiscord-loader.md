# BetterDiscord loader compatibility correction

User reported `ENOENT ... Discord/app-1.0.9262/node:https` at plugin evaluation. The final `.14` bundle reproduced the same error in a test loader exposing only BetterDiscord's documented/implemented polyfills. Earlier tests delegated unknown names to Node's real require and therefore missed the incompatibility.

Primary sources inspected in BetterDiscord's upstream implementation:
- [Renderer require switch](https://github.com/BetterDiscord/BetterDiscord/blob/development/src/betterdiscord/polyfill/index.ts)
- [Module file resolution](https://github.com/BetterDiscord/BetterDiscord/blob/development/src/betterdiscord/polyfill/module.ts)
- [Supported streaming Net bridge](https://github.com/BetterDiscord/BetterDiscord/blob/development/src/betterdiscord/modules/net.ts)
- [Native fetch redirect/TLS/abort handling](https://github.com/BetterDiscord/BetterDiscord/blob/development/src/electron/preload/api/fetch.ts)

Root cause: BD is not a native Node renderer. Its require switch recognizes bare names; `https` is a legacy get-only shim, `stream`, `child_process` and `fs/promises` are unavailable, and its fs/crypto shims lack operations required by our native updater and encrypted vault. Removing only the node prefix would just expose the next startup failure.

Changes:
- BD build resolves node-prefixed imports to bare names; other platform builds are unchanged.
- Panel requests use `BdApi.Net.fetch`, retain fixed endpoint/header/body limits, enforce no redirects/TLS verification and stream through shared bounded JSON/SSE consumers.
- Native storage/updater implementation is lazy and capability-gated before any unsupported import. The restricted-host fixture verifies no unsupported module is even probed while loading, starting and opening settings.
- Standard BD uses the existing session-only login path. No plaintext fallback or OS bridge bypass was introduced. Settings explicitly report manual plugin updates.
- Existing native-host vault/updater tests remain, including encrypted disk storage and verified cached runtime selection.

Validation: old final bundle failed exactly with `ENOENT ... node:https`; replacement Net tests failed against the old implementation. After the fix, all 1586 Vitest tests in 72 files and `npm run typecheck` passed. Full output is in `2026-10-19-betterdiscord-loader-tests.json`; expected negative-test logs are present but no failed/pending tests. AST graph refreshed (3273 nodes, 6358 edges).

Release preparation: `.15` is a BetterDiscord-only hotfix, with source/config version bumped together for future builds. Installed/published Vencord and standalone `.14` are unchanged. Published `.14` bytes are not overwritten. No live BD window or real user panel login was controlled; acceptance on the user's host is still pending.

Correction to previous readiness claims: automatic file updates and protected persistent login are **not implemented for standard BetterDiscord's restricted host**, even after making the repository public. Their native-host implementation and Node-based tests do not prove standard BD support. This remains outstanding in D09; D12 covers loading and panel transport compatibility.

Published BD-only prerelease: https://github.com/skyjacc/support-templates/releases/tag/v0.1.0-canary.15 . Source commit `aaf2041ddb96e70b84cccfaca4627b2bbeb4cca8`. The final packaged file was separately evaluated using a restricted require and reported `.15`. Plugin SHA-256: `5cfb8025db710d6c581c8bf5d1d612d3a2a7e5b9aa4f01db005fdbf055ad1b1b`. All six uploaded files' sizes and GitHub SHA-256 digests matched the local release directory before publishing; GitHub confirmed non-draft prerelease. The manifest includes only BetterDiscord. The ZIP includes corresponding sources/license. Repository visibility was not changed; installed Discord instances were not modified.
