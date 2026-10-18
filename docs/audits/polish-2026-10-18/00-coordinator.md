# Current-app polish — coordinator evidence

User requested twenty individual agents. Runtime allows six concurrently; dispatch twenty distinct focused reviews in waves. Reviews initially write only their own report; patches follow triage with disjoint ownership. No live panel write or Discord message is part of the test plan.

Baseline: 905 tests / 45 files pass. Current installed renderer .10; native .6. Existing first-save report remains unresolved: owner reports retry succeeded, original HTTP response unavailable.

## Browser checks on actual components with stub transport

- 900×675, 480×600, 360×640, 700×400, 320×480 editor layouts checked; no horizontal overflow.
- Verified defect: at 320×480 with dirty-close confirmation, editor footer extended to y=504 while dialog ended at y=472. The stacked fixed sections consumed the viewport.
- Coordinator patch: below 540px viewport height, scroll the complete form instead of retaining a fixed footer; no sticky overlay. Retested 320×480: save button reachable at y=439–471. Normal-height independent editor scroll is preserved.
- Stub network failure: input becomes locked, retry stays enabled, dirty title remains intact across close-warning/return. No production write was sent.

Other reports and accepted/rejected findings will be consolidated after all twenty reviews.
