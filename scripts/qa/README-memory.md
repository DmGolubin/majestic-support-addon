# Local BetterDiscord soak

These scripts only exercise an isolated Chromium fixture. They never install or publish
the plugin, contact the panel, or modify `artifacts/memory19`. They do not verify native
protected storage or a real Discord/BetterDiscord renderer.

Prepare **after** the parent confirms a source freeze and finishes building:

```powershell
node scripts/qa/prepare-memory-harness.mjs --bundle betterdiscord/out/SupportTemplates.plugin.js --out scripts/qa/runs/RUN/harness
python scripts/qa/memory-faults.py --harness scripts/qa/runs/RUN/harness --out scripts/qa/runs/RUN/faults
python scripts/qa/memory-fixture-check.py --harness scripts/qa/runs/RUN/harness --out scripts/qa/runs/RUN/fixture
python scripts/qa/memory-control.py --harness scripts/qa/runs/RUN/harness --out scripts/qa/runs/RUN/control --seconds 60
python scripts/qa/memory-debug.py --harness scripts/qa/runs/RUN/harness --out scripts/qa/runs/RUN/debug --seconds 60
python scripts/qa/memory-observer-origin.py --harness scripts/qa/runs/RUN/harness --out scripts/qa/runs/RUN/observers
python scripts/qa/memory-soak.py --harness scripts/qa/runs/RUN/harness --out scripts/qa/runs/RUN/smoke --smoke --seconds 45 --cycles 10 --sample-seconds 10
```

Use a new `RUN` whenever the bundle/harness changes; existing evidence is never overwritten.
The copied bundle's hash, build-input hashes, source HEAD and dirty state are recorded.
Final runs require matching build evidence and source inputs. QA script and served-asset
hashes are recorded separately; the instrumentation is copied to the results directory.

After successful gates, launch the hour against the same captured bundle, supplying the
exact `pluginSha256` from its provenance:

```powershell
python scripts/qa/memory-soak.py --harness scripts/qa/runs/RUN/harness --out scripts/qa/runs/RUN/hour --source-fixed --expected-sha256 SHA256 --seconds 3600 --cycles 1000 --sample-seconds 30 --heap-growth-mib 2 --dom-growth 10 --listener-growth 5 --idle-cpu-percent 1
```

The hour starts after login and 20 excluded warmup cycles. Twenty interleaved batches
total 1,000 full picker/settings/editor open-close cycles (including the first 500).
Passive closed/picker/settings windows fill each batch's remainder. Two network outages
must recover automatically to ready with a fresh SSE connection; no re-login is allowed.
Tokens expire after 900 real seconds, send `token.expired` through SSE, and rotate unique
single-use pairs. At least three real expiry/refresh cycles must succeed.

`soak-results.json` is atomically checkpointed every 30 seconds and at phase transitions.
It records pre/post-GC performance counters, heap, DOM/listeners, attributed observer,
timer/frame counts, subscriptions, streams, fixture requests/refresh counts and assertion
outcomes. Missing checkpoints over 60 seconds fail. CPU is Chromium renderer main-thread
TaskDuration, **not** process/machine CPU; idle intervals exclude action/transition/GC work
and are reported separately by window state. Thresholds compare closed state to post-warmup
closed baseline. Threshold violations remain failures; never raise limits to obtain a pass.

Stop asserts no owned roots, mounts, fonts, subscriptions, streams, plugin observers,
plugin/fixture timers, target refs or visible items; a second sample checks quiescence.
Only Playwright's own attributed observer may remain. Instrumentation stores WeakRefs,
not strong observer/DOM references. Legacy `.19` counters included Playwright's observer.

Fault checks also repeat 30 starts/stops and 100 native-host settings-root mounts. Permanent
unsubscribe failures must block remount and avoid duplicate subscriptions, then recover
after the host is repaired. Unrelated DOM mutation churn must schedule zero plugin RAFs.

Exit status is 0 only for pass. Exceptions preserve partial evidence and close owned
contexts/browser/server. A smoke pass explicitly excludes hour and real-900s coverage.
