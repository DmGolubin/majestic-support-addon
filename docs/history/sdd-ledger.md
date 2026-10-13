# SDD ledger — plan: docs/superpowers/plans/2026-10-05-stage1-core-vencord.md

Spec: docs/superpowers/specs/2026-10-05-support-templates-design.md
Branch: stage1 (from main @ 936fea9)
Ruling: work on local branch `stage1` in place, no worktree — fresh local repo without remote, nothing else on it — cost if wrong: none, branch can be moved.
Ruling: pause for the user's manual Discord check after tasks 6–10 — user agreed to these stops before choosing execution mode (overrides "continuous execution") — cost if wrong: slower run.

## Pre-flight scan

| Pair / task | Produces → consumes | Finding |
|---|---|---|
| T1→T2,T3,T4,T5 | types/text/importer → search, rank, guard, state | consistent names (soft, hard, tokenize, titleKey, splitGreeting, stripMarker, importBackup, parseRaw) |
| T2→T3 | Hit (search.ts) → rank.ts orderHits | ok |
| T3→T5,T6,T8 | RankCtx → state; FieldSpec → uiState Dialog; fill/fieldsOf → flow | ok |
| T4→T5 | ServerBinding, bindProblem, PREFIXES → state | ok |
| T6→T7..T10 | platform, uiState (store, ui, activeProject, poolFor, useStore, guildKey), ProjectIcon, styles | ok |
| T7→T8 | flow.prepareText modified by T8 | ok |
| T7→T10 | highlight.tsx (nqHighlight) used by Inline | T7 Files list omits highlight.tsx but step 2 creates it |
| T8→T9 | fillFields → ComposeBar | ok |
| T1 self | tsconfig `types: []` vs tests importing node:fs / import.meta.url / structuredClone (T5) | tsc would fail without node types |
| T2 self | tests vs code | ok (title-words test fixed in plan) |
| T4 self | mirror ratio > 0.8 | plan gives fallback guidance |
| T6..T10 self | index.tsx edited across tasks | edits additive, consistent |

Ruling: T1 adds `@types/node` to devDependencies and `"types": ["node"]` in tsconfig — tests use node:fs, import.meta.url, structuredClone; spec requires typecheck to pass — cost if wrong: one extra dev dependency.
Ruling: T7 creates src/vencord/ui/highlight.tsx as written in its step 2 — file list omission only — cost if wrong: none.

## Progress
Task 1: minor (deferred): literal NBSP instead of   escape in src/core/text.ts:8 and tests/text.test.ts:6-7
Task 1: minor (deferred): parseRaw does not dedupe same group+title (duplicate ids)
Task 1: complete (commits 936fea9..21164cc, review clean)
Task 2: ⚠️ resolved by controller: alias keys with punctuation ("1.500.7") match — hard() keeps punctuation, only drops {…} and squeezes spaces
Task 2: minor (deferred): fuzzy hits suppress the layout fallback (plan-mandated order)
Task 2: minor (deferred): search returns hits in pool order; callers must orderHits (Task 3) — undocumented
Task 2: minor (deferred): thin tests for layout target / level precedence / multi-token
Task 2: complete (commits 21164cc..27279fc, review clean)
Task 3: minor (deferred): rank tests don't exercise popularity / usage tie-break (plan-mandated tests)
Task 3: minor (deferred): fill() reads values[name] incl. prototype keys (field named "constructor"); huge offsets → NaN date
Task 3: parked — DST concern on date offsets — Ruling: no action; reviewer assumed ro=Romania, ro is Россия Онлайн (Russia, no DST); fixed-ms shift is fine — cost if wrong: date off by one around DST night
Task 3: complete (commits 27279fc..8112225, review clean)
Task 4: fix round 1/5 (2 addressed, 0 open — literal BOM/NBSP → escapes, incl. Task 1 deferred NBSP; commits bb702b7..9067706)
Task 4: minor (deferred): bare F1/F5/F11/F12 allowed as binds; RESERVED lacks Ctrl+W/R/K; Alt+Shift+Digit not reserved
Ruling: stray debug file check-mirrors.ts committed in fix round — delete it in Task 5's commit — cost if wrong: none
Task 4: complete (commits 8112225..9067706, review clean)
Task 5: minor (deferred): storage.set promise discarded (no .catch); markIntentional writes even when already marked; setBind doesn't check template exists
Task 5: complete (commits 9067706..51fa0b8, review clean)
Ruling: plan amended 12.10.2026 (user-approved): Task 7 gains Step 0 (core: Template.color, recentOf, categoriesOf) + tabs/chips/hover/Shift preview in Window; Task 6 CSS gains view/chip/tip/colour rules — cost if wrong: rework of Task 7 UI only
Ruling: interrupted Task 6 attempt parked on branch wip/task-6-partial (unreviewed); Task 6 re-dispatched fresh from the amended plan — cost if wrong: redo of ~10 files
Task 6: Ruling: --stx-mu must be hsl(214 10% 80%) (spec/constraints = panel's muted-foreground) not 72% from the plan's CSS — fixed in Task 7's commit — cost if wrong: slightly brighter muted text
Task 6: minor (deferred): make-icons has no Chrome/ro.png existence check; start() has no double-start guard
Task 6: complete (commits 85e16b5..7cd815b, review clean) — manual Discord check pending with user
Task 7: Ruling: plan-mandated Window onKeyDown ignores e.repeat for Enter/Ctrl+D — fix (spec global constraint wins) — cost if wrong: none
Task 7: Ruling: fold minors into round 1 — stopPropagation on handled window keys (Escape marks channel read), visibleItems = favs in "Все" view w/o query (Alt labels match) — cost if wrong: small UX change
Task 7: minor (deferred): hover/peek stale state; sel highlight after unfavorite; tooltip click closes window; no resize listener; context menu not clamped; markUsed when no editor; Tab trapped; orphaned dialog promise if two asks race; project not rechecked after awaits
Task 7: fix round 1/5 (3 addressed, 0 open — e.repeat on Enter/Ctrl+D, stopPropagation, visibleItems=favs in All view; commits a7cd2fe..e496517)
Task 7: minor (deferred): Enter/Ctrl+D with empty list not swallowed
Task 7: complete (commits 8dd422a..e496517, review clean) — manual Discord check pending with user
Task 8: ⚠️ resolved by controller: readClipboard() already swallows errors (try/catch → "") in platform.ts (Task 6)
Task 8: Ruling: route ContextMenu's bind dialog through supersede() too — cost if wrong: none
Task 8: minor (deferred): no focus trap in dialogs; stop() clears dialog without resolving; "clipboard" substring check reads clipboard on plain prose; bind repeats failure toast on held key; caret {|} position dropped after fill
Task 8: fix round 1/5 (3 addressed, 0 open — keyed dialogs + own-dialog clear, Frame focus, bind via supersede; commits 18a5dec..ea1de24)
Task 8: minor (deferred): focus not restored to chat editor after a dialog closes; Bind dialog has no Frame focus (keys captured anyway)
Task 8: complete (commits e496517..ea1de24, review clean) — manual Discord check pending with user
Task 9: minor (deferred): stale drag id can enter compose; insertAll may insert into a new channel if channel changes while fields dialog is open (project gating!) — flag for final review; ghost ids keep bar; position not reactive to resize; reorder flicker
Task 9: complete (commits ea1de24..629d336, review clean) — manual Discord check pending with user
Task 10: Ruling: Inline.tsx renamed InlinePop.tsx (export Inline) — inline.ts vs Inline.tsx collide case-insensitively on Windows (TS1149, wrong file bundled) — cost if wrong: none
Task 10: Ruling: no matches → no popup (so ";)"+Enter sends); project-unknown note consumes Enter/Tab with toast (don't send ";снр" to a player) — spec says Esc dismisses, silent on Enter in empty state — cost if wrong: Enter behaviour in edge states
Task 10: Ruling: fold minors into round 1 — accepting flag, modifier/IME guards (Shift+Enter stays newline), cancel rAF on teardown, left-button only — cost if wrong: none
Task 10: minor (deferred): multi-line textBeforeCaret via Range.toString() may glue lines (trigger at start of line 2); stale selection if Tab before rAF; markUsed ignores insert result; check() re-sets ui on every selectionchange
Task 10: fix round 1/5 (5 addressed, 0 open — no-match no popup, note state consumes Enter/Tab, accepting flag, modifier/IME guards, rAF cancel, left-button; commits b691fad..ef09187)
Task 10: complete (commits 629d336..ef09187, review clean) — manual Discord check (Slate trigger replacement) pending with user
Task 11: Ruling: README.md already exists (written 06.10 with repo map); merge the plan's dev section into it instead of overwriting — cost if wrong: none
Task 11: Ruling: README-only diff reviewed as part of the final whole-branch review instead of a separate task review — cost if wrong: a doc typo slips one round
Task 11: complete (commits ef09187..5024518) — manual run pending with user
Final review: With fixes — Critical 1 (project/channel not rechecked after awaits), Important 5 (held-Enter latch, sessionProject reset, spec §11 error handling missing from plan, dialog focus trap, stop() wedge), minors chosen to fix now 7–11 — see final-fix-findings.md
Ruling: spec §11 error handling (ErrorBoundary, clipboard fallback, [SupportTemplates] logging) is binding; the plan omitted it — added in the final fix wave — cost if wrong: a few extra lines
Final fix wave: 11 findings — 10 addressed, #9 partial (commits 5024518..b715d25; re-review: all addressed, no new breakage)
Final: parked — #9 thread in side panel: window/insert may target main chat when search box has focus — Ruling: known limitation for stage 1, fix later with "last focused editor" — cost if wrong: text goes to main chat instead of side-panel thread (still same channel check by SelectedChannelStore)
Final: parked — deviations #1 (confirmed foreign piece kept in compose) and #10 (clipboard=/| forms) — Ruling: accepted, match user intent and core token grammar
Final: minor (deferred): dialog latches Space while typing in fields (no auto-repeat on held Space); CHANNEL_SELECT re-select clears compose; old lint no-multi-spaces in core/search.ts
Task 12 (added 12.10.2026, user-approved): window redesign (port replica) + markdown preview + performance; brief task-12-brief.md; BASE 41a05af
Task 12: review — all 15 brief items present; Important: InlinePop footer clipped by new .vc-stx-foot; Ruling: fold minors (clamped sel highlight, rect read once in InlinePop/ComposeBar) into round 1; deviations accepted (team-usage chip removed — spec uses teamUses for ranking only; pluralised counts; hints in footer tooltip; inline item identity compare)
Task 12: minor (deferred): window rect stale when Discord sidebar/member list toggles without resize; preview squeezed in very narrow chat; markdown closer O(n²) on many unmatched *; redundant j>0 branch
Task 12: fix round 1/5 (3 addressed, 0 open — popup footer wraps, clamped selIdx, useChatRect on open/resize; commits 48cef5c..fec931c)
Task 12: ⚠️ resolved by controller: visibleItems=favs in All view vs clamp on rendered items is intentional (Alt+N follows favourite labels); useMemo from @webpack/common confirmed by Vencord tsc+build
Task 12: minor (deferred): popup/compose rect stale on layout changes without window resize (reply bar, member list)
Task 12: complete (commits 41a05af..fec931c, review clean) — manual Discord check pending with user
Task 13 (added 12.10.2026, user-approved): scroll lag, preview left of list, tooltip fade, chat-bar icon per server, icon alignment+hover animation; brief task-13-brief.md; BASE c23a93b
Task 13: minor (deferred): scroll listener attached once in [] effect; chat-bar project resolution duplicates activeProject(); «Shift — весь текст» hint shown even when not cut; neutral «Ш» tile border; stale tooltip after Shift
Task 13: complete (commits c23a93b..e33fa62, review clean) — manual Discord check pending with user
Task 14 (bugfix from user check): tooltip overlap + Shift after «+ в ответ»; BASE ad0fb1e
Task 14: root cause B — Shift+click on preview «+ в ответ» focuses the button; preview unmounts on Shift release → focus to body; fixed by mousedown preventDefault on buttons/rows + guarded refocus effect
Task 14: minor (deferred): plain keyboard Shift+Enter path unexplained (user check is the gate); clicking preview text/empty area drops focus; tipH stale first frame
Task 14: complete (commits ad0fb1e..ead346d, review clean) — manual Discord check pending with user
Task 15 (user request): Shift peeks hovered row (bug since Task 12 perf) + debug mode (panel, event log, report); BASE ac120be
Task 15: review Approved; Ruling: fix minor "hoveredId not cleared on list change" now (same bug class the user reported) — cost if wrong: none
Task 15: minor (deferred): window opened under stationary cursor sets hovered row; report includes typed queries/markers/error messages (no bodies); possible error loop if debugSnapshot throws; some dlog args computed when off (rare paths); setting toggle while plugin stopped
Task 15: fix round 1/5 (1 addressed — clear hoveredId/debug hover/tooltip on list change; commits 97b415c..4239c8f)
Task 15: complete (commits ac120be..4239c8f, review clean) — manual Discord check pending with user
Task 16 (user request): Shift+wheel scrolls preview (Chromium Shift+wheel = horizontal) + verbose debug (all events, geometry, perf, settings, categories/filter, 200-event ring); BASE 16861a4
Task 16: implemented (commits 16861a4..f8ac9d3) — task review NOT yet run (usage limit); masked typed chars in verbose key log (privacy, beyond brief)
Task 16: review Approved; privacy deviation (masked typed chars) accepted; Ruling: fix minors now — dlog during render deferred, Ctrl/Meta+Shift+wheel not redirected, no preventDefault when preview can't scroll, mask IME — cost if wrong: none
Task 16: minor (deferred): search-input keystrokes logged per key; string alloc in Window log helper when off; mask rule untested (in webpack module); wheel bucket handled flag coalescing
Task 16: fix round 1/5 (4 addressed — deferred search dlog, Ctrl/Meta guard, no preventDefault at scroll edge, IME mask; commits f8ac9d3..9ca475e)
Task 16: complete (commits 16861a4..9ca475e, review clean)
User report 13.10: long tasks 50–240ms (max 1351) on every logged event while verbose panel open; window renders low (14), search 2ms → suspect verbose DebugPanel re-render + 10 rect reads per event; plugin load 2633ms suspicious (likely includes Discord boot)
Task 17 (user report): cheap debug panel (throttle 250ms, geometry ≤1/s, 50 lines), plugin cost accounting + longtask overlap, plugin-only load time, cheap idle inline trigger; BASE 96aaaf6
Task 18 (user report): small-screen layout — viewport clamp, compact mode <720, preview min 320, wrapping actions, short footer; Task 17 review re-dispatched after session crash
Task 17: complete (commits 96aaaf6..ee2e7b7, review clean)
Task 17: minor (deferred, fix after Task 18): longtask "plugin=yes" counts tiny overlaps (need min overlap ≥5ms/10%); span ring 256 may wrap before observer → raise to 1024; % divides by 60s even early; render cost = component bodies only (label it); collapsed panel still re-renders header; no test for inline idle cache
Task 18: Ruling: accept footer keycaps-only at compact||width<360 (not <380) and fixed 400px compact window (list doesn't jump) — cost if wrong: one-line change
Task 18: minor (deferred): footKeys `width<360` term dead (only reachable in compact); preview-min test tautological, no combined tooltip-left≥EDGE sweep; resize with no chat area doesn't re-render (stale vw); 358→398 list width change at mode switch; covered search input still takes typing in compact pinned preview
Task 18: complete (commits ee2e7b7..e8768b4, review clean) — manual Discord check pending with user (~1100 px and ~800 px)
