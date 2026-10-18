# Coordinator evidence and integration

Cycle 18–19 October 2026, Europe/Bucharest. Baseline `65a78b7`; local candidate `.13`. Installed renderer `.12`/native `.6` was not modified. Actual agents and roles are recorded in `agents.json`; one failed capacity launch was replaced, not counted as evidence.

## Q09 — P2 failed local storage read

Before: `index.tsx` awaited `realStore.load()` without handling rejection, so it never mounted the interface when IndexedDB rejected. `Store` accepted subsequent writes using default/unread state. The issue is failure recovery, not proof of the owner's original authorization delay.

Evidence: the actual baseline Store source was temporarily extracted and executed by the new recovery tests. Both current-key and legacy-key read-failure cases produced two writes after the failed read; a pending-read case produced one. All three failed the desired zero-write assertion. Temporary source/test copies were removed afterward. No actual IndexedDB or user data was touched.

Fix: coalesce pending reads, block local preference/catalog writes while reading or after failure, and only unlock after successful reading. Startup continues to mount the recovery interface. Settings shows an explicit retry; successful reread restores stored values. Existing account-scoped panel preferences remain separately routed. Relevant source: `src/core/state.ts`, `src/vencord/index.tsx`, `src/vencord/ui/LocalStorageNotice.tsx`, `Settings.tsx`. Regressions: `tests/storageRecovery.test.ts`, `demoLifecycle.test.ts`, independent `masterReact.test.ts`.

Checks: three recovery cases verify unread data is not overwritten, failed imports are rejected, retry restores a stored prefix and permits a later write, repeated retry shares one read. Entry-point VM verifies mounting after rejection, stop during loading and overlapping start/stop fences. Ten complete enable/disable cycles balance ten mounts/unmounts, host append/removals and identical key-handler add/remove pairs without modifying the seeded data. The React hook harness verifies notice subscriptions and retries; it does not prove actual browser IndexedDB availability or OS-crash durability. An indefinitely pending host read is not solved by this change.

## Browser / visual evidence

Local URL `http://127.0.0.1:47835`, real React 18 DOM and actual production Management/Settings/PersonalEditor/TicketSettings/CSS, synthetic panel/storage/Discord boundaries. Browser harness build imports local source; no production HTTP was called. Custom-sound actions and reminder responses are simulated and do not establish audio/network acceptance.

Executed:

- 100 open/close cycles through DOM button handlers with animation-frame settling; each close removed the dialog, each reopen created exactly one; zero captured page errors. Prior slow actionability-loop invocation was interrupted with no result; it contributes no pass count. An additional ordinary Playwright click open/close pair succeeded.
- Settings, Tickets and My Templates at 900×675, 360×640 and 320×480: no document horizontal overflow; no dialog button outside viewport width. Corresponding dialog bounds: (20,20,860,635), (8,8,344,624), (8,8,304,464).
- New template with 40-line body and dirty-close confirmation: close actions have 8px horizontal gap at 900/360px; at 320px they wrap with 8px vertical gap. No horizontal overflow. Textarea may extend beyond a scrollport's geometry; containment comes from the clipping ancestor, not its raw DOMRect alone.
- At 900×675, editor body overflow is `auto` with bottom 597; footer action top 610, bottom 642; management bottom 655. No text is drawn behind the footer in [captured image](editor-900x675.png), visually inspected by coordinator.
- At 360×541, 360×540 and 320×480, Save was scrolled into view, fully inside viewport and center-point hit testing returned that button. No horizontal overflow. This exercises the short-window scrolling-owner breakpoint.
- Recovery alert was visible in the harness; clicking Repeat reading removed it, with no horizontal overflow at 360×640. This uses synthetic recovery state, not IndexedDB.

The screenshot includes faint harness-only Settings/Menu controls outside the dialog. It is not a Discord screenshot. Live theme/forced-colors/OS-IME/screen-reader checks remain pending; role13 lists concrete future fixtures. No claim of 100 physical mouse interactions, heap-leak absence, or complete host lifecycle stress follows from these checks.

## Integration checks

- Initial full suite: 1425/1426 pass, one new near-million-character Markdown VM deadline failure; [raw result](full-suite-initial.json). Single-worker repeat: 28/28 pass, 746ms total test execution. Independent role19 confirms bounded scaling and baseline failure, and increases only that maximal-input deadline to 5s; smaller regression remains 1s. [Independent review](Report19.md).
- Native TEMP fixture: `powershell -NoProfile -ExecutionPolicy Bypass -File tests/standaloneInstaller.Tests.ps1 -Only 'latest numeric app version and repair after Discord update'` — 1 group passed, PowerShell 5.1.26100.9711. No real Discord paths were targets.
- Final combined tests, typechecks, graph refresh, package/manifest and real-payload fixture results are recorded in the master report when complete. Individual role counts overlap.

## Explicit outstanding work

The original first uncertain save lacks its HTTP/status/response evidence. The later success does not prove its root cause; immutable retries and conflict tests protect recovery but do not diagnose that incident. Likewise no live timing after website authorization was measured in this cycle. Source fixes are not silently installed. Native loader upgrade needs a full stopped-client installation, while renderer-only patches normally load with Ctrl+R; this candidate contains both kinds.

Dependency tree provenance and upstream tooling advisory review remain separate release gates. No blind package update or public release was performed. BetterDiscord is planned, not tested. The finite audit ends after documented integration and candidate checks, rather than adding speculative features.
