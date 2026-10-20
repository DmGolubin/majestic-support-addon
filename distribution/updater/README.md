# Shared Windows updater — integration contract (schema 1)

`index.cjs` is a dependency-free CommonJS module for Electron's existing Node
runtime. Bundle it into BetterDiscord and Vencord native/main code; never run it
in the web renderer or require an installed Node executable. Version, channel and release repository are defined in `distribution/config.json`.

## Release contract (for the aggregator)

Upload `support-templates-update.json` and the referenced assets to ONE published
GitHub release tagged `v<version>`. Discover releases with the releases LIST API
(including prereleases), never `/latest`. The configured repository must be a
public release repository. `releaseRepository: null` disables network access.
No credentials, environment tokens or GitHub CLI authentication are used.

```json
{
  "schema": 1,
  "product": "SupportTemplates",
  "repository": "OWNER/PUBLIC-RELEASE-REPO",
  "version": "1.0.1",
  "channel": "stable",
  "assets": [
    {
      "variant": "standalone",
      "platform": "win32",
      "kind": "native",
      "name": "SupportTemplates-standalone-1.0.1.zip",
      "size": 123456,
      "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_DIGITS"
    },
    {
      "variant": "vencord",
      "platform": "win32",
      "kind": "native",
      "name": "SupportTemplates-vencord-1.0.1.zip",
      "size": 123456,
      "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_DIGITS"
    },
    {
      "variant": "betterdiscord",
      "platform": "win32",
      "kind": "renderer",
      "name": "SupportTemplates.plugin.js",
      "size": 123456,
      "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_DIGITS"
    }
  ]
}
```

Exactly one asset per variant/platform is allowed; a release can omit variants.
`kind` is `native` or `renderer`. A renderer package additionally MUST declare
`baseVersion` equal to the installed native/base version, except BetterDiscord's
single self-contained plugin file. Use native packages whenever main, preload,
loader or bundled native code changes. A hash is integrity metadata, not an
independent publisher signature: trust rests on HTTPS and write access to the
configured GitHub repository. Publish all assets before publishing the release.
The engine cross-checks tag, prerelease flag, channel, repository, asset name,
GitHub asset size, optional GitHub SHA256 digest, downloaded size and SHA256.
Stable accepts only final semver versions; canary accepts only `-canary.*`.
Semver build metadata does not cause a new update.

## Runtime API (for all three integrations)

```js
const { createUpdater } = require('./updater/index.cjs');
const updater = createUpdater({
  config, // shared config: schema/version/channel/releaseRepository/etc.
  variant: 'standalone', // standalone | vencord | betterdiscord
  // Actual selected installed version; override after renderer updates/fallback:
  currentVersion: config.version,
  baseVersion: config.version,
  // Private, writable, per-installation directory; no symlink/junction ancestors.
  stagingDir: '/absolute/path/to/updater-cache',
  adapter: {
    // Called only at explicit applyPending({ phase: 'startup' | 'app-closed' }).
    // Must check ALL relevant Discord processes, or enforce a real pre-load
    // startup barrier. Return true only if native replacement is safe NOW.
    canApplyNative: async (context) => false,
    // Required. Receives a reverified staged asset; MUST be idempotent.
    // Return { applied: true } ONLY after an atomic durable install completes.
    // Return { applied: false, reason: '...' } to retain the pending update.
    apply: async (context) => ({ applied: false, reason: 'host still running' })
  },
  onEvent(event) { /* show status without automatic reload */ }
});
await updater.applyPending({ phase: 'startup' }); // before loading plugin/runtime
updater.start(); // immediate check+download+stage, then 6h polling with jitter
// On a safe lifecycle callback, await updater.applyPending({phase:'app-closed'}).
// Renderer-only changes can be applied to disk during runtime:
// await updater.applyPending({phase:'runtime'});
// Never reload automatically; offer Ctrl+R only for renderer updates, preserving
// drafts. New code takes effect on the user's reload or next normal launch.
// During unload:
await updater.stop(); // cancels network I/O and waits for in-flight operation
```

`check()` performs discovery/download/staging and returns a status object.
It auto-invokes the required apply hook for renderer assets after staging; native
assets remain pending. `applyPending({phase})` works offline, but only for records
matching the installation's configured repository binding. Setting the repository
to null also disables apply and pending reads. Use a separate staging directory
when changing repositories or variants; old bindings fail closed. `getPending()` reads and
verifies the durable pending record without applying it. All operations serialize
inside an instance and use an exclusive on-disk lock across instances. Errors
reject explicit calls; background polling emits `{type:'error', code}` and retries
at the next interval. Event callbacks cannot break the updater.

Apply context: `{ assetPath, manifest, asset, version, variant, channel, phase }`.
Never trust a renderer-supplied path or arbitrary command over IPC; bind all
options in trusted native code. The engine does not execute downloaded scripts,
extract archives, kill Discord, reload UI, or use the upstream Vencord updater.
Adapters own package validation, transactional install and rollback. In Vencord,
replace only the dedicated SupportTemplates artifact, or install a complete
custom build that preserves the plugin; never call upstream update/rebuild that
can remove the custom plugin. A safe startup barrier must run before native code
is loaded; starting the plugin inside an already-running Discord is not that barrier.

`createFileAdapter({targetPath, canApplyNative?})` from `adapters.cjs` is a real
atomic installer for a single BetterDiscord `.plugin.js` artifact. Other variants
must provide their package-specific adapter. This file adapter defers at runtime,
because BetterDiscord's file watcher may reload a plugin on replacement. Invoke
it at a real startup/closed point, before loading the plugin or opening drafts.
Custom renderer adapters must also defer if their host would hot-reload on write.
Standalone's adapter can invoke the
packaged `SupportTemplates.ps1 -Action Install` only when the target is closed,
or `-Action UpdateRenderer` for a compatible renderer package. Package the entire
installer alongside its payload; Windows PowerShell needs no installed Node.
Keep a pending native update for a trusted launcher/exit helper to consume after
Discord closes. The engine alone cannot execute after its owning process exits.

## Bounds and recovery

Defaults: 6h interval, ±10% jitter, 30s total HTTP request deadline, 5 redirects,
1 MiB manifest, 8 MiB release metadata/page, 256 MiB asset, 3 pages of 100 releases.
Only exact HTTPS GitHub API/repository download URLs and GitHub release CDN
redirect hosts are allowed; credentials, non-default ports, cross-repo URLs and
arbitrary redirect hosts are rejected. CDN URLs are accepted only after a valid
GitHub release download redirect. Downloads stream to exclusive temporary files,
are fsynced and hash-checked before a directory rename atomically publishes a
pending record. Existing pending data survives any failed replacement download.
The asset is rehashed before every apply, including after restart.

An interrupted operation may leave `.work-*` directories or orphan `.owner-*.tmp`
files. Ownership (PID plus random nonce) is fully written and fsynced BEFORE an
exclusive hard link atomically publishes the `.lock` FILE. Release is one atomic
unlink; there is no ownerless active-lock crash window. Use a local filesystem
supporting hard links (normally NTFS on Windows), with user-only write access.

Recovery only removes a lock when `process.kill(pid, 0)` returns `ESRCH` (provably
absent). Live owners, reused PIDs and `EPERM` fail closed. Recovery contenders
serialize on `.recover-<dead-owner-nonce>`, re-read ownership, and delete only the
same dead owner they observed. These recovery mutexes use the SAME atomic owner
protocol, so a crash during recovery is recoverable too. Each lock gets at most
one acquisition retry; a finite chain of dead recovery owners is traversed once,
without sleeps or age-based stealing. Corrupt ownership or cycles fail closed.
Orphan unpublished owner files never block acquisition. No tokens are stored.
Old staged releases and orphan work/owner files can be removed while no updater
is running. The updater never recursively deletes an existing installation.

If a pending record is malformed or its staged artifact is missing, corrupted,
or incompatible with the selected installation, `check()` renames only that
record to `.invalid-pending-<uuid>.json`, emits `cache-invalid`, and continues
normal release discovery. Corrupt asset directories are left untouched; paths
from invalid metadata are never recursively removed. A fresh verified download
can repair the cache immediately. Explicit `getPending()` / `applyPending()`
still reject corruption, preventing the invalid artifact from being applied.

Tests use fake HTTP responses and temporary directories; no release publication,
Discord installation or credential access is needed.

## Return values, packaging and validation

Type declarations live alongside the `.cjs` entrypoints. Import
`distribution/updater/index.cjs` into the trusted native bundle (bundle its local
`validation.cjs`, `transport.cjs`, and `storage.cjs` dependencies; keep Node
builtins external). BetterDiscord may also import `adapters.cjs`. If shipping
unbundled, ship those files together. There are no npm runtime dependencies.
Do not expose `createUpdater` or its configurable adapter across renderer IPC;
expose only narrow status/check methods from the bound native instance.

`check()` returns `disabled`, `unavailable` (anonymous 403/404/429), `up-to-date`,
`variant-unavailable`, `staged` (native), `pending-restart` (existing native),
`pending` (adapter deferred), or `applied`. `applyPending()` can additionally return
`idle`. Status objects include `version` when applicable, `kind` on stage/apply,
`httpStatus` on unavailable, and `reloadRequired` on applied. That field is UI
information only: never interpret it as permission to reload automatically.
Events use `type` instead of `status`; background failures expose a sanitized
`code` and never print request URLs or response bodies. Explicit calls reject
on validation, filesystem, transport and installer failures; integration UI should
handle these and allow a later retry. Observer exceptions are ignored.

The integration must provide the actual selected installed `currentVersion`
(defaults to `config.version` only when that is accurate). A new updater instance
always trusts this version, including after native startup fallback or manual
rollback. A newer `applied.json` receipt is informational and NEVER suppresses a
repair download. Within an instance, successful apply advances its in-memory
version to avoid repeated application while old code is still running. If an
apply completed but pending-record deletion was interrupted, the actual installed
version on restart lets `applyPending()` discard that obsolete pending record.
Adapters must report success only after durable install and remain idempotent
across crashes. Automatic rollback is not performed by this engine.

Discovery examines at most the newest 300 releases and selects the highest semver
in the configured channel that contains the manifest asset. A missing variant or
incompatible renderer base is surfaced instead of silently trying an older
release. Keep a current release for every supported variant within this window.

Run: `node node_modules/vitest/vitest.mjs run tests/distributionUpdater.test.ts`.
The fake transport seam receives `(url, {signal})` and returns
`{status, headers, body: AsyncIterable<Uint8Array>}`. It exercises exactly the same
URL policy, redirect, timeout, size and hash checks as production HTTPS.
