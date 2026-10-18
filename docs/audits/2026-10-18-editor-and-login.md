# Editor clarity and post-confirmation login — Canary .8

## Scope

Owner reports slow connection after confirming login on the website, text-only color choices, and an unexplained nine-button token toolbar. No live personal template was created or edited during verification.

## Implementation

- Controlled color palette replaces the select: server-provided choices/labels, visible swatches, selected checkmark, accessible pressed state, and disabled/conflict handling.
- Two optional editor sections replace the toolbar: substitution choices explain their effect with examples; greeting controls explain cursor placement, the boundary marker, and insertion without a repeated greeting. Existing token syntax and insertion logic remain compatible.
- Initial authenticated `/me` and `/snapshot` reads overlap. Both outcomes are checked before publishing; terminal auth errors take precedence. Existing account, connection, version, scope and permissions-revision checks remain.
- Focus/visibility resumes a device poll only when its deadline has passed. The API's positive interval is required (the checked-in contract specifies five seconds); slow_down and Retry-After remain enforced. Repeated focus does not create duplicate exchanges. Cancellation/expiry still stop polling.

## Verification

- Full Vitest suite: 905 tests across 45 files passed.
- Core and Vencord typechecks passed, including final main verification.
- Actual editor components rendered in a local React browser harness at 1100×900 and 480×900. Narrow viewport has no horizontal overflow.
- Keyboard Space selects blue and sets aria-pressed. Field token inserts at the saved text cursor; successful insertion collapses the optional panel. Existing greeting boundary disables duplicate insertion.
- Synthetic save captures the selected blue color and edited text; this is a stub transport, not production API acceptance.
- `graphify update .` completed: 2130 nodes, 4385 edges. Standalone build/activation are recorded after completion.

## Limits

Live post-confirmation timing and its cause were not measured. Tests establish concurrent requests and recovery of overdue timers, not a measured real-world speedup. Owner confirmation after Ctrl+R remains required for .8 visual acceptance. Existing C06/Q10 live-write/draft checks remain separate.

## Build and activation

- Source commit: `9d12003`; isolated standalone build passed (199 source inputs and forbidden-feature checks).
- Package: `artifacts/standalone/0.1.0-canary.8-9d12003/SupportTemplates-0.1.0-canary.8/`.
- ZIP SHA256: `b66771f683ac9d8ab1369907d764c4addd6caf89967413dd185d14ebd3def1cf`.
- `UpdateRenderer -WhatIf` passed native/loader compatibility checks. Actual UpdateRenderer and Status succeeded while Discord Canary was running: renderer .8, native .6.
- Before/after hashes of runtime and owned host resources show only `runtime/renderer.js` changed. Active renderer SHA256: `349d0103b7f3676257bb191c27adc3a83a2a340111cd96e0ee89f9ea56768fba`.
- Save any open draft, then Ctrl+R applies .8. No host process was stopped. Native UI and live timing after reload await owner confirmation.
