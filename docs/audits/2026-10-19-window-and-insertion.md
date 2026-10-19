# A20 — distribution identity, BetterDiscord insertion and window UX

The owner confirmed .17 connects and reported five remaining issues: confusing Canary identity, inert BetterDiscord insertion, settings dimensions jumping between pages, outside chat interactions dismissing the window, and lack of resizing.

## Insertion

The BetterDiscord adapter omitted `rawText` from `INSERT_TEXT`; the pinned Vencord implementation supplies both `rawText` and `plainText`. A regression in the real packaged BD React/DOM harness reproduced unchanged draft text before the fix and passes after it. The fixture restores encrypted login, loads FAQ from a mocked contract endpoint, clicks a real row with search focused, then checks the captured composer receives the complete payload. A second guard test rejects non-composer focus. No send action is dispatched. This verifies the adapter contract, not the live Discord implementation.

## Windows and identity

Settings are a nonmodal fixed-size window with internal scrolling and viewport bounds. Chat interaction no longer dismisses it or steals keyboard focus; explicit close still protects dirty drafts. The picker has an explicit close button, a top-left resize handle, keyboard resizing, local size persistence and viewport clamping. Preview layout remains anchored to the list. Each packaged variant provides its display identity; SemVer, storage keys and registry IDs remain unchanged.

## Browser evidence

An isolated harness bundles actual React UI components with mocked Discord/API services. Chromium headless measurements:

- At 1200×900, personal/general/ticket settings all measure 900×720 at x150/y90.
- At 480×600, all three settings pages measure 464×584 at x8/y8.
- Picker drag changes 360×500 to 480×600, preserved after closing/reopening.
- Picker stays within 480×600, 360×640 and 1200×300 viewports.
- Actual pointer text selection and input in the surrounding mock chat leave windows open; Escape in chat does not close settings.
- No browser page errors. Screenshots visually inspected for the resized picker and narrow settings.

Browser results: `2026-10-19-window-browser.json`. Local disposable harness and screenshots: `artifacts/ui18/`; no production panel mutation or client installation.

## Automated verification

- 1,654/1,654 Vitest tests, 75 files, zero failed/skipped/pending tests; `2026-10-19-window-and-insertion-tests.json`.
- Core TypeScript and read-only Vencord source-overlay TypeScript passed.
- 12/12 Vencord package/updater Node tests passed.
- `graphify update .` completed using AST extraction; no LLM calls.
- The first full run exposed a test synchronization issue: polling UI inside a single open React `act()` blocked a late restoration commit. Polling now flushes one frame per `act()`, with a bounded timeout. Final full run passed.

Live BetterDiscord insertion, Ctrl+R session persistence and all-three-platform acceptance remain user verification; .17 connection confirmation does not establish them. No installed Discord files were changed.
