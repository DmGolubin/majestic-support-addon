# BetterDiscord .16 — persistent login and automatic updates

Scope: complete the standard BetterDiscord functions deliberately disabled in `.15`. Installed Vencord/standalone clients remain unchanged.

## Implementation

- `browserVault.ts`: WebCrypto AES-256-GCM, nonextractable per-account keys and encrypted records persisted in IndexedDB strict transactions. AAD binds origin, normalized canonical installation path and account. A Web Lock covers the entire vault session, including network refresh-token rotation; accepted writes drain before close. Corruption, failed commits and failed deletion propagate sanitized errors. Logout deletes key and ciphertext. Initialization unavailable/busy falls back to the existing honestly labeled session-only UI.
- This is **profile-local encryption**, not DPAPI/safeStorage. The key is persisted with ciphertext; malicious code executing in the same origin can use it. No plaintext token in BdApi.Data, files, logs or updater traffic. A clear of Discord profile storage loses the login. The native-capable backend remains unchanged.
- `hostUpdater.ts`: supported BD Net + sync filesystem + Web Locks. Uses shared channel/version/manifest/URL/size/hash validation. Anonymous checks on startup and every six hours. GitHub redirects are followed manually only through allowed release/CDN URLs, with byte limits and cancellation deadlines. Downloads write hash-named runtime files outside the watched plugins directory; atomic receipt rename commits the next runtime. Every startup revalidates bytes before the BD absolute-path module loader sees them. No runtime reload or watched plugin replacement.
- BD has no fsync API: OS crashes may lose a recent cache write. Invalid cache falls back to the bundled runtime, then downloads again. No claim of native-filesystem durability. An incompatible runtime export falls back before mounting the shared UI.
- Independent review found Electron drops custom Error.code on filesystem failures. First-use path checks now use existsSync, retaining canonical-path checks; fixtures rethrow bridge-style errors without code and alias lstat to stat.

## Evidence

1606 tests in 74 files passed; report: `2026-10-19-betterdiscord-persistence-tests.json`. After retaining the native dangling-symlink guard, all 37 affected tests passed, including its new regression test. Root typecheck and scoped DOM/native adapter typechecks passed. Expected negative-test error logs are not failures. Graphify AST update completed.

New tests cover:
- Real WebCrypto with fake-indexeddb, nonextractable key serialization, restart, per-account/origin/installation binding, ciphertext tampering, queue/close/reopen, concurrent owners, rejected transactions and durable logout.
- PanelClient restore without device authorization, refresh-token rotation, restart with rotated credentials, logout and crash-rotation marker behavior.
- Final bundled plugin under restricted require and BD-shaped fs/Net APIs: initial download leaves editor/runtime unchanged; the next start loads the verified cached class. No unsupported module probes.
- Anonymous 404, blocked foreign redirects, permitted CDN redirects, oversized/wrong-hash payloads, foreign manifest, symlink/junction cache rejection, cancellation, interval retry and corruption fallback.

Primary host implementation inspected: [filesystem bridge](https://github.com/BetterDiscord/BetterDiscord/blob/development/src/electron/preload/api/filesystem.ts), [Net fetch](https://github.com/BetterDiscord/BetterDiscord/blob/development/src/electron/preload/api/fetch.ts), [restricted module loader](https://github.com/BetterDiscord/BetterDiscord/blob/development/src/betterdiscord/polyfill/module.ts), [Electron context-bridge errors](https://github.com/electron/electron/blob/main/docs/api/context-bridge.md#parameter--error--return-type-support).

## Acceptance remaining

No live BetterDiscord installation was controlled or real panel credentials read. User acceptance: one-time .16 installation, authorize once, Ctrl+R, full restart, logout and restart. Public GitHub delivery requires the owner to make `skyjacc/support-templates` public and publish a later compatible canary release with the manifest. Repository remains private; no employee GitHub-token workaround is introduced. D13 remains review until these live checks are confirmed.

Published BetterDiscord-only prerelease: https://github.com/skyjacc/support-templates/releases/tag/v0.1.0-canary.16 . Source commit `0f3907ed96ee783698e17d01b57f35ed0700d166`; final plugin SHA-256 `255adac7a3a1b4d953de86ec712b6b9123e0a4a8865ca125cbcb4d47916d44db`. Exact packaged file loaded with restricted require and reported `.16`. All six uploaded asset sizes/digests matched locally before publishing; GitHub confirmed non-draft prerelease. Release includes exact-source ZIP, install notes, manifest and checksums. Installed clients and repository visibility unchanged.
