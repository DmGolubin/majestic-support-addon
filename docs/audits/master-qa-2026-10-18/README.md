# Master QA — SupportTemplates

Cycle started 18 October and continued 19 October 2026 (Europe/Bucharest). Baseline `65a78b7`; installed renderer `.12`, native `.6`. This report concerns the local source candidate. No installation, publication, production API write, real credential read or Discord message was performed.

## AUDIT SUMMARY

Twenty independent roles completed in waves of at most six; [agent roster](agents.json). Role07 was restarted after a model-capacity error; that failed launch contributes no audit evidence. Twenty-two distinct source defects have local fixes, including two historical P1s; one dependency-provenance gap remains open. Upstream maintenance advisories are tracked separately. [Final independent review](20.md) found no further confirmed product defect. Local `.13` candidate built from committed source `e8d089bda0a83fc3539ec8c8ef88e9d6db801db6`; it is not installed or distributed.

The application contains reusable core parsing/search/state/API modules, a Vencord adapter and React interface, and a standalone package based on pinned Vencord. BetterDiscord has historical code but no current adapter. `src/vencord/index.tsx` owns lifecycle and keyboard entry; `ui/panel.ts` owns authenticated catalog access; `core/panelClient.ts` owns HTTP/auth; `ui/ticketSound.ts` and `ticketReminders.ts` own notification behavior. `standalone/build.mjs` prepares the pinned host, `compile.mjs` limits bundled plugins, and the PowerShell installer handles owned files, recovery and renderer updates. Detailed architecture evidence: [01](01.md), [02](02.md), [17](17.md).

## CRITICAL FINDINGS

Two confirmed P1 source defects: malformed token syntax could block the renderer synchronously; a failed sidebar-editor lookup could substitute the main editor. Both have source fixes and targeted regression evidence. They are not claims that the owner's actual catalog or current Discord DOM triggered those conditions. No P0 established in this bounded cycle.

## BUG REGISTRY

Each linked role report contains reproduction, root cause, affected paths, priority rationale, actual commands and limitations. “Source fixed” requires final integration and live acceptance before being described as deployed. Findings sharing a root cause are listed once.

| ID | Priority | Confirmed defect | Local status / evidence |
|---|---|---|---|
| Q09 | P2 | Failed local read prevents startup; unread settings can be overwritten | Source fixed; [coordinator](coordinator.md), storageRecovery and demoLifecycle tests |
| Q11 | P2 | Loader rejects installer-supported prerelease host directory | Source fixed; [03](03.md) |
| M04-01 | P1 | Unterminated token parser backtracking | Source fixed; [04](04.md) |
| M04-02 | P2 | Quadratic unmatched-brace search normalization | Source fixed; [04](04.md) |
| M04-03 | P3 | Extreme date offsets produce NaN text | Source fixed; [04](04.md) |
| M04-04 | P3 | Unicode casing breaks highlight offsets | Source fixed; [04](04.md) |
| M04-05 | P2 | Unclosed emphasis rescans preview suffix | Source fixed; [04](04.md) |
| M05-01 | P1 | Explicit unresolved editor falls back to another editor | Source fixed; [05](05.md) |
| M05-02 | P2 | Missing host modules throw through integration boundaries | Source fixed in inspected adapter/sound paths; [05](05.md), [14](14.md) |
| M05-03 | P3 | Synchronous clipboard bridge failure escapes recovery | Source fixed; [05](05.md) |
| UX06-01 | P2 | Deleted folder leaves invisible filter/stale draft folder | Source fixed; [06](06.md) |
| UX06-02 | P2 | Fill-field dialog lacks accessible names/selection semantics | Source fixed; [06](06.md) |
| UX06-03 | P3 | IME keyCode229 submits token builder | Source fixed; [06](06.md) |
| M09-01 | P2 | Category discovery is quadratic | Source fixed; [09](09.md) |
| R12-01 / C08 | P2 | Malformed content clears valid local authorization | Source fixed; [12](12.md); duplicates ARCH-01 |
| R12-02 | P2 | Fractional retry deadline can consume sole retry | Source fixed; [12](12.md) |
| 14-01 | P2 | Stop/start silently drops accepted sound preferences | Source fixed; [14](14.md) |
| 14-02 | P2 | Failed sound-options read enables default overwrite | Source fixed; [14](14.md) |
| 15-1 | P2 | Empty Alt-number slot consumes unrelated key | Source fixed; [15](15.md) |
| 15-2 | P2 | Foreign contenteditable triggers template shortcuts | Source fixed; [15](15.md) |
| 15-3 | P2 | Shortcut ignores earlier prevention/extra Meta | Source fixed; [15](15.md) |
| R17-01 | P2 | Build manifest commit can differ from copied source | Source fixed: dirty-input refusal and frozen committed snapshot; [17](17.md) |
| R18-01 | P2 | Reused build dependencies are not attested against pinned lock | OPEN release gate; [18](18.md) |

Separate maintenance exposure R18-02 (P2): upstream registry audit returned 66 advisory records covering 55 distinct GHSAs (35 high, 26 moderate, 5 low records). This does not establish exploitability in the reduced runtime. Root project audit returned zero advisories. Dependency updates were not performed. Candidate emitted inputs must be checked independently of the older `.12` inventory; [audit evidence](18-audit.json).

## DESIGN & UX FINDINGS

Retained the existing design and the two authoring controls (field and greeting). Fixed functional folder/field-dialog/IME behavior. Actual browser harness uses production React components and CSS with synthetic panel/storage/Discord boundaries. Three tabs have no horizontal overflow at 900×675, 360×640 and 320×480. Dirty-close buttons retain an 8px gap and wrap at 320px. Save remains reachable and hit-testable on both sides of the 540px-height breakpoint. [Editor screenshot](editor-900x675.png). Source-only visual and CSS reviews: [07](07.md), [13](13.md); these do not independently certify pixels.

## PERFORMANCE FINDINGS

Removed identified parser/search/preview/category repeated scans. The role09 synthetic Node measurement for 10,000 distinct categories changed from 2296.364ms to 2.023ms; this is one local run, not a Discord latency promise. Million-character parser/preview checks are bounded safety tests. No heap-retention or long-running memory-leak guarantee is made. [04](04.md), [09](09.md).

## FIXES APPLIED

Minimal source changes are attributed in the registry and role reports. Authorization remains fail-closed for foreign identity, revoked sessions and terminal authentication errors. Malformed authenticated content blocks use until revalidation while preserving valid credentials. Unknown save outcomes retain the existing immutable retry body/idempotency key; the original owner's first-save incident has not been diagnosed from a network response.

## TEST RESULTS

Final integrated run: **1464/1464 tests in 65 files passed, zero failed or pending**, four workers; [raw result](full-suite.json). Core and Vencord typechecks passed. First broad run: 1425 passed, 1 failed of 1426, zero pending; [failed-run evidence](full-suite-initial.json). Failure was the new near-million-character Markdown VM deadline (1000ms) under concurrent execution. Independent review measured 230–279ms in isolation and retained the smaller 1s baseline-failure regression while allowing 5s only for the maximal input. This failure is retained, not counted as a successful run. Individual role counts overlap and must not be added together. Independent generated comparisons exercised 16,000 token/text/Markdown cases with no unintended baseline difference; [19](Report19.md).

Coordinator browser evidence: 100 open/close cycles through DOM button handlers and actual React mount/unmount, ending with one dialog and zero captured page errors. A prior actionability-based 100-cycle run was interrupted without a result and is not counted. Ten enable/disable cycles in the actual plugin-entry VM balance root, host and key-listener cleanup. Native installer fixture “latest numeric app version and repair after Discord update” passed in TEMP. Neither browser harness nor VM equals live Discord.

Candidate build passed with 203 source inputs and forbidden-feature checks. All 10 payload sizes/hashes match the manifest; [package evidence](package-evidence.json). Emitted npm executable input is xxhash64 0.1.2 (2391 renderer bytes); patcher/preload have only Node/Electron externals, renderer has none. Source archive contains the actual changed plugin sources, lock, compile/config and licensing files. No independent identical-output rebuild was performed.

Two additional TEMP installer groups passed: actual `.13` payload install/status/uninstall with exact original restore, and refusal of renderer-only update when native/loader/nonleading executable content changes. Total executed in this cycle: three selected installer groups, **not the entire installer suite**. Roadmap consistency and scoped whitespace checks passed; AST-only graph refresh completed (2717 nodes / 5329 edges).

Local package: `artifacts/standalone/0.1.0-canary.13-e8d089b/SupportTemplates-0.1.0-canary.13.zip`. SHA-256: `1b3eec158724ab6898e1c7204d70c8412847f6562fc68fd66abb97111ffb13a5`. This hash is local integrity evidence, not a signed publisher identity.

## REMAINING RISKS

- Installed `.12` does not contain this cycle's fixes. Loader changes require a native package upgrade; Ctrl+R alone cannot deliver them.
- Live Discord main/sidebar insertion, device login timing, initial uncertain save, actual sound audibility, assigned-ticket reminder permissions/delivery and host-update recovery remain acceptance work.
- BetterDiscord adapter is absent; ordinary Vencord and standalone share source but require separate live acceptance.
- R18-01 exact-lock dependency-tree attestation is unresolved. R18-02 upstream tooling/optional-feature advisories need a controlled maintenance pass; no reduced-runtime exploit was demonstrated.
- No exhaustive cross-mod matrix, real OS IME, screen-reader session, forced-colors/native picker matrix, long-run heap study, OS crash durability or independently reproduced build.
- Synthetic fault injection establishes defects and regressions, not production incidence. A clean audit scope does not establish absence of all vulnerabilities.

## NEXT ACTIONS

Perform a bounded Canary acceptance session against the prepared `.13` before distribution; it requires a full stopped-client native installation because the loader changed. Check main/sidebar insertion, settings restart, login/session recovery, initial save and sound/reminders. Resolve exact-lock build dependency provenance and review upstream maintenance advisories separately. Keep unavailable platform work separate. This finite 20-role cycle is complete; these are explicit follow-up gates, not unattended work.

## RELEASE STATUS

| Platform | Decision now | Reason |
|---|---|---|
| Standalone Canary | HOLD distribution | Source/tests/package and selected TEMP fixtures pass; installed acceptance and dependency provenance remain |
| Standalone Stable | HOLD | No live Stable validation; explicit isolated fixture only |
| Ordinary Vencord plugin | HOLD | Shared-source type/tests do not prove installation/live integration |
| BetterDiscord | NOT IMPLEMENTED | Current adapter absent; architecture review only |

## Independent role evidence

[01 Architecture](01.md) · [02 BetterDiscord](02.md) · [03 Fork/loader](03.md) · [04 JS/TS](04.md) · [05 Compatibility](05.md) · [06 UX](06.md) · [07 Visual](07.md) · [08 React](Report08.md) · [09 Performance](09.md) · [10 Security](10.md) · [11 State](11.md) · [12 Async](12.md) · [13 CSS](13.md) · [14 Persistence](14.md) · [15 Conflicts](15.md) · [16 User paths](16.md) · [17 Build](17.md) · [18 Dependencies](18.md) · [19 Regression](Report19.md) · [20 Final quality](20.md).
