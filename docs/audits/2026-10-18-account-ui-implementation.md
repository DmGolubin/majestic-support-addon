# Account interface implementation — 18 October 2026

Scope: the owner's seven interface complaints in A18, real personal-library editing in C06, and draft retention in Q10. Canary .6 is installed and the owner confirmed it works; that build only fixed FAQ compatibility. This change prepares Canary .7.

## Interface

- Category chips replaced by one dropdown with counts and reset. Settings is an icon beside search. Enter/Escape inside the dropdown never inserts a template or closes the menu. Tab moves focus; Ctrl+Tab changes list views.
- Three settings tabs: personal templates, general settings, tickets. Connection details live inside general settings; secondary information is collapsed.
- Import, local-library and demo switches removed from the ordinary interface. Existing local data is preserved.
- Server tiles show an icon and name. Discord guild icons are used when available, with project artwork as fallback.
- Ticket settings use a bounded volume control and named channels. Player-waiting reminders remain explicitly unavailable; Telegram remains the threshold authority.

## Verification

An isolated browser harness bundles the actual React UI components with synthetic data and stubbed Discord/API services. It does not contact the panel or prove live API writes. At 800×600, category selection, reset, settings navigation and Escape behaved correctly with zero insertion calls. General settings had no horizontal overflow at 800px or 480px. Ticket settings rendered channel names and no editable raw-ID field.

The shell's dirty/busy callback tests retain their asynchronous editor fixture; the new account editor's API/draft lifecycle needs separate coverage. Old import-completion tests were replaced by absence checks because the import entry point was removed.

The account editor uses real personal/folder POST, PATCH and DELETE endpoints. UUID idempotency keys and exact retry payloads are retained; edits/deletes carry the original server version. Read-only sessions offer explicit authorization for writing. The editor keeps an in-memory draft bound to account/connection across Settings unmounts and clears it on explicit discard, account switch or revocation. No panel record is written through the local library store.

Browser checks additionally covered dirty-tab guards, forced unmount/reopen, unknown-result retry identity, explicit discard, account-switch draft clearing, and 412 comparison/copy behavior. Save actions remain visible at 480px. These use stub responses and do not establish successful live writes.

Independent review found and then verified fixes for three edge cases: preserving an uncertain action across failed retry preflight, immediately clearing terminal auth failures, and withholding stale conflict comparison until a fresh load succeeds.

Screenshots of actual components with synthetic data: [categories](images/2026-10-18-account-ui/categories.png), [personal cards](images/2026-10-18-account-ui/personal.png), [settings](images/2026-10-18-account-ui/settings.png), [tickets](images/2026-10-18-account-ui/tickets.png).

Integration run: 885 tests in 45 files passed. Core TypeScript and the read-only Vencord overlay typecheck passed. Ordinary Discord and the installed base Vencord checkout are outside the installation scope.

Remaining live acceptance: install .7 on Canary; authorize writing; create/edit/move/color/delete an owned test template and verify panel synchronization. Real ticket sounds and player-waiting reminders are separate acceptance tasks. No messages were sent by these checks.
