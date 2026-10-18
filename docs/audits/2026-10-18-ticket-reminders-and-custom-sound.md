# Ticket reminders and custom sound

Owner request: show the remaining findings from the twenty reviews, add a local sound file, connect the reminder API, round the volume label, and retain server-card appearance without links.

## Implemented

- Server cards are static elements, without click handlers, links or tab stops. Volume displays an integer percentage and the slider uses a one-percent step.
- Local MP3/WAV/OGG/M4A/FLAC selection, maximum 5 MiB and 30 seconds, validated by audio decoding; reset to the standard sound. Filename and local bytes are stored without remote URLs. Import/reset/runtime generations reject late completions.
- Existing notification volume and chosen sound also apply to assigned-ticket reminders. The new-ticket enable switch remains independent.
- Explicit authorization requests `tickets:assigned:read`, `notifications:settings:read`, and `notifications:settings:write`. Restoring old credentials never silently upgrades scopes. The UI offers authorization when access is missing.
- GET `/notification-settings` provides the switch, raw version and read-only Telegram thresholds. PATCH sends only `discordEnabled`, with quoted If-Match. Concurrent reads cannot overwrite a newer write. An uncertain write or conflict requires a fresh read before another choice; it is not automatically replayed.
- GET `/tickets/assigned` is validated against the current account/projects. Server timestamps and reminder IDs drive reminders. A fresh read verifies assignment, waiting state, enabled delivery and due time before each attempt. SSE invalidations, account/session/permission changes and token expiry cancel obsolete delivery; polling uses jitter and Retry-After.
- Receipt persistence precedes sound scheduling. The key is account + project + ticket + reminder ID; late callbacks carry both adapter and engine validity guards. No Discord messages or Telegram settings are written.

## Verification and limits

Tests use synthetic API, storage and audio implementations. Actual React settings were checked in a loopback browser harness at 900×675, 360×640 and 320×480 without horizontal overflow. The volume label renders `84%` for the supplied fractional value. All three server cards have tag DIV, no click handler and tabIndex -1. Filename selection/reset were checked with a UI stub; actual decoding and persistence have separate runtime tests.

Browser screenshots are retained in the task workspace under `.playwright-mcp/ticket-settings-custom-sound.png`. Real Discord audio, production reminder assignment/reassignment and new authorization acceptance remain unverified until the owner uses the updated client. The implementation follows the supplied local API contract, not a live API probe.

The deduplication log preserves opaque historical reminder IDs: after 10,000 receipts it fails closed and displays unavailable delivery rather than discarding IDs and risking duplicate sounds. Cross-device delivery is not coordinated by this client. Muted/blocked audio and cancellation after durable receipt persistence consume an attempt; the next server reminder ID remains eligible. These are explicit limits, not claims of audible delivery.

## Remaining findings from the earlier review

- **Q11:** the loader rejects prerelease host directories accepted by the installer (for example `app-1.0.1251-beta.1`). The installed `app-1.0.1251` is unaffected. A separately tested full-runtime update is required; this renderer update does not modify the loader.
- **Q09:** recovery when local IndexedDB initialization rejects remains planned. It predates the twenty-review pass.
- The original first-save failure is still not causally identified; the owner reported the second attempt succeeded, without the first HTTP response. The independently reproduced save race was fixed in .11.
- Live acceptance of login latency, SSE/revocation, insertion and the native UI remains distinct from automated coverage.

## Automated verification

- Full Vitest suite: 1,267 tests across 54 files passed. The old server-card test now requires static cards, matching the new request.
- Core and virtual Vencord typechecks passed.
- After that full pass, removed an unnecessary exception that silently ignored malformed audio records; corrected the old storage mock to respect keys. The affected two runtime files passed all 47 tests afterward. No other production change followed.
- Audio bytes have a separate storage key: slider changes write only the small options record. Independent ordered write queues preserve audio/options errors separately.
- Graphify AST graph regenerated; generated roadmap views checked.

Delivery evidence follows after packaging.
