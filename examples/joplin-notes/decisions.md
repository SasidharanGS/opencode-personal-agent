# Example: `Decisions — YYYY-MM`

A monthly Joplin note. Append-only. One `##` section per decision. The plugin creates the note lazily on first write of the month.

A "decision" is **a choice with a rejected alternative**. If there's no rejected alternative, it's a Memory, not a Decision.

---

## 2026-05-28 14:32 — Use SQLite polling, not Joplin webhooks

**Project**: example-project  +example-project
**Context**: Picking how the memory backend should detect new Joplin notes.
**Decision**: Poll Joplin SQLite every 60s in the same process as the daemon.
**Rationale**: Joplin Web Clipper has no webhook API. SQLite is stable, append-only for new notes, easy to diff via `updated_time`. No extra process needed.
**Rejected**:
  - Joplin Web Clipper webhooks — don't exist.
  - Filesystem watcher on Joplin's data dir — Joplin writes are non-atomic and noisy.
  - Polling Joplin's REST API every 60s — works but slower, hits the app's HTTP server.

**Tags**: #decision #example-project #notes-stack
**Recorded by**: agent (session abc12345)

---

## 2026-05-28 17:10 — MIT license over AGPL for the plugin

**Project**: opencode-personal-agent
**Context**: Picking a license before pushing the repo public.
**Decision**: MIT.
**Rationale**: Maximum adoption for an opencode plugin. Companies can use it without legal review. Plugin is small and any meaningful improvements would land upstream anyway.
**Rejected**:
  - AGPL — strong copyleft, deters corporate adoption for a small plugin.
  - Apache 2.0 — equivalent practical permissiveness; MIT is more familiar in the opencode ecosystem.

**Tags**: #decision #opencode-personal-agent #license
**Recorded by**: agent (session abc12345)

---
