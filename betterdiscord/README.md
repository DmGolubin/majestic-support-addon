# SupportTemplates for BetterDiscord

Build the complete current `src/vencord/index.tsx`, UI, styles, fonts and `src/core`
into one `SupportTemplates.plugin.js`. Version and release repository come solely
from `distribution/config.json`; debug build info includes the source commit.

```powershell
npm ci --prefix betterdiscord
node betterdiscord/build.mjs
# Root test dependencies are installed by the repository's normal pnpm install.
npx vitest run tests/betterdiscord --maxWorkers=4
```

Output: `betterdiscord/out/SupportTemplates.plugin.js`, build evidence, exact input
sources and a ZIP. The last stdout line is JSON `{package,zip,plugin,source}` for
the parent aggregator. `--out DIRECTORY` selects a fresh output folder. The build
never reads or changes an installed Discord client. This adapter has its own
pinned build/test dependencies and does not require `VENCORD_DIR`.
The ZIP includes `tests.tar`; extract it into `source/` to run the tests from the
source package. Keeping tests archived prevents recursive Vitest discovery in build output.

After manual installation in BetterDiscord's plugins folder, enable the plugin.
Use its host settings panel, the chat toolbar button or Ctrl+Alt+T. Alt+1…9,
custom template bindings, inline triggers, previews, composition, personal library,
ticket sounds/reminders and panel login all run the current shared UI/core.
Server restrictions and the rule that text is inserted but never sent are retained.

## Host adaptation

`shims/` maps every external renderer import: BetterDiscord's own React/ReactDOM,
lazy Webpack stores and FluxDispatcher, ComponentDispatch INSERT_TEXT, BdApi.Data,
host setting preferences, clipboard, toast, chat button and error boundary.
Relative core imports resolve directly to `src/core`; no historical plugin stub
or copied UI is used. `build-evidence.json` lists every bundled input, alias and
external dependency. Unknown host imports fail the build. CSS and fonts are embedded.

Chat buttons mount next to each detected Slate composer without modifying Slate
content or patching obfuscated render functions. A MutationObserver tracks replaced
composers, and channel selection refreshes the server guard. Stop unmounts all roots,
disconnects the observer, removes styles, unsubscribes events, aborts panel work and
runs the shared keyboard/dialog/font/sound cleanup. Rapid stop/start is generation
guarded, including an unresolved storage load or updater operation.

## Panel and local secrets

`BdApi.Net.fetch` streams only to the fixed panel API origin. No redirects,
Discord cookies, implicit credentials or arbitrary headers are accepted. Shared
JSON/SSE layers retain their response limits, timeout, cancellation, OAuth scope,
account binding and error sanitization. Renderer CSP is not changed. Native 204
responses are preserved; the current shared JSON protocol decides whether an empty
response is valid (currently it expects JSON).

Standard BetterDiscord provides a limited renderer module loader. It does not expose
`node:*`, `stream`, `child_process` or `fs/promises`, and its `https` polyfill only
implements `get()`. The plugin uses the supported Net API and keeps native-only
modules lazy, behind explicit filesystem/crypto capability checks.

In a host with full native capabilities, the adapter reuses the atomic encrypted vault and cross-process lock.
When Electron exposes safeStorage (directly or through an existing remote bridge),
it uses that. On Windows, the fallback is CurrentUser DPAPI through the system
Windows PowerShell executable: a fixed command receives JSON/base64 via stdin;
no secret enters argv, environment, logs, temporary scripts or BdApi.Data. The
vault stores ciphertext under a namespace bound to BD's plugin directory and
Discord's stable/PTB/canary origin. Account IDs are validated and envelopes bound
to accounts. Stop drains accepted vault writes before releasing its lock.

In standard BetterDiscord, protected native persistence is unavailable. The shared UI supports a memory-only session
(`persistent: false`); login still works and requires reconnection after restart.
No plaintext fallback. DPAPI invokes a short synchronous process on initial probe
and token persistence because the reused vault's crypto contract is synchronous;
each invocation is bounded to five seconds. Other trusted plugins running as the
same OS user are outside this isolation boundary.

## Updates

The parent-owned engine is bundled from `distribution/updater/`. Standard BetterDiscord
does not expose the atomic file/lock operations needed by this updater. In that host,
settings explicitly say **update the plugin manually**; no unsafe filesystem substitute
or plaintext token persistence is used. Download the new `.plugin.js` from Releases,
disable the old plugin, replace it and enable it again.

In a host with full native capabilities, checks and verified downloads run automatically.
Null releaseRepository disables checks; an anonymous
404 while the repository is private is harmless and never prompts for login.
No GitHub tokens are read or embedded.

**Runtime apply is always refused.** A pending asset is applied only before plugin
startup, into a private hash-named runtime cache outside the watched plugins folder.
The manifest and bytes are checked again before requiring that runtime. The original
installed plugin is a bootstrap and remains unchanged, preventing BD's file watcher
from forcing a reload. The selected class runs through `startBundledRuntime()` /
`stopBundledRuntime()` and supplies its own settings. The next normal Discord launch
or user-initiated reload activates the update. Disable/enable also performs startup.
No drafts are discarded to apply an update, and no reload/exit is requested.

`native/updater.ts` exposes `cacheAdapter`, `cachedRuntime`, and `prepareUpdates`;
the engine and version config remain parent-owned. Cache receipt binding includes
repository and channel; corrupt or incompatible cached code falls back to the
bundled version. Updater packaging currently targets Windows; other platforms keep
the bundled runtime and can install new plugin files manually with Discord closed.

## Validation limits

Automated tests use mocked Discord/BdApi with real React and a DOM, a restricted renderer require,
streaming BdApi.Net transport
fixtures, encrypted temporary vaults and updater cache fixtures. No installed client
was modified and no release published. A real BetterDiscord session remains the
acceptance check for changing Discord Webpack/toolbar internals, panel account login,
device approval, actual Slate insertion and OS-specific safeStorage availability.
The shared debug report retains some Vencord wording, but its version/build values
identify this BetterDiscord distribution. The panel's server-side minimum-version
policy remains authoritative; a higher required version may block this canary.

Host API references: [BdApi](https://docs.betterdiscord.app/api/BdApi),
[Webpack](https://docs.betterdiscord.app/api/Webpack),
[Data](https://docs.betterdiscord.app/api/Data). Source retains GPL-3.0-or-later notices.
