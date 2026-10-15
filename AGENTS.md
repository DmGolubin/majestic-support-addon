# Project task tracking

The authoritative current task list is `docs/roadmap/data.json`.

- Read it before starting project work. Historical audits and the SDD ledger are evidence, not current task lists.
- Add new user-approved work with a stable unique ID, area, status, scope, date and evidence when available. Do not silently expand scope.
- Mark the relevant task `active` before implementation. Update meaningful progress and blockers during work; keep only work actually underway active.
- Use `review` when implemented but required acceptance remains. Use `done` only when the described scope is complete. Demo integration must not be represented as production API.
- Keep `planned`, `blocked` (API dependency), and `deferred` distinct. Record remaining work and validation limits explicitly.
- After each list change run `node scripts/roadmap.mjs`; it regenerates `docs/STATUS.md` and `TODO.md`. Do not maintain separate task lists there.
- `node scripts/roadmap.mjs set ID STATUS "Progress and remaining work"` updates an existing task and regenerates the views. For new tasks edit JSON, then generate.
- Before finishing run `node scripts/roadmap.mjs --check`. Commit roadmap changes with the corresponding work.
- The local site at port 47834 reads this JSON every 5 seconds; no deployment is needed for local updates. It does not itself execute tasks or run an unattended agent.
- Keep historical audit reports unchanged unless correcting a factual error explicitly. Their old pending items may already have been completed.
