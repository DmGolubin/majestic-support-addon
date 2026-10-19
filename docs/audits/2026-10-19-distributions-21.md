# Three local .21 distributions

## Scope and provenance

The owner requested full Vencord and the reduced Vencord-based build with the
same file diagnostics as BetterDiscord .21. All three packages were built locally
from `0a126720ef39046312b6b2dd85a785c030e9d83d`. This commit changes task tracking
only; production diagnostics remain the implementation from `2a88a7674cdf`.
No installed Discord client was modified and no GitHub release was published.

The build reused a clean isolated dependency checkout at pinned Vencord commit
`32c90633ce6a95d7e56c95479efbb431bacf1eac`, with pnpm 11.9.0 frozen-lockfile evidence.
The lock SHA-256 is `b970cd78650c55a68d1edd7f6e40f730b53eda809ad209b5b7da56fbc0edd38a`.
The only untracked file in that checkout was its dependency evidence record.

Outputs are under `artifacts/distribution/1.0.1-canary.21/`:

| Variant | File | SHA-256 |
| --- | --- | --- |
| BetterDiscord | `SupportTemplates.plugin.js` | `7bbba2e1824e9539ff499a27248b83e8470d53c26b81f93428e4bbf4a9792bb0` |
| Full Vencord | `SupportTemplates-vencord-1.0.1-canary.21.zip` | `05b0d53642c543912f4816222ca459ab43e57f24ad93b239c32f30f717ee7377` |
| Reduced build | `SupportTemplates-standalone-1.0.1-canary.21.zip` | `98a1c63ba9711154b5155bd4967f88c292a6cb424e1b6f7348b79004ad474fe8` |

Both ZIPs contain BAT/PowerShell installers, sources, licenses, runtime manifests
and hashes. Full Vencord preserves the upstream plugin source files and includes
282 upstream plugin source-map entries (not a count of independently selectable
plugins). The reduced renderer has only two upstream plugin source entries:
ChatInputButtonAPI and ConcatenatedComponentExtractor. Its custom Settings bridge
and SupportTemplates complete the required registry; no optional upstream plugins
or upstream settings/cloud/updater UI are bundled. The reduced compiler validated
216 total source inputs against its feature allowlist.

## Verification

- Release checker: all nine release files, three updater variants and checksums pass.
- 136 targeted tests in seven files pass: diagnostic retention/redaction, runtime
  cleanup, panel cleanup, distribution configuration/naming/release/updater.
- 12 Node Vencord runtime/updater tests pass, including tampering rejection,
  transactional staged apply, rollback and preservation of Electron ready events.
- Both TypeScript checks pass; Vencord uses the read-only virtual source overlay.
- `scripts/qa/check-packaged-diagnostics.mjs`: 49 assertions pass against the two
  final ZIPs. Every payload hash is checked; diagnostic, transport, client, SSE,
  panel and settings sources embedded in the renderer maps match current sources.
  Renderer/preload/main scripts pass Node syntax checks.
- Packaged diagnostic modules were executed from source maps with mock host/state
  dependencies. A parsed synthetic HTTP 401/session_revoked produces a downloadable
  JSON report with status/reason and without the supplied secret token or body.
  Recording/history survive stop/start, flooding stays bounded, disable/clear work,
  and observers/listeners/timers are absent after stop.

- Installer fixtures: **25 full Vencord groups and 40 reduced-build groups pass**
  on Windows PowerShell 5.1.26100.9711. Both suites exercised the actual .21 payload:
  install, read-only status, uninstall and exact original archive restoration.
  Other groups cover interrupted mutations, sharing violations, rollback, hostile
  manifests/junctions, repair after host updates and channel isolation. Reduced
  tests additionally cover renderer-only updates and full-install interaction.

All commands exited successfully. Results are recorded in
`2026-10-19-distributions-21-results.json`. Raw logs and detailed assertions are under
`scripts/qa/runs/distributions21/` (ignored local evidence).

## Tester workflow and limits

Inside SupportTemplates settings, enable **Записывать диагностику на 24 часа**.
After a failure, use **Скачать диагностику** and send the JSON with the approximate
time and observed symptom. The same workflow applies to all three variants;
BetterDiscord additionally offers the controls in its compact native service page.
See [diagnostics-file.md](../diagnostics-file.md) for retention, privacy and error codes.

These are package, isolated module and installer checks, not a claim of acceptance
inside the real Discord webpack/React/Electron host. No live panel API or public
GitHub update delivery was exercised. The repository remains private. The earlier
one-hour memory soak covered .20 BetterDiscord and is not a .21 Vencord soak.
