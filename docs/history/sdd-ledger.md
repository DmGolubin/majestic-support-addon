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
