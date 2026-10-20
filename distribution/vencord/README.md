# Full Vencord + SupportTemplates (Windows, no installer EXE)

This independent GPL-3.0-or-later distribution builds upstream Vencord commit
`32c90633ce6a95d7e56c95479efbb431bacf1eac` with every ordinary upstream plugin and
the current `src/vencord` + `src/core` plugin. SupportTemplates is enabled by
default; existing explicit plugin preferences win. The native Vencord updater
is compiled out, even if old settings have autoUpdate enabled.

## Integration contract

- Build: `node distribution/vencord/build.mjs`. Parent owns `distribution/config.json`
  and `distribution/updater/*`. Version comes exclusively from shared config.
- Set `VENCORD_DIR` to the pinned frozen dependency checkout, including
  `support-templates-dependency-evidence.json`. Builds use an isolated source
  directory and never alter that checkout or the user's Discord installation.
- Run `node distribution/quickcss/prepare.mjs` and set `QUICKCSS_DEPS_DIR` to
  its returned directory. This separate frozen lock pins Monaco 0.57.0 and
  DOMPurify 3.4.17. QuickCSS retains its existing small data-URL document.
  Its trusted packaged script is executed by the main process after navigation;
  styles and blob workers are bundled. CSP denies document scripts and network
  connections. User CSS is never interpolated into executable code.
  Both Monaco's vendored sanitizer and its package import resolve to the
  pinned DOMPurify; the emitted input hashes are in `build-evidence.json`.
- Default output: `artifacts/distribution/SupportTemplates-vencord-<version>/`
  and matching `.zip`. `DISTRIBUTION_OUTPUT_DIR` overrides the output directory.
  Existing outputs are refused. Last stdout line is JSON `{package,zip,source}`.
- Internal `manifest.json`: schema 1, product `SupportTemplatesVencord`, variant
  **`vencord-full`**, releaseVariant **`vencord`**, version, pinned upstream,
  plugin Git revision plus exact current-source hash, payload size/SHA256 inventory.
- Aggregator asset: variant **`vencord`**, platform `win32`, kind `native`, name
  `SupportTemplates-vencord-<version>.zip`. Never publish a renderer-only update.
- Package root: `VencordFull.ps1`, six BAT wrappers, `manifest.json`, `payload/`,
  `source.tar`, `LICENSE-Vencord`, `build-evidence.json`, this README.
- Commands: `install.bat`, `update.bat`, `repair.bat`, `rollback.bat`, `status.bat`,
  `uninstall.bat`; or `powershell -NoProfile -ExecutionPolicy Bypass -File
  VencordFull.ps1 -Action Install -Channel Canary -WhatIf`.
  Actions are `Install|Update|Repair|Rollback|Status|Uninstall`.
  Without `-Channel`, the installer lists detected Discord and Discord Canary
  installations and asks for a selection. Even one detected client requires
  confirmation; Enter or 0 cancels without changes. `-Channel Stable` or
  `-Channel Canary` explicitly chooses a client without prompting.

## Installation and data

Close the intended Discord client, extract the ZIP, then run install.bat and
choose that client by number. The same picker is used for update, repair,
rollback, status and uninstall when no explicit channel is supplied.
No elevation, Node installation, process killing, login prompt, or installer EXE.
Uninstall restores the original Discord archive and retains settings and caches.
Existing Vencord/BetterDiscord/standalone injections are refused; remove them
using their own installer first. Normal Vencord settings/themes/IndexedDB remain
at their original locations; no settings files are rewritten by these scripts.

Owned runtime cache: `%LOCALAPPDATA%/SupportTemplatesVencord/channels/<channel>/versions/<version>`.
Host ownership files: `resources/support-templates-vencord.json`,
`resources/support-templates-vencord.install.json`, loader `app.asar`, original
`_app.asar`. A transaction journal protects interrupted changes. Repair after a
Discord host update is explicit; upstream automatic repatching is disabled.

## Automatic updates

The packaged shared engine anonymously checks the configured GitHub release
repository and downloads/stages complete native ZIPs. Null repository disables
checks; unavailable/private repositories are nonfatal background errors. No
token is embedded and no authentication prompt is used.

Startup synchronously verifies and loads the already selected native runtime,
before Electron becomes ready. After native initialization, the updater verifies
staged ZIPs, validates paths, rejects duplicate/special ZIP entries and verifies
every package payload hash. It installs a new immutable version directory and
atomically writes the channel's `active.json`, bound to the manually installed
base manifest. The next normal launch uses that version's patcher. Already
running instances retain their old immutable files; no forced reload, quit or
relaunch occurs. Incomplete/invalid updates leave the previous verified runtime usable.
Manually installed upgrades change the base binding and supersede old pointers.
`rollback.bat` restores the previous manually installed base; automatic versions
remain in cache. To select the original base again after an automatic update,
close that Discord channel and rename `active.json` to retain it as a backup.

Local hashes detect corruption; release authenticity relies on HTTPS and the
configured repository's publishing permissions. The package is not a signature.

## Corresponding source and verification

`source.tar` contains the exact modified upstream tree, complete ordinary plugins,
current custom plugin, lockfile, shared updater, installer/build recipes and GPL
license. `vencord-full-build.json` records deterministic source identities.
Extract into a new directory, install Node matching build-evidence.json and
pnpm 11.9.0, run `pnpm install --frozen-lockfile`, prepare the separate QuickCSS
dependencies as above, then run `node rebuild.mjs` with `QUICKCSS_DEPS_DIR` set.
Upstream sources are obtained using `git archive` at the pin, never by copying
the mutable checkout. Build timestamps and ZIP/TAR metadata are fixed; a second
build from identical inputs and tooling produces identical bytes. Dependency
installation needs network/cache; no dependency binaries or credentials ship.

Fixture verification: `node --test --test-concurrency=4 tests/vencordDistribution.node.mjs` and
`powershell -NoProfile -ExecutionPolicy Bypass -File tests/vencordDistribution.Tests.ps1`.
All installer fixtures are marked temporary directories; no live install is tested.
