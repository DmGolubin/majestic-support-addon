# A21 browser source-component regression

Latest run, 2026-10-20, Chromium 145.0.7632.6: **231 passed, 0 failed**.
`source-02` exits 0. The parent fixed the narrow media rule; this QA task made
no product changes. The previous `source-01` evidence remains untouched.

## Latest acceptance: source-02

Command:

```powershell
python -u scripts/qa/a21-ui-regression.py scripts/qa/runs/a21-ui/2026-10-20-source-02
```

- [Machine-readable checks and measurements](runs/a21-ui/2026-10-20-source-02/a21-results.json)
- [Generated report](runs/a21-ui/2026-10-20-source-02/a21-report.md)
- [Exact fixture instrumentation and source hashes](runs/a21-ui/2026-10-20-source-02/a21-instrumentation.json)

All 18 formerly failing bounds assertions now pass across three distributions,
three tabs and both narrow sizes. Dialog dimensions remain stable across tabs;
horizontal overflow and last-control reachability checks also pass.

| CSS viewport | Dialog x/y | Dialog width/height | Dialog bottom | Bottom margin |
| --- | --- | --- | --- | --- |
| 427 × 320 | 8 / 44 | 411 / 268 | 312 | 8px |
| 320 × 480 | 8 / 44 | 304 / 428 | 472 | 8px |

All account, retry, footer, counters, dirty confirmation, busy guard and mock
native chrome checks passed unchanged. There were no uncaught browser errors,
no unexpected network attempts, and no source hash changes during the run.
The read-only roadmap consistency check passed.

### Visual inspection and image paths for parentview

33 screenshots were captured. Visually inspected the general account screenshots
for all three distributions, all three 427×320 settings screenshots, and the
BetterDiscord 320×480 settings and 427×320 menu screenshots.

The desktop account card is compact, with three server icons and a short build
label (including Lite for standalone). Narrow settings now show the bottom border
inside the viewport with an 8px margin. At 320px the tabs and server row wrap
without horizontal clipping. The 427×320 settings content requires vertical
scrolling as expected; the automated last-control reachability check passes.
The narrow menu retains its single top total and all four footer shortcut groups.
No further product defect was observed in these images. The small translucent
“Settings/Menu” controls at upper left belong to Q17's fixture, not product UI.

Absolute image paths:

```text
C:/Users/oblako/dev/support-templates/scripts/qa/runs/a21-ui/2026-10-20-source-02/betterdiscord-general.png
C:/Users/oblako/dev/support-templates/scripts/qa/runs/a21-ui/2026-10-20-source-02/vencord-general.png
C:/Users/oblako/dev/support-templates/scripts/qa/runs/a21-ui/2026-10-20-source-02/standalone-general.png
C:/Users/oblako/dev/support-templates/scripts/qa/runs/a21-ui/2026-10-20-source-02/betterdiscord-settings-427x320.png
C:/Users/oblako/dev/support-templates/scripts/qa/runs/a21-ui/2026-10-20-source-02/vencord-settings-427x320.png
C:/Users/oblako/dev/support-templates/scripts/qa/runs/a21-ui/2026-10-20-source-02/standalone-settings-427x320.png
C:/Users/oblako/dev/support-templates/scripts/qa/runs/a21-ui/2026-10-20-source-02/betterdiscord-settings-320x480.png
C:/Users/oblako/dev/support-templates/scripts/qa/runs/a21-ui/2026-10-20-source-02/betterdiscord-menu-427x320.png
```

## Reproduce

From the repository root:

```powershell
python -u scripts/qa/a21-ui-regression.py
```

The runner invokes the existing `scripts/qa/q17-ui-harness.mjs` into a new
timestamped `scripts/qa/runs/a21-ui/` directory. An explicit fresh run directory
can also be passed. Existing evidence is never overwritten.

## Previous evidence: source-01

2026-10-20, Chromium 145.0.7632.6: **213 passed, 18 failed**, exit 1.
Preserved run: `scripts/qa/runs/a21-ui/2026-10-20-source-01/`.

- [Machine-readable checks and measurements](runs/a21-ui/2026-10-20-source-01/a21-results.json)
- [Generated report](runs/a21-ui/2026-10-20-source-01/a21-report.md)
- [Exact fixture instrumentation and source hashes](runs/a21-ui/2026-10-20-source-01/a21-instrumentation.json)
- [Normal account screenshot](runs/a21-ui/2026-10-20-source-01/betterdiscord-general.png)
- [Offline retry failure screenshot](runs/a21-ui/2026-10-20-source-01/betterdiscord-offline-retry.png)
- [Dirty backdrop confirmation screenshot](runs/a21-ui/2026-10-20-source-01/betterdiscord-dirty-confirm.png)
- [Pending-save busy guard screenshot](runs/a21-ui/2026-10-20-source-01/betterdiscord-busy-guard.png)
- [Native chrome mock screenshot](runs/a21-ui/2026-10-20-source-01/betterdiscord-native-chrome.png)
- [Narrow settings defect screenshot](runs/a21-ui/2026-10-20-source-01/betterdiscord-settings-427x320.png)
- [Narrow menu screenshot](runs/a21-ui/2026-10-20-source-01/betterdiscord-menu-427x320.png)

There are 51 screenshots, including each failed assertion.

## Historical defect, resolved in source-02: P2 narrow settings extends below viewport

The following describes the source-01 snapshot before the parent's fix.
It reproduced for `?distribution=betterdiscord`, `vencord`, and `standalone`,
on each of “Мои шаблоны”, “Настройки”, and “Тикеты”.

| CSS viewport | Dialog x/y | Dialog width/height | Dialog bottom | Overflow |
| --- | --- | --- | --- | --- |
| 427 × 320 | 8 / 44 | 411 / 304 | 348 | 28px below viewport |
| 320 × 480 | 8 / 44 | 304 / 464 | 508 | 28px below viewport |

The backdrop starts at y=36 to preserve native chrome and has 8px padding
at these widths. In `src/vencord/styles.css:228`, the `max-width:600px`
rule sets dialog `height` and `max-height` to `min(720px, calc(100dvh - 16px))`,
omitting the chrome height that the desktop rule subtracts.
The resulting y=44 plus height=viewport height−16 puts its bottom 28px offscreen.
Both narrow height declarations should also subtract `var(--stx-window-chrome, 36px)`.
No product fix was made: this task owns only new A21 QA files.

The 18 failed assertions are one defect, not 18 independent defects.
Horizontal content overflow checks and tab dimension stability still pass.
At 1200×900 and 640×480 the dialog fits. Scrolling can bring the last general
control into view; this does not make the initial dialog bounds fit.

## Passed coverage

- Three distribution query values; common short build label, Lite naming,
  technical version/build in tooltip.
- Compact connected account card, three supported servers and loaded 18px fallback
  icons; normal state omits verbose status panels.
- Offline status, retry failure and recovery, preferences retry. Instrumented
  stub call counts verify dispatch; these are not live API requests.
- Backdrop blur, inside click preservation, clean background dismissal,
  dirty prefix and personal-draft confirmation, return preserving draft,
  explicit discard without saving the prefix.
- A real component save action held by a mock Promise: background and Escape
  cannot close, no close confirmation opens, header close and tabs are disabled.
  Closing works after the mock save resolves.
- Three mock native window-control buttons receive clicks at y=20 without closing
  settings; backdrop respects default 36px and custom 52px/28px topbar values.
- Single top total; category, combined search, zero-results, recent, favorite,
  and reset counts. No counts in category options or section headings.
- Menu footer styling, all four shortcut groups, menu viewport fit at desktop
  and 427×320; no horizontal settings overflow and stable dimensions across tabs
  at 1200×900, 640×480, 427×320 and 320×480.
- No uncaught page errors or unexpected network attempts. Source hashes remained
  unchanged during the run. Read-only `node scripts/roadmap.mjs --check` passed.

## Boundaries

Browser context was offline, HTTP and WebSocket requests were denied, and service
workers were blocked. No Discord process, real account, backend, packaged
distribution, or release bundle was used.

All distribution queries use the same Q17-built source component bundle.
Q17 imports both shared styles and the BetterDiscord adapter CSS. This is not
distribution packaging or host-theme acceptance.

Only three generated `stub:panel` function bodies were instrumented, with
exact-match guards: reload and preferences retry count calls and update fixture
state; save can await a controllable Promise. No source components were rewritten.

`GuildStore` returns null, so these tests cover bundled fallback icons, not live
Discord CDN icons. The window controls are DOM mocks, not actual native OS controls.
Reduced CSS viewports do not test Electron zoom. No source, distribution,
standalone, existing scripts/tests, roadmap, or commits were changed by this task.
