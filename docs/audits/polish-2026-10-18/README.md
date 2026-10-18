# Current-app polish — 20 independent reviews

Date: 2026-10-18. Requested by the owner. Twenty distinct agents reviewed the current SupportTemplates application in waves of up to six concurrent agents. Each report records evidence and limitations; the coordinator reviewed and integrated the accepted patches. No new end-user features were added.

## Review disposition

| Review | Area | Disposition |
| --- | --- | --- |
| [01](01.md) | Personal saves and retries | Fixed mutable-folder/palette validation rejecting a dispatched or confirmed action. Original request identity and permission checks remain enforced. |
| [02](02.md) | Authentication | No verified defect. |
| [03](03.md) | Synchronization | No verified defect. |
| [04](04.md) | Transport | No verified defect. |
| [05](05.md) | FAQ conversion | Preserved URLs containing mention-like text; prevented quoted attribute contents being mistaken for link destinations. |
| [06](06.md) | Search | Fixed shortest-subsequence matching and aliases for current Media/Steam titles. |
| [07](07.md) | Menu keyboard behavior | Native preview buttons retain Enter/Space; composition keys no longer activate context actions. |
| [08](08.md) | Inline suggestions | Stale suggestions no longer consume keys after focus/trigger changes. |
| [09](09.md) | Insertion cancellation | Changed drafts invalidate delayed insertions; cancelling a field/confirmation dialog restores focus only in the original valid context. |
| [10](10.md) | Collected reply | A disconnected initial target is released so the next explicit attempt can recover, retaining the collected reply. |
| [11](11.md) | Field values and greeting | Replacement values remain literal; removing the greeting preserves body indentation. |
| [12](12.md) | Dropdown bounds | Popup height/direction respects all enclosing clipping scrollports. |
| [13](13.md) | Settings and dialogs | Unsaved prefix edits get confirmation; IME Escape does not dismiss dialogs. Focus cancellation fix integrated with review 09. |
| [14](14.md) | Responsive editor | No additional verified defect; hypotheses remain distinct from findings. |
| [15](15.md) | Visual consistency | Supported yellow/purple/cyan names now have correct swatches and Russian fallback labels. |
| [16](16.md) | Ticket sound | Successful playback cannot hide a failed settings save; persistence/playback errors clear independently. |
| [17](17.md) | Local preferences | No verified defect. |
| [18](18.md) | Lifecycle | Store hooks catch changes between initial render and subscription. |
| [19](19.md) | Renderer updater | No verified defect. Agent's fixture selection was partial; coordinator runs the complete suite separately. |
| [20](20.md) | Build/loader/native boundary | Rediscovered existing Q11: prerelease host-path grammar mismatch. Kept as a separate loader task; current host uses app-1.0.1251. |

Coordinator also fixed the editor footer becoming unreachable on short windows. Below 540px viewport height the whole form scrolls; ordinary windows keep the separate editor body and footer.

## Integration notes

- FAQ mention neutralization is local to both conversion modules because the standalone HTML converter and Vencord's virtual core layout have different import roots. Both paths have regression coverage.
- Review 07/08/10/15 fixes were applied by the coordinator after the agents' read-only reports. Review 13 cancellation focus was implemented in the flow owned by reviewer 09.
- Scope remains field-for-filling and greeting only in the editor toolbar. Existing stored tokens stay compatible.
- The observed first-save failure is not causally explained: the owner confirmed the second attempt worked, but the first HTTP response is unavailable. The verified save race is independently covered; no live write was used to claim the original incident resolved.
- Q11 changes loader identity and is outside this renderer-only hot update. It remains planned for a separately tested full-runtime release. No prerelease host directory was observed on the current installation.

## Browser evidence

Actual React components with synthetic transport at a local loopback harness; no panel write or Discord message.

- Editor checked at 900×675, 480×600, 360×640, 700×400 and 320×480 without horizontal overflow.
- At 320×480, footer formerly extended to y=504 beyond dialog bottom y=472. After the fix it is reachable within the dialog (final check y=359.8–456.8).
- At 900×550 with 12 synthetic folders, popup y=369.8–468.3 stays inside editor clip y=219.3–472; list itself scrolls.
- Dirty close/return retains the draft. Synthetic network failure preserves the draft and offers retry.
- Prefix edit `!` prompts on close and tab switch, return retains it, explicit discard restores `;`.
- Actual computed alias swatches: yellow rgb(234,179,8), purple rgb(139,92,246), cyan rgb(20,184,166), with Russian labels.

## Automated verification

- Final Vitest run: **1026 tests in 50 files passed** (baseline 905/45).
- The combined run initially exposed four failures in an older function-extraction harness: its VM lacked the new flow sequence state. The harness context was updated; the separate whole-module flow tests exercise the production state and cancellation behavior. The complete suite then passed.
- Core TypeScript check passed; the actual plugin's virtual Vencord layout check passed during integration. Final delivery checks are appended after packaging.
- Graphify AST graph rebuilt successfully. No semantic/API extraction was requested.

Native Discord visual acceptance remains with the owner after Ctrl+R.

## Delivery

- Implementation commit: `5e8c306`.
- Isolated pinned-source build succeeded: `0.1.0-canary.11`, 199 source inputs; forbidden-feature checks passed.
- Artifact: `artifacts/standalone/0.1.0-canary.11-5e8c306/SupportTemplates-0.1.0-canary.11.zip`.
- ZIP SHA-256: `7cb26729dc65fad6c7e2d440c0bd7ccf066489fc234200e6910ac9d04a06eb12`.
- Final core and Vencord overlay typechecks passed. No production code changed afterward.
- `UpdateRenderer -Channel Canary -WhatIf` passed, then actual update completed. Read-only `Status` confirms renderer `.11`, native runtime `.6`, current host `DiscordCanary/app-1.0.1251/resources`.
- Activation needs Ctrl+R after saving any open draft. No Discord process was stopped; this task did not send messages or write live panel records.
- Coordinator's complete installer fixture run is recorded separately once finished; all 15 renderer-update fixture groups already passed before activation.
