# Example: `Memories — YYYY-MM`

A monthly Joplin note. Append-only. Episodic events — "what happened" — used to restore context on the next session's bootstrap.

Memories are scan-and-forget — you rarely read them directly. The plugin embeds them on `session.created` so they surface when relevant.

---

## 2026-05-28 17:45 — Shipped Phase 1 of opencode-personal-agent

**Project**: opencode-personal-agent  +opencode-personal-agent
**What happened**: Implemented and tested the memory bootstrap plugin. Session.created now reads Joplin + the memory backend and injects ~400 tokens of context as a system message. Verified by asking "what did we decide yesterday?" — agent answered correctly from injected context without searching.
**Significance**: Validates the core thesis — opencode sessions can start "warm" with no perceptible lag. Unblocks Phase 2 (reflection).
**Files touched**:
  - plugins/personal-agent.ts
  - skills/wrap/SKILL.md (stub only)
**Loose ends**:
  - Bootstrap context format could be tighter (currently 420 tokens, target was 400).
  - No test coverage yet — manual verification only.

**Tags**: #milestone #opencode-personal-agent #phase-1
**Recorded by**: agent (session abc12345)

---

## 2026-05-28 18:20 — Discovered opencode SDK's session.message.append() is undocumented but works

**Project**: opencode-personal-agent
**What happened**: The risk noted in spec § 12.1 about injecting a system message at session.created turned out to be a non-issue — the SDK exposes `client.session.message.append({ role: "system", parts: [...] })` and it works as expected. No need for the compaction-hook workaround.
**Significance**: Removes a known risk from the design spec. Phase 1 acceptance criteria met cleanly.
**Files touched**: none (research only)

**Tags**: #discovery #opencode-sdk
**Recorded by**: agent (session abc12345)

---
