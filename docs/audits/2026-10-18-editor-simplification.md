# Editor simplification — Canary .9

Owner explicitly requested only fill-in fields and greeting controls. Removed list/date/time/clipboard/selection/channel-link/channel-title builders and the intermediate choice grid from the editor. The field disclosure now opens its form directly. Existing stored template parsing remains compatible; no stored content was rewritten.

Validation: 11 relevant tests passed (tokenEditor and panelPersonalLibrary); Vencord typecheck passed. Actual React components in the local browser harness at width 480 expose exactly two toolbar controls. Field insertion preserved the cursor position; greeting boundary insertion worked and duplicate insertion was disabled. No horizontal overflow. No production panel writes. `graphify update .` completed.

New capabilities are deferred until concrete employee requests establish a need. Canary .9 build and activation evidence follows after installation; owner visual acceptance remains pending.
