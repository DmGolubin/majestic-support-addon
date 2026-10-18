# SupportTemplates standalone: packaging, security and dependency audit

Date: 2026-10-18. Scope: read-only composition review; this report is the only file written by the auditor. No Discord process was started/stopped, no installed Discord/Vencord files were changed, and no packages or lockfiles were upgraded. Installer behavior and live Discord acceptance belong to the parent/installer reviewers.

## Result and exact evidence

The parent's **four-plugin renderer registry is sufficient on the inspected source evidence**. No additional mandatory framework plugin was found. The successful minimal build removes the cloud/settings/badge import leak identified in the first build. Its **only emitted third-party npm implementation is `@intrnl/xxhash64@0.1.2`**. Native and preload bundles contain no npm package implementations. This is composition evidence, not proof that patches match the current Discord build.

Reviewed roots:

- Project: `C:/Users/oblako/dev/support-templates`; plugin revision observed: `29e94b82d316a8dccd0e1d649da30883272b9114`, plus the parent's concurrently developed standalone files.
- Upstream: `C:/Users/oblako/dev/Vencord`, verified HEAD `32c90633ce6a95d7e56c95479efbb431bacf1eac`, package version `1.15.11`. Tracked package/lockfile/src/scripts diff was clean during this audit.
- Successful build source: `C:/Users/oblako/AppData/Local/Temp/support-templates-standalone-wwoFXe/source`.
- Primary evidence: that source directory's `build-evidence/metafile-0.json`, `metafile-1.json`, `metafile-2.json`, and `inputs.json`; also the actual generated JS/CSS source map metadata and staged source transforms.
- Rejected first build: `C:/Users/oblako/AppData/Local/Temp/support-templates-standalone-YxMCR8/source/build-evidence`. Findings from it are recorded below as **resolved in the successful build**, not current shipping defects.
- Commands/runtime: Node `v24.12.0`, pnpm `11.9.0`; read-only `pnpm audit --json` in both repositories and `pnpm audit --prod --json` upstream. `node scripts/roadmap.mjs --check` passed when run. Roadmap files were not edited by the auditor because the task explicitly limits writes to this report.

Paths below beginning `src/` refer to upstream/staged source unless prefixed with `project:`. Parent implementation paths beginning `standalone/` refer to the project.

## Renderer allowlist and necessary bridges

The approved registry is exactly:

| Plugin | Source | Reason and enabling behavior |
| --- | --- | --- |
| `SupportTemplates` | `project:src/vencord/index.tsx`, staged as `src/userplugins/supportTemplates/index.tsx` | Application plugin. `standalone/compile.mjs` sets `support.required = true` before `initPluginManager()`, so a fresh profile starts it without importing normal Vencord settings. |
| `ChatInputButtonAPI` | `src/plugins/_api/chatButtons.ts` | Required for the chat-bar insertion patch. `src/api/PluginManager.ts:360` detects `chatBarButton` and force-enables this API. Omitting it causes an unguarded `Plugins[p].isDependency` access during initialization. |
| `Settings` | `standalone/runtime/settings.tsx`, staged under `src/standalone/` | Replacement plugin with one SupportTemplates tab. It is **not** the upstream `src/plugins/_core/settings.tsx`; it imports the application settings screen directly. |
| `ConcatenatedComponentExtractor` | `src/plugins/_core/concatenatedComponentExtractor.tsx` | Retains framework extraction of ColorPicker, scroller factory and RoleMemberPopout. Required by its own definition; its patches use `$self` callbacks. The current application UI does not itself require all three extracted components, but keeping this small compatibility helper is reasonable. |

The absolute feature minimum is SupportTemplates plus ChatInputButtonAPI when the application's own management window is sufficient. The chosen four-entry registry also provides the requested Discord settings entry and shared component compatibility. There is no reason to add all `_core` or `_api` plugins.

**Conditional `ContextMenuAPI`:** stock `src/api/ChatButtons.tsx:160` registers a `textarea-context` callback to show “Vencord Buttons” checkboxes. The chat-bar button itself uses `Clickable` and `Tooltip` and does not require ContextMenuAPI. Omitting this plugin intentionally drops that stock context-menu feature; SupportTemplates' own context menu is implemented separately. Prefer removing the unused registration from the fork, or explicitly accept it as inert. If the feature is restored, add both `ContextMenuAPI` and `Vencord.Api.ContextMenu`; adding only the plugin would introduce patches calling a missing global API. This is not a blocker for registry4.

Required global hooks were checked against `Vencord.*` references in source inputs contributing emitted bytes:

| Retained hook | Caller / purpose |
| --- | --- |
| `Vencord.Api.PluginManager.subscribeAllPluginsFluxEvents` | `src/webpack/common/utils.ts:28`, FluxDispatcher discovery. `standalone/runtime/api.ts` exports this API. |
| `Vencord.Api.ChatButtons._injectButtons` | Replacement text in `src/plugins/_api/chatButtons.ts:20`. Exported by the minimal API. |
| `Vencord.Api.Themes.initQuickCssThemeStore` | `src/webpack/common/stores.ts:189`, ThemeStore discovery. The no-op bridge is necessary even though custom themes are removed. |
| `Vencord.Plugins.plugins` | `$self` expansion in `src/api/PluginManager.ts:78`, including Settings and ConcatenatedComponentExtractor callbacks. Keep the PluginManager export and registry. |
| `Vencord.Webpack.Common.React` | `src/components/ErrorBoundary.tsx:52` and `REACT_GLOBAL` in `src/utils/constants.ts:19`. Keep the Webpack barrel/Common export. |

`standalone/runtime/renderer.ts` also keeps Settings/PlainSettings, patcher/Webpack exports, `initStyles()`, and the Init/WebpackReady/DOMContentLoaded start stages. The retained `initStyles()` needs the native renderer-CSS and system-theme-values IPC handlers, despite removal of user themes; `standalone/runtime/ipc.ts` supplies them. Preload needs the plugin method map, settings get/set, renderer JS getter and file-watcher no-op. The panel login flow needs CSP permission methods; the minimal native implementation reports only the fixed panel origin and `connect-src` as allowed.

No retained plugin needs CommandsAPI, UserSettingsAPI, MessageEventsAPI, MessageAccessoriesAPI, MessageDecorationsAPI, MessagePopoverAPI, MemberListDecoratorsAPI, ServerListAPI or DynamicImageModalAPI. Normal command/message API source helpers can still be imported by PluginManager; importing those helpers does not mean their Discord patch plugins are registered.

Other upstream mandatory flags are product defaults, not SupportTemplates dependencies:

- `BadgeAPI`: donor/contributor UI and periodic badge fetches when started. Excluded.
- `NoticesAPI`: notice lifecycle patch; relevant to generic plugin-manager notices, not the selected replacement settings screen. Excluded.
- `SupportHelper`: Vencord support/debug commands and `dependencies: ["UserSettingsAPI"]`; its commands also cause automatic CommandsAPI inclusion. Excluded.
- `NoTrack`: changes Discord telemetry/error reporting. It is an independent policy/behavior choice, not a prerequisite for the adapter. Excluded.
- `FixDiscordCss`: separate Discord stylesheet workaround, not an adapter dependency. Excluded.
- Upstream `Settings`: stock settings, plugins, themes, cloud and backup UI. Replaced rather than retained.

## Import leak found and fixed

The rejected first build's metafile gave this exact dependency route:

```text
src/standalone/renderer.ts
  -> src/api/PluginManager.ts
  -> src/api/Badges.ts
  -> src/plugins/_api/badges/index.tsx
  -> src/components/settings/tabs/index.ts
  -> src/components/settings/tabs/sync/CloudTab.tsx
  -> src/api/SettingsSync/cloudSetup.tsx
```

This was emitted implementation, not just parsed source: cloudSetup contributed 2,118 bytes, cloudSync 3,620 bytes, and the badge plugin 3,352 bytes. The same settings barrel retained upstream Settings and ClientTheme code. Therefore neither filtering `~plugins` nor disabling a plugin setting was sufficient.

The parent resolved this in `standalone/build.mjs` by replacing **only the unused `addProfileBadge`/`removeProfileBadge` import** in the staged PluginManager with a throwing stub. None of registry4 declares `userProfileBadge`, so this deliberately unsupported path is not used. The successful metafiles contain no badge plugin, ClientTheme, upstream Settings, settings UI barrel, cloud sync or native updater/persistence/extension modules. Keep the fail-closed forbidden-input assertion; do not relax it to fix this class of import leak. Future additions of plugin hooks must expand the explicit dependency policy or fail before release.

## Native allowlist and update/persistence boundary

The native plugin registry must be exactly `SupportTemplates`, with these four exported IPC operations from `project:src/vencord/native.ts`:

```text
panelVaultAvailable
panelVaultLoad
panelVaultSave
panelVaultClear
```

Upstream `scripts/build/build.mjs` has a separate `globNativesPlugin`, scanning `plugins` and `userplugins` independently of the renderer allowlist. `src/main/ipcPlugins.ts` registers every exported native method regardless of renderer enablement. The inspected checkout contains unrelated native entrypoints for ConsoleShortcuts, FixSpotifyEmbeds, FixYoutubeEmbeds, OpenInApp, Translate, VoiceMessages, XSOverlay and YoutubeAdblock. None belongs in this product. The parent's explicit `~pluginNatives` registry avoids this glob.

`--standalone` upstream means a distributable build/update mode, not a plugin or settings sandbox. `--disable-updater` removes the HTTP/git updater import, but **does not remove `src/main/persistAfterDiscordUpdates.ts`**. Upstream `src/main/patcher.ts:48` loads that module independently; it hooks `host-updated` and `before-quit` and can rename/copy `resources/app.asar` in sibling `app-*` versions. `DISABLE_UPDATER_AUTO_PATCHING` only makes its patch function return early.

The successful staged build removes that module's import entirely, removes forced appSettings/devtools mutation and the legacy `process.env.DATA_DIR` assignment, uses the minimal `main.ts`/`ipc.ts`, and excludes both updater implementations. Metafile-0 confirms no updater, persistence, extensions, Monaco or stock ipcMain module. The loader additionally sets `DISABLE_UPDATER_AUTO_PATCHING=1`; that is defense in depth, not the primary removal.

Upstream preload/VencordNative still defines some facade methods for removed functionality, such as updater/theme/QuickCSS methods. Their native handlers and implementations are absent; those facade names alone are not evidence that an updater was shipped. The actual enabled renderer paths must never call them. A later cleanup may narrow the facade, but preserve the startup hooks listed above.

## Settings, storage, cloud and host permissions

| Surface | Baseline hazard | Inspected fork behavior |
| --- | --- | --- |
| Native settings | Upstream DATA_DIR honors `VENCORD_USER_DATA_DIR` / `DISCORD_USER_DATA_DIR`, otherwise uses a sibling `Vencord` directory. Settings/native-settings/QuickCSS share that root. | Staged constants accept only `SUPPORT_TEMPLATES_DATA_DIR` and throw when missing. Loader validates a channel-specific `%LOCALAPPDATA%/SupportTemplates/channels/<channel>/data` destination. |
| IndexedDB | `src/api/DataStore/index.ts:60` defaults to `VencordData` / `VencordStore`; changing DATA_DIR alone does not isolate it. | Staged database/store names are `SupportTemplatesStandaloneData` / `SupportTemplatesStandaloneStore`. Database isolation is still within the host Electron profile/origin. |
| Application keys | `project:src/vencord/platform.ts` uses the framework's default DataStore. Keys include `SupportTemplates_v2`, legacy `SupportTemplates_data`, and per-account `SupportTemplates_panel_preferences_v1_...`. | Unchanged keys are safe from normal Vencord collision because the database itself is renamed. Do not auto-copy VencordData or legacy native settings as part of installation. |
| Native panel vault | Vault root is DATA_DIR + `support-templates-vault-v2` + hash(real userData path, Discord origin), with account files below it. | New DATA_DIR separates the fork. Existing trusted-main-frame checks, safeStorage encryption availability checks, account validation and process/WebContents ownership remain. No plaintext fallback was introduced. |
| Cloud settings | Stock Vencord calls syncSettings at startup, stores `Vencord_cloudSecret` in IndexedDB and dirty/direction flags in localStorage; hiding CloudTab would not disable it. | Minimal renderer does not call cloud setup/sync. Successful metafiles exclude `src/api/SettingsSync/*` and the cloud tab. Baseline default cloud URL/type fields are not evidence of networking when the implementation is absent. |
| IPC naming | Upstream channels/native mapping keys use Vencord names. | Staging renames enum channel prefixes and native mapping prefix to SupportTemplatesStandalone. Global `Vencord`/`VencordNative` JS names remain framework compatibility names; this is not permission to inject both mods into one renderer. |
| CSP/network | Stock policy includes CDN scripts, third-party plugin domains, localhost and user overrides independently of plugin enablement. | Staged static additions are limited to `https://panel.majestic-rp.tech` for connect-src; inherited custom overrides are ignored. Minimal permission IPC rejects arbitrary overrides. |

The vault's protection is against untrusted frames, unsafe persistence and competing owners, **not other code executing in the same trusted Discord renderer or an attacker controlling the OS account**. Do not advertise sandboxing between plugins. Namespaced storage also does not give the fork a separate Discord login/session profile; it isolates SupportTemplates state inside the chosen host profile.

CSP still uses the upstream patching machinery, including inline/eval and scheme allowances, and upstream BrowserWindow patching still sets `sandbox=false`. These are retained mod-framework security properties, not npm vulnerabilities and not removed by registry4. The package should describe itself as a reduced client modification, not a hardened Electron sandbox.

Targeted follow-up: apply the native vault's sender/main-frame/origin validation pattern to the minimal generic settings, renderer-code and external-link IPC handlers if a stricter native boundary is desired. Current generic handlers inherited from `src/main/settings.ts` and `standalone/runtime/ipc.ts` do not all validate the sender. This does not change the plugin dependency list. Keep unsupported native operations unavailable rather than reintroducing stock ipcMain.

## What actually enters the successful runtime

Evidence is calculated from `metafile.outputs[*].inputs[*].bytesInOutput > 0`, not merely package.json, lockfile, or metafile.inputs membership. All three bundle output-import lists were also checked: renderer has no external imports; native/preload external imports are Node builtins and host Electron (`electron`, `electron/renderer`), with no unpackaged npm dependency.

| Bundle | Parsed inputs | Emitted npm implementation | JS bytes |
| --- | ---: | --- | ---: |
| `patcher.js` | 15 | None | 16,886 |
| `preload.js` | 5 | None | 2,866 |
| `renderer.js` | 178 | `@intrnl/xxhash64@0.1.2`: 2,391 contributed bytes | 484,402 |

Combined unique input count: **193**. Renderer CSS is 37,266 bytes. Source maps and the renderer legal-notices file are separate outputs. Byte counts identify this build and are not promised for future rebuilds.

`@intrnl/xxhash64` is used by `src/utils/intlHash.ts` for Discord internationalization/patch matching. Keep it; it is not an optional plugin dependency. No advisory was returned for this version in the workspace audit.

`diff@9.0.0` appears among parsed renderer inputs, but contributes **zero executable bytes** and is absent from `renderer.js.map` sources/content. Do not count it as shipped runtime code merely because it appears in `metafile.inputs`. It remains part of the build/source dependency inventory. `nanoid` and `fflate`, which were present in the rejected cloud-import build, contribute no code and do not appear among the successful build's npm inputs.

Other upstream dependencies—Monaco/DOMPurify, Moment packages, gifenc, @vap/core/@vap/shiki, virtual-merge, lint/test/transformation packages—are not executable dependencies of these three successful bundles. React, Discord stores/components and Electron come from the host; npm audit of this repository does not audit those host implementations. DataStore includes vendored idb-keyval-derived source, so retain its notice even though it is not a separately installed runtime package.

The exact-source archive may intentionally include excluded plugin source, unused build scripts, workspace packages and the full upstream lockfile for provenance. This is **source-only material**, not additional enabled plugins or shipped executable module implementations. The source archive must not contain node_modules, personal settings, tokens or local untracked userplugins. `standalone/build.mjs` uses the pinned git archive and explicit SupportTemplates overlays instead of syncing into the base checkout.

## Package audit results and targeted treatment

Online advisory responses were obtained read-only on the audit date; no `audit --fix`, install, update, sync or injector commands were run. Counts are advisory records from the tooling, not counts of independently exploitable runtime bugs.

| Audit scope | Critical | High | Moderate | Low | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| Full Vencord workspace | 0 | 35 | 26 | 5 | 66 advisory records; reported total dependency count 586. Includes build/lint/type/workspace graph. |
| Vencord `--prod` | 0 | 2 | 15 | 5 | 22 records in DOMPurify and Moment; still not a bundle inventory. |
| SupportTemplates workspace | 0 | 0 | 0 | 0 | Audit exited 0; reported total dependency count 96. This does not cover the separate Vencord toolchain by itself. |

Full-workspace affected families and selected paths:

| Family/version observed | Audit path / relevance | Action |
| --- | --- | --- |
| DOMPurify 3.2.7 (19 records) | `monaco-editor > dompurify` | Not emitted by minimal build. Keep Monaco/stock editor IPC absent. Baseline `src/main/monacoWin.html` actually loads Monaco 0.50.0 from a CDN, distinct from the lockfile's 0.55.1 package, so keeping that editor would require a separate remote-asset review. |
| Moment 2.22.2 / 2.30.1 (3 records) | Includes `packages/discord-types > moment`; the type workspace pins 2.22.2 | Not bundled. Do not equate production-workspace audit flags with copied Moment runtime. Discord's own runtime Moment is outside this package audit. |
| JSZip 2.7.0 | `zip-local > jszip`, used by upstream `scripts/build/buildWeb.mjs` | Not used by the standalone compile path; do not use that web packager for this release. Example advisory: [GHSA-36fh-84j7-cv5h](https://github.com/advisories/GHSA-36fh-84j7-cv5h). |
| SVGO 4.0.1 (3 records) | Upstream `scripts/build/common.mjs` imports optimizeSvg | Parent compile path imports esbuild directly and does not load common.mjs, SVGO or html-minifier-terser. Retain this narrow build path. Example advisory: [GHSA-2p49-hgcm-8545](https://github.com/advisories/GHSA-2p49-hgcm-8545). |
| brace-expansion, braces, minimatch, fast-uri, js-yaml, colord, decode-uri-component, postcss, postcss-selector-parser, source-map-js | Primarily ESLint/stylelint and their parsers/glob/config dependencies | Build/development inventory, absent from runtime. Track and remediate in a separately reviewed toolchain update; do not upgrade the installed/base workspace during this task. |
| nanoid 3.3.15 (2 records) | `stylelint > postcss > nanoid` | Different major version from upstream renderer import 5.1.16; neither is emitted by the successful minimal renderer. Avoid package-name-only vulnerability matching. |

The full audit found no advisory for the one emitted npm implementation. This is **not a zero-vulnerability certification**: vendored code, first-party framework behavior, installer trust, host Electron/Discord and runtime patch correctness need their own evidence.

## Targeted acceptance and release recommendations

1. Keep the four-name renderer and one-name native registries; enforce the source-input denylist and external-import allowlist during every release build. The parent's rejected first build demonstrates these checks catch a real transitive inclusion.
2. Keep the required global hooks and minimal IPC handlers documented above. Do not add ContextMenuAPI, badges or notices to make unrelated UI helpers work; explicitly support or remove those feature paths.
3. Preserve fail-closed DATA_DIR selection, renamed IndexedDB store/database, fixed panel CSP, no cloud startup, no native updater, and no host repatching import. Test fresh settings and manually copied legacy settings in an isolated host; the latter must not restore cloud/themes/updater behavior.
4. Record both parsed-input and emitted-byte dependency inventories. Archive the exact build's metafiles alongside its hashes. Record package versions from the actual node_modules used for the build, because the build currently borrows the base's node_modules junction rather than performing a fresh frozen install.
5. For public reproducibility, provide a clean-environment build recipe with the pinned upstream commit, overlays, lockfile/workspace configuration and build-tool versions. Retain upstream license/authorship and esbuild legal notices. Hashes detect corruption but do not authenticate a public release channel; add publisher verification when designing the later updater.
6. Runtime acceptance remains with the parent: load only the authorized isolated host; check the registry, chat button, Ctrl+Alt+T, one settings entry, channel guards, panel permission/network behavior, vault round-trip, and absence of missing-global/patch errors. This audit did not launch Discord and cannot certify those behaviors.

No outstanding composition blocker was found in the successful `wwoFXe` build. Remaining caveats are live patch/UI acceptance, host/framework trust boundaries, toolchain/source reproducibility, and the intentionally omitted stock chat-button context menu.
