# Three Windows distributions — 19 October 2026

## Authorized scope

The owner requested current BetterDiscord, full Vencord including ordinary plugins,
and a separate Vencord-based build with only SupportTemplates. The two Vencord
installers use BAT/PowerShell, with no installer EXE. All variants use one GitHub
Releases feed. The owner will make `skyjacc/support-templates` public later;
this task prepares locally and must not publish, change visibility or install.

## Implementation

- `betterdiscord/`: shared current UI/core bundled with BdApi host adapters, native
  panel transport and protected Windows session persistence; no historical stub.
- `distribution/vencord/`: complete pinned Vencord with ordinary plugins plus
  SupportTemplates, native upstream updater disabled, transactional installer,
  immutable runtime selection before native startup.
- `standalone/`: reduced runtime plus common updater and a hidden helper that
  waits for the target Discord channel to close before installing a verified ZIP.
- `distribution/updater/`: anonymous GitHub Releases discovery including canary,
  version/channel/variant checks, bounded HTTPS, SHA-256, atomic staging and locks.
- BetterDiscord applies cached updates before mounting its UI, outside the watched
  plugin folder. It does not replace that file while a user edits a draft.
- `distribution/build-release.mjs`, `publish-release.mjs` and the manual Actions
  workflow generate/verify one release set. Local build never publishes; maintainer
  publication defaults to draft. Source archives and licenses accompany packages.

## Review corrections

Independent review identified interrupted lock publication, corrupt pending cache
blocking discovery, and stale success receipts masking an actual runtime fallback.
The common engine now atomically publishes a complete lock owner, recovers dead
owners, quarantines damaged pending records and trusts the selected runtime version.
Standalone also checks installed versions under the installer mutex before applying,
so a stale helper cannot downgrade a newer manual installation or reinstall an
uninstalled client. These paths have targeted regression coverage.

## Dependency provenance

Prepared an isolated checkout of Vencord
`32c90633ce6a95d7e56c95479efbb431bacf1eac` and installed its dependencies with
`pnpm@11.9.0 install --frozen-lockfile` (561 packages).
Pinned lock SHA-256:
`b970cd78650c55a68d1edd7f6e40f730b53eda809ad209b5b7da56fbc0edd38a`.
This replaces reliance on the existing Vencord dependency directory for this release.
The prior upstream maintenance advisories are not claimed fixed.

## Validation and limits

Final frozen source: `d3ab8bc76a55e163d7189b6a71a45bb5661c8387`.
Release folder: `artifacts/distribution/0.1.0-canary.14/`.

- 1,584/1,584 Vitest tests, 72 files, zero failures or pending tests.
  Full machine-readable report: `2026-10-19-three-distributions-tests.json`.
- Core TypeScript and Vencord virtual-overlay TypeScript passed.
- 12/12 full Vencord Node runtime tests passed, including offline staged apply,
  Electron ready-event preservation and future upstream commit acceptance.
- Full Vencord agent covered 25 installer fixture groups, including actual-package
  install/status/uninstall. Standalone helper: 11 PowerShell fixture tests passed.
- Parent repeated actual **final** standalone and Vencord package install/status/
  uninstall in TEMP fixtures; original archives restored exactly. Both passed.
- All three final builders succeeded. Reduced runtime: 210 inputs; forbidden
  plugin/features check passed. Full build preserves ordinary upstream plugins.
- Release verifier accepted all nine release files, all variant manifests and hashes.
- Independent reviewer confirmed all three updater findings corrected.
- Graphify AST update completed; no semantic/API-cost run.

Final main assets (SHA-256):

| Asset | SHA-256 |
|---|---|
| `SupportTemplates.plugin.js` | `68777dc2fe3bea095af0bdc31ec4f672f48833be4e891e87e80cc8e567adcd95` |
| `SupportTemplates-betterdiscord-0.1.0-canary.14.zip` | `7f993016d09dfbf45430f77df27f9128d879b887b1376260fd324b922de3370a` |
| `SupportTemplates-vencord-0.1.0-canary.14.zip` | `77729e0409f5d07732ca26c39d7cd3f1b3d1e373bc6bdee0c54dd5e53602d151` |
| `SupportTemplates-standalone-0.1.0-canary.14.zip` | `4a64634db325f5fa41c58d5eec0921140617d5a4a65f8078ecc20f11a4ddc38c` |

The existing Canary `.13` is not changed by this work. Local packages are ready
for per-platform acceptance; public release remains unpublished by owner request.

No GitHub release was published, and private anonymous 404 handling is exercised
with transport fixtures. Live public delivery, real BetterDiscord/full Vencord
host compatibility, login/SSE/audio and update/rollback acceptance remain separate.
There is no claim that generated packages passed real Discord acceptance merely
because build, DOM harness, fixture installers or unit tests passed.
