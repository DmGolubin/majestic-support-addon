# Editor clipping and confirmation spacing — Canary .10

The sticky action row shared the settings scrollport, allowing content to remain visible below it in the bottom padding. Replaced that overlay with an independently scrolling editor body and a normal footer outside that scrollport. Header, navigation and actions retain their space. Delete/discard confirmations belong to the footer. The editor still uses a single form and the same submit/disabled handlers.

The management close warning now has a separate wrapping action group with an 8px gap, spaced from the message and inset from the dialog edges.

Verification:
- 11 relevant tests passed; Vencord typecheck passed.
- Local browser harness uses real React components, stub transport only. Inspected screenshots at 1100×700 and 480×600.
- At 360×640, top/middle/bottom scroll positions all have editor-body bottom = footer top = 574px, footer bottom = 631px, and body width = 360px. No overlap or horizontal overflow.
- Close warning button gap measured 8px. Return, deletion cancellation, and discard cancellation work. Both confirmations remain within the dialog on narrow screens. No production API mutations.
- `graphify update .` completed.

Build and renderer activation evidence follows after installation. Native UI acceptance remains pending.
