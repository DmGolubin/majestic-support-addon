# Standalone Canary Implementation Plan

> **For agentic workers:** Execute the scoped tasks in this session; user explicitly authorized implementation and parallel agents. No changes to working Stable Discord.

**Goal:** Build an isolated, inspectable single-purpose Windows package and exercise install/repair/uninstall in Canary.

**Architecture:** Pin Vencord commit 32c90633ce6a95d7e56c95479efbb431bacf1eac and export it to a temporary build directory. Overlay a small renderer/native entry and an explicit plugin registry. Ship a fixed loader ASAR, versioned runtime, manifest and local PowerShell invoked by BAT wrappers; preserve the original Discord ASAR.

**Tech Stack:** TypeScript, esbuild, Node build scripts, Windows PowerShell 5.1, BAT, Vitest.

**Spec:** docs/RELEASE-V1.md; roadmap I03/I04/R09. Today's package is a Canary prototype, not the public release or GitHub updater.

## Global Constraints

- Do not modify installed Stable Discord or the existing Vencord checkout; no process killing.
- Canary is the first permitted real target. Other-mod detection must stop installation.
- No downloaded executable or remote script; no global ExecutionPolicy change or administrator requirement.
- Separate settings/database/token directories. Explicit renderer/native allowlists; no upstream cloud sync, updater or automatic host repatching.
- Preserve upstream license/authorship and provide exact source/build recipe with the diagnostic package.

## Review Focus

- Crash between preserving original and publishing loader: journal and safe recovery; preserve original bytes.
- Foreign loader, reparse points, manifest traversal or modified package: refuse before mutation.
- Concurrent/running Discord and channel mismatch: refuse target mutation without touching another channel.
- Native/renderer registry mismatch or missing framework patch: bundle assertions and actual Canary startup.
- Removed runtime/config: understandable recovery path and fallback to original Discord when failure occurs before initialization.

### 1. Minimal runtime and reproducible package (parent)

Files: standalone/build.mjs, standalone/config.json, standalone/runtime/*, standalone/asar.mjs; tests/standaloneBuild.test.ts.

- [x] Write regressions for loader format/metadata, isolation and build policy.
- [x] Export the pinned base without modifying its checkout; overlay the plugin source and minimal entrypoints.
- [x] Build renderer/preload/main with explicit registry and disabled updater; inspect esbuild inputs and reject forbidden modules.
- [x] Package runtime/loader with hashes, provenance, licenses and source archive. Checksums are integrity checks, not release signatures.

### 2. Installer (agent; disjoint files)

Files: standalone/installer/*; tests/standaloneInstaller*.

Interface: manifest.json schema=1/product=SupportTemplates/version/upstreamCommit/files[{path,sha256,size}]; payload/loader.asar and payload/runtime. resources/support-templates.json holds schema/product/channel/runtime/dataDir. Versioned runtime under LOCALAPPDATA/SupportTemplates/channels/channel/versions/version/runtime.

- [ ] Exercise actual PowerShell against temporary Discord fixtures: success/repeat, foreign loader, tamper, traversal, failure/recovery and exact uninstall restoration.
- [ ] Implement install/status/repair/uninstall/rollback. Preserve settings on uninstall; never delete unrelated files.

### 3. Independent composition/dependency review (agent)

File: docs/audits/2026-10-18-standalone-dependencies.md.

- [x] Identify necessary internal framework plugins and excluded functionality; compare audit findings to actual shipped module inputs.
- [x] Report remaining dependency/public-release risks without changing the installed checkout.

### 4. Integration and Canary (parent + targeted review)

- [ ] Run tests/types/build/package checks and review installer before real mutation.
- [ ] Record Stable path/process/hashes; run Canary status and install only after fixture checks pass.
- [ ] Start Canary; inspect actual startup/registry/UI when tools permit. Do not claim live UI based on bundle tests.
- [ ] Verify uninstall restoration and repair/reinstall; record exact coverage and remaining API blockers.
- [ ] Update roadmap/STATUS/TODO and commit only this work. No public upload.
