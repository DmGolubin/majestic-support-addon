# BetterDiscord insertion follow-up — 2026-10-19

## Report and evidence

The owner reported that .18 still did not insert. The supplied debug report records preview, window-click and compose attempts, each focusing the Slate editor and logging `ok=true`, without visible text. The installed plugin SHA-256 matches the published .18 asset. The previous mocked dispatcher test did not establish live delivery.

Read-only inspection of the current client's cached public JavaScript found:

- ComponentDispatch `dispatchToLastSubscribed` returns its instance even when its event has no listeners. Its return is not insertion acknowledgement.
- The composer class exposes `getSlateEditor`, `handleInsertText` and an inner editor ref. The handler forwards `plainText`, `rawText`, `addSpace` into the inner editor, then focuses.
- Outer composer focus is queued behind React state; inner editor focus directly calls Slate focus.
- The rich editor inserts through Slate transforms synchronously, with React painting later.

These findings explain why the old success check was insufficient. They do **not** prove which live subscriber/no-op caused the reported refusal. No private messages, tokens or settings were read from the cache, and no Discord module IDs or minified export names were embedded in the plugin.

## Change

The BetterDiscord adapter now obtains the focused DOM editor's Fiber through documented `BdApi.ReactUtils.getInternalInstance`, walks its ancestors with a depth limit, and finds that editor's composer by its insertion/Slate methods. It rejects missing, disabled, submitting or disconnected targets, focuses the inner editor, and invokes the owner's handler exactly once. No global dispatcher fallback, direct DOM write, direct Slate write, send action or search across unrelated composers is used.

Success requires a new nonempty text/node insertion operation and a change to Slate text leaves; the special case of replacing selected text with identical text also checks the removal/insertion order. Deletion alone and a fully rolled-back insertion are rejected. Target/model identity is checked before and after delivery. A post-insertion focus exception does not cause a duplicate retry. An unchanged draft raises an error, preserving the existing explicit failure/copy fallback and preventing false usage bookkeeping.

The adapter depends on Discord's internal composer methods, which may change. An unsupported shape fails visibly; live owner acceptance remains necessary. Vencord insertion is unchanged.

API reference: [BetterDiscord ReactUtils](https://docs.betterdiscord.app/api//ReactUtils).

## Verification

- New regression tests fail on the old adapter (7 failures, 1 pass), then pass on the targeted adapter.
- Final bundle test restores encrypted login, loads FAQ, clicks the actual plugin UI, updates the intended model/DOM once, and never uses the no-op global dispatcher.
- A separate review added four regression cases for deletion-only failure, rollback and model switches; each failed before the corresponding guards, then passed.
- Final full suite: 1,666/1,666 tests in 76 files, zero failures/skips; `2026-10-19-bd-target-insertion-tests.json`.
- Core TypeScript and read-only Vencord source-overlay TypeScript pass.
- Graph updated with AST extraction only.

Test hosts implement the observed composer contract; they are not a live Discord session. The owner must verify ordinary/preview/compose insertion and existing draft preservation in .19. Installed Discord files have not been changed by this work.
