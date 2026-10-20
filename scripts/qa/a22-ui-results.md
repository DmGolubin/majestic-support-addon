# A22 diagnostics browser acceptance

Parent follow-up: the file-size finding below was resolved in `.29`.
The native writer now bounds the complete TXT to 512 KiB, removing oldest
events if the envelope would exceed that bound. The fixed campaign deadline is
retained. A new regression verifies a >512 KiB input, bounded output, newest
event retention and unchanged expiry. The relevant 132 tests and root types pass.
The UI source used in this report did not change.

Final run `2026-10-20-source-06`: **115 passed, 0 failed**, Chromium
145.0.7632.6. Thirty screenshots captured. No uncaught browser errors, console
errors, network attempts or source hash changes during this run.

## Evidence and reproduction

```powershell
python -u scripts/qa/a22-ui-regression.py scripts/qa/runs/a22-ui/NEW-RUN
```

Use a new directory; previous evidence is never overwritten.

- [Machine-readable checks, geometry, hashes and limits](runs/a22-ui/2026-10-20-source-06/a22-results.json)
- [Generated report and all 30 screenshots](runs/a22-ui/2026-10-20-source-06/a22-report.md)
- [Exact generated-stub instrumentation](runs/a22-ui/2026-10-20-source-06/a22-instrumentation.json)
- [Q17 source provenance](runs/a22-ui/2026-10-20-source-06/provenance.json)

Only the generated diagnostics stub exposes the real in-memory journal and accepts
a long path override. Existing Q17 script, UI components, core and native sources
were not edited by this browser task. The stub's existing file-failure flag, retry
and download counter drive the UI checks.

## Verified behavior

The same cases pass for `standalone` (Lite), `betterdiscord` and `vencord`
(personal full build):

- Diagnostics is the last settings section, directly after Quick Input.
- The checkbox starts checked, with an explicit four-day default-on notice,
  deadline, automatic-save status, path, privacy and no-upload explanations.
- Switching off stops new events and survives a settings remount. Re-enabling an
  hour later retains the original deadline.
- File-error feedback and retry recover using the storage stub.
- Clear requires confirmation; cancel preserves events; confirm clears events
  without changing the campaign deadline or active preference.
- Manual download success, failure and recovery feedback work.
- Expiry unchecks and disables recording. Recorded campaign history survives
  expiry and another two simulated days, and manual download remains available.
- At **320 × 480** and **427 × 320**, injected long profile paths wrap, containers
  have no horizontal overflow, and clear/retry/download actions remain reachable.

There are 111 UI/state assertions (37 per variant) and four environment assertions.
Playwright's clock is installed before application startup. The test advances time;
it does not wait four days or claim a real multi-day session.

## Visual inspection

Inspected the Lite/full default views, all six narrow path screenshots, the
BetterDiscord file-error view, Lite narrow clear confirmation and full-build
expired state. The diagnostics card follows Quick Input, action buttons wrap at
320px, paths break within the card, and the expired checkbox is visibly disabled.
The narrow dialog scrolls vertically; screenshots show the selected portion of
that scrollable content. Translucent Settings/Menu controls belong to the Q17
fixture, not the product.

- [Lite: default section ordering](runs/a22-ui/2026-10-20-source-06/standalone-default.png)
- [Lite: 320px path](runs/a22-ui/2026-10-20-source-06/standalone-path-320x480.png)
- [Lite: 427px path](runs/a22-ui/2026-10-20-source-06/standalone-path-427x320.png)
- [BetterDiscord: 320px path](runs/a22-ui/2026-10-20-source-06/betterdiscord-path-320x480.png)
- [BetterDiscord: 427px path](runs/a22-ui/2026-10-20-source-06/betterdiscord-path-427x320.png)
- [Personal Vencord: 320px path](runs/a22-ui/2026-10-20-source-06/vencord-path-320x480.png)
- [Personal Vencord: 427px path](runs/a22-ui/2026-10-20-source-06/vencord-path-427x320.png)
- [File error and retry](runs/a22-ui/2026-10-20-source-06/betterdiscord-file-error.png)
- [Narrow clear confirmation](runs/a22-ui/2026-10-20-source-06/standalone-actions-320x480.png)
- [Expired period with manual download](runs/a22-ui/2026-10-20-source-06/vencord-expired.png)

## Read-only integration finding

**P2 — reconcile the complete TXT size contract.** At the reviewed snapshot,
`src/vencord/diagnosticFileNative.ts:9` sets `DIAGNOSTIC_FILE_MAX_BYTES` to 1 MiB;
the requested behavior and three guides promise at most 512 KiB. The journal caps
its compact serialized state at 512 KiB, while `ui/diagnostics.ts` adds metadata,
snapshot and pretty formatting; the native layer then sanitizes and compacts it.
This does not enforce a 512 KiB bound on the complete saved file. Storage tests
also assert the 1 MiB limit. The implementation owner should enforce the agreed
limit on the complete report and test a saturated journal plus snapshot. This is
a source-review finding, not a failure of the mocked browser file writer.

Earlier concerns about a fixed campaign marker, re-enable deadline extension,
expiry retention and UI placement are addressed in the inspected source or in
the successful UI cases above. Cross-process/native ordering, profile isolation,
host capability checks and fallback behavior remain covered by the owners'
native/core tests, not by this fixture.

## Limits and packaging docs

This is source-component acceptance, not a built plugin, installed Discord,
Electron/native IPC, real filesystem delivery or actual browser download test.
All three distribution query values share one source bundle. File paths and
download success are stubs; paths injected for wrapping are not assertions about
the real host's directory. Persistence across a renderer/process restart is not
claimed. Network was disabled and HTTP/WebSocket routes were blocked.

`distribution/INSTALL-RU.md`, `standalone/README.md` and `betterdiscord/README.md`
were updated and frozen before final reporting. They explicitly state that
recording stops at expiry/off while the saved report remains available until
clear. Python syntax, scoped diff checks and roadmap consistency passed.
No product changes, existing QA-script changes, release builds, publication or
commits were performed by this task. The parent owns the full-suite run.

## Earlier attempts

- `source-01`: runner initialization typo; stopped before browser cases.
- `source-02`: 103/106; three expiry assertions used a replacement `Date.now`
  that did not affect the journal's captured clock.
- `source-03`: 105/106; exact millisecond comparison between campaign creation
  and first event was too strict. The final check allows up to one second.
- `source-04`: all 102 UI cases passed; the source-consistency guard detected the
  concurrent journal retention edit.
- `source-05`: expiry retention passed, but an optional 30-day Playwright clock
  jump timed out; the run was stopped. The final run checks a further two days.
- `source-06`: final successful run including retention against unchanged inputs.
