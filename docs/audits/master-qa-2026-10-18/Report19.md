# Role19 — independent current-diff regression review

Reviewed 2026-10-19; HEAD/baseline `65a78b7`, renderer .12 context. Read AGENTS.md and docs/roadmap/data.json. Reviewed working-tree changes, including untracked regression suites, rather than assuming previous reports prove correctness. No confirmed new product defect; no product edits made.

## Inspected files and evidence

- `src/core/tokens.ts:18-91`: scanner advancement, overlapping invalid openers, exhausted closer cache, field deduplication, literal replacement values and caret offsets; invalid date offset handling at 64-66. Inspected `tests/tokens.test.ts` and `tests/masterCodeAudit.test.ts`.
- `src/core/text.ts:11-24`: replacement of complete brace spans and retention of unmatched suffixes. Inspected `tests/text.test.ts`.
- `src/core/rank.ts:72-76`: Set preserves insertion order and exact string equality, retaining the original truthy-category filter. `tests/rank.test.ts:40-51` covers duplicates, empty/null, whitespace, case and prototype-like names without mutating input.
- `src/vencord/ui/markdown.tsx:22-38,44-83`: exhausted cache is local to each recursive parse; double markers retain their previous path. `src/vencord/ui/highlight.tsx:10-34`: normalized/source offset map, including expanded Unicode casing. Existing role04 Unicode assertions exercised.
- `src/core/state.ts:99-108,163-212,274-291`: failed and pending reads suppress preference writes and reject catalog writes, concurrent loads share a promise, retry reopens writes after reading. Inspected `tests/storageRecovery.test.ts:5-49`, `tests/state.test.ts`.
- `src/vencord/platform.ts:18-126,145-172`: host failures, stale guild/channel matching, failed subscription rollback and inert cleanup callbacks, asynchronous clipboard notice generation, toast fallback and clipboard read fallback. Inspected/executed `tests/masterCompatibility.test.ts:71-249`; host APIs are mocks. Read index diff for notice-disposal integration only; startup/Q09 and UI state remain parent-owned.
- `src/vencord/panelHtml.ts:25-55`, `src/core/panelCatalog.ts:209-222`: equivalent token protection in HTML and text adapters. Inspected their full implementations/current diffs and ran both corresponding suites. Catalog access/data error classification was observed but not independently audited as session recovery ownership.
- Also read `package.json`, current status/stat, and `tests/masterCodeAudit.test.ts` in full. No claim to have audited every unrelated changed file.

## Independent counterexample search / discarded suspicions

Added `tests/masterRegression.test.ts:29-42`: deterministic generated comparisons against source from pinned baseline using `git show`, with 8,000 token/text inputs and 8,000 markdown inputs. Full field structures, fill text/caret, normalized strings and markdown element trees match. Inputs combine malformed/nested braces, defaults/options, whitespace, literal clipboard syntax, greeting/caret markers, escaping, adjacent emphasis, code and URLs. Invalid date overflow is an intentional fix, not included as an expected baseline equivalence.

Discarded hypotheses: changed whitespace greediness corrupting field/default semantics; malformed opener advancement losing carets; markdown exhausted-cache changing later formatting; Set sorting/collapsing category spellings. Generated checks, targeted existing assertions and code inspection produced no counterexample. This finite search is not proof for all possible strings. Failed-read overwrite and stale-adapter hypotheses did not reproduce in the synthetic targeted suites; this does not establish live Discord compatibility.

## Million-character timeout: evidence and disposition

Parent full-suite artifact `full-suite.json` records 1426 tests, 1425 passed, one failure in the near-limit markdown case under many workers. Parent separately reported 28/28 role04 tests passing with one worker, 746ms test execution; that timing is attributed to parent, not independently measured here.

Independent single-worker measurements from `tests/masterRegression.test.ts:44-59`, three trials per size, milliseconds including VM invocation and exact output assertion:

| Characters | First run | Final focused run |
| --- | --- | --- |
| 60,000 | 17.33 / 12.62 / 12.62 | 17.50 / 13.84 / 14.26 |
| 120,000 | 27.39 / 27.93 / 26.27 | 29.21 / 28.75 / 26.41 |
| 240,000 | 55.76 / 56.16 / 61.26 | 54.78 / 53.34 / 55.58 |
| 999,999 | 262.63 / 279.15 / 234.24 | 248.33 / 263.27 / 229.75 |

The baseline parser times out at 60,000 with the same 1000ms VM guard. Current code avoids rescanning exhausted single-emphasis suffixes; observed scaling for this input is consistent with linear work. These measurements and isolated passes support contention as the full-run timeout explanation, not a demonstrated product regression. They do not constitute a controlled scheduler-contention experiment or a universal markdown complexity bound.

Minimal test-only adjustment: `tests/masterCodeAudit.test.ts:15` accepts a timeout argument; only the near-limit assertion at 174-176 uses 5000ms. The 60k assertion at 112-117 retains 1000ms, and the added differential suite explicitly proves baseline still fails that smaller deadline. Priority: test reliability issue; no product severity assigned. Prefer a low-worker parent final run for stable resource-heavy checks.

## Actual validation and limits

Final command: `node node_modules/vitest/vitest.mjs run tests/masterRegression.test.ts tests/masterCodeAudit.test.ts tests/masterCompatibility.test.ts tests/storageRecovery.test.ts tests/tokens.test.ts tests/text.test.ts tests/rank.test.ts tests/state.test.ts tests/panelCatalog.test.ts tests/panelHtml.test.ts --maxWorkers=1 --disableConsoleIntercept`.

Result: **10 files passed, 233 tests passed**, 9.70s total, 4.45s test execution. Earlier eight-file focused run: 106 passed; separate differential/measurement run: 3 passed. `node scripts/roadmap.mjs --check`: 71 tasks, STATUS/TODO consistent.

Only role19 test file, the explicitly authorized near-limit timeout adjustment and this report were authored here. No commits, roadmap edits, builds, installs, installer suite, production API, real Discord changes, token/credential reads or browser use. No full-suite rerun, typecheck, installed-renderer or real storage/clipboard validation. Concurrent contributors can change the tree after this review; results apply to the inspected state and final focused invocation.
