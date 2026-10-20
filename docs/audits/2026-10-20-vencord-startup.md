# Full Vencord native startup fix (.26)

The real Stable installation exposed two startup defects that fixture installation
and Node-only integrity checks had missed. Successful Install/Status was not proof
that Vencord had initialized.

1. Electron's patched `fs.statSync` exposes a valid `loader.asar` as a directory
   with size zero. The physical manifest verifier rejected it and the loader
   fell back to vanilla Discord. Package checks and native archive copying now
   use Electron `original-fs`; ordinary Node still uses `fs`.
2. Awaiting pending updates before native initialization allowed Electron to
   become ready. Replaying intercepted events did not reset `app.isReady()`.
   Discord/Sentry then rejected initialization. Native initialization now happens
   synchronously on the original bootstrap stack, with no event interception.
   Verified updates publish immutable files and the next-launch pointer after
   native initialization; the current instance keeps its loaded version.

## Verification

- Old .24 validator fails against a genuine ASAR in Electron 44.9.0.
- Old .25 launcher fails the synchronous native initialization regression.
- Final .26 package: 12 real Electron assertions pass (physical ASAR checks,
  same-size corruption, unexpected files, size corruption, synchronous startup,
  actual readiness, next-launch publication, no second native load).
- 14 Node distribution tests pass, including the shared updater preparing the
  next launch without network during apply or changing loaded native files.
- 95 focused Vitest updater tests pass across four files.
- Final .26 built payload Install/Status/Uninstall passes in a marked TEMP fixture.
- Local evidence: `scripts/qa/runs/d16/startup-before.json`,
  `ready-before.json`, `ready-and-copy-after.json`, `startup26.json`.

## Real Stable installation

Full Vencord .26 was built from `d9d8c4f` and installed into Discord Stable
app-1.0.9264 using the owned Update/Status workflow. The failed .25 diagnostic
processes were identified by executable, PID, start time and absence of windows
before terminating those specific processes. No working client was force-closed.

The fresh renderer journal records `Starting plugin SupportTemplates` at
2026-10-20 11:19:36.961 local time, alongside the previously enabled Vencord
plugins. The native journal records Vencord startup with no recurrence of the
ASAR integrity or early Sentry initialization failures. A Discord main window
exists. This confirms actual native/renderer/plugin initialization; visual
acceptance, template insertion and panel authentication still require live use.

Archive: `artifacts/distribution/1.0.1-canary.26/SupportTemplates-vencord-1.0.1-canary.26.zip`.
SHA256: `0b236fe7a4af987cf8ce0356122a3ca9213287859988c003d102a9ea133f0b6d`.

Only full Vencord was rebuilt and installed for this fix. BetterDiscord and the
reduced standalone client were not installed or rebuilt. Nothing was published
to GitHub. The original migration backup and private local startup logs remain
outside the repository; credentials/profile contents are not included here.

Cleanup of the owned extracted Electron QA directory was rejected by automatic
approval review (`blocked by policy`); no alternate deletion was attempted.
The TEMP directory `support-templates-startup-93965f619d534a67a4df438852690d74`
remains. The previously retained Electron download cache was not changed.
