# Report08 — React/hooks lifecycle audit

Date: 2026-10-19. Requested baseline: 65a78b7 / renderer .12. Audited the current shared working tree, including the new untracked LocalStorageNotice and concurrent changes; this is not a pristine-baseline audit.

## Outcome

No confirmed actionable lifecycle/stale-closure defect in the bounded inspected component paths. No production edits. Added only tests/masterReact.test.ts and this report. Do not interpret this as full React, StrictMode, browser, or Discord acceptance.

## Scope and inspected files

Read AGENTS.md and docs/roadmap/data.json; Q13 is active. Read package.json and the existing hook harness in tests/settingsDialogPolish.test.ts. Inspected component lifecycle/handler sections in src/vencord/ui/Host.tsx, Window.tsx, ComposeBar.tsx, ContextMenu.tsx, LoginWindow.tsx, DebugPanel.tsx, Management.tsx, PersonalLibrary.tsx, PanelConnection.tsx, Settings.tsx, Select.tsx, LocalStorageNotice.tsx; inspected InlinePop.tsx, Preview.tsx, ColorPicker.tsx, DemoConnection.tsx, DemoBanner.tsx, ReminderSettings.tsx and TicketSettings.tsx for component-owned asynchronous work/hooks. Some larger files were inspected as selected sections rather than exhaustively reviewed.

Parent-owned index/startup recovery and uiState remain excluded. PanelPersonalLibrary, Dialogs and TokenToolbar implementation audits/fixes belong to other roles; no duplicate findings or edits. Controller internals, global store selection, transport correctness and storage recovery are not certified here.

## Evidence

- LocalStorageNotice.tsx:11–18 initializes from realStore.loadError, subscribes, immediately resynchronizes after subscribing and returns the exact unsubscribe callback. Settings.tsx:59 mounts it above the tab content. New tests execute its actual transpiled TSX: three mount/unmount cycles leave zero listeners; a render-to-effect change is observed; failure/recovery notifications toggle the notice.
- ComposeBar.tsx:47–63 subscribes to UI/store, performs initial sync, and detaches both on cleanup while marking disposed. Lines 78–89 and 104–118 check operation currency after awaits and before insertion; finally does not set React state after disposal. This is code proof for the inspected path, not a live insertion test. Global store replacement is outside this role.
- ContextMenu.tsx:78–81 refreshes itemsRef/activeRef each render; lines 97–140 register and remove document/window handlers using matching callback identities. The persistent keyboard handler reads current refs at lines 100, 120 and 128. Gesture-end guards intentionally outlive menu closure: lines 24–47 include explicit resetMenuGuards cleanup; caller/startup ownership is excluded.
- Window.tsx:188–197 returns geometry watcher cleanup. Lines 185–186 refresh the selection refs read by the Shift handler at line 235. Lines 250–260 detach the four global handlers and clear hover/scroll timers. Lines 266–303 pair scroll/wheel registration with removal. DebugPanel.tsx:37–48 clears its interval, queued animation frame and geometry subscription.
- LoginWindow.tsx:25–35 pairs outside-mousedown registration/removal. Management.tsx:20–39 uses dirty/busy refs for its mount-time Escape closure and removes the document handler on cleanup; parent callbacks refresh those refs. PersonalLibrary.tsx:46–64 invalidates mounted status in layout cleanup and reads latest callbacks; lines 75–87 gate async success/error/finally through current selection/mount checks.
- Select.tsx:29–31 only scrolls its live list in a layout effect. InlinePop calls its hooks before conditional returns; Preview/ColorPicker have no component-owned asynchronous continuation or subscription. TicketSettings/ReminderSettings dispatch controller-owned operations and subscribe through their stores; the controller lifecycles are outside this audit.

## Observations, not promoted to findings

LocalStorageNotice.tsx:23–25 has no mounted guard around finally(setBusy(false)). A deferred rejection after unmount was reproduced with actual TSX in the isolated harness: one old-instance setter call, zero new-instance setter calls; the remounted notice stays idle and owns exactly one subscription. No shared-data mutation, stale new-instance state or user-visible failure follows from that setter in the inspected code. No severity assigned; do not claim a memory leak merely from this continuation. Optional minimal hygiene would use an effect-owned liveness/generation guard; no production change justified by demonstrated impact.

PanelConnection.tsx:19 and 31–47 similarly retains its local action ref across an await without unmount invalidation. Identity checks suppress superseded actions within the same instance. Actual React remount allocates separate local state/refs; no demonstrated cross-remount corruption. Controller cancellation or persistence after close requires controller-level evidence and is not asserted as a finding here.

Priority rationale: no P0/P1/P2 issue is supported in this bounded review. Optional late-setter hygiene is not a release blocker. No speculative stale closure has been listed as a defect.

## Validation and limitations

Executed locally, without dependency installation, production API calls, token access, Discord changes or shared browser:

`node node_modules/vitest/vitest.mjs run tests/masterReact.test.ts tests/settingsDialogPolish.test.ts tests/personalLibraryLifecycle.test.ts`

Result: **3 files passed, 42 tests passed**, Vitest 4.1.12, duration 1.38s. The new file contributes three LocalStorageNotice tests; existing files belong to the shared tree and were only executed. These are VM/hook models executing actual component source, not an installed React reconciler: they do not establish layout, focus, StrictMode effect replay or real host behavior. Late setter handling is explicitly modeled and counted, not silently treated as a real-React render.

`node scripts/roadmap.mjs --check` passed: 71 tasks; STATUS and TODO consistent. No roadmap edits. Full suite, typechecks, builds and installer suite left to parent coordination. No commits. Unrelated working-tree changes preserved. One read command initially failed PowerShell parsing due to brace syntax; corrected read succeeded; this was not a product/test failure.
