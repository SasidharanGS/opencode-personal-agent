# Example: `Agent Learnings — YYYY-MM`

A monthly Joplin note. Append-only. Meta-observations about how the agent should adapt to you. This is the input signal for `AGENTS.md` proposals (Phase 5) and skill suggestions (Phase 4).

Three entry types:

- **`behavior_correction`** — the agent did something the user fixed
- **`preference_expressed`** — the user said "I prefer X"
- **`skill_candidate`** — a repeated tool pattern that may deserve a skill

---

## 2026-05-28 18:02 — Forgot to create a worktree before editing

**Type**: behavior_correction
**Observed**: User reminded me twice this session to create a git worktree before editing files.
**Already in AGENTS.md**: yes (§ "Use git worktrees for all code changes")
**Evidence**: Session abc12345 messages [42, 67]
**Cross-session count**: 4
**Proposed action**: none (rule already exists; agent needs to follow it)
**Status**: noted
**Recorded by**: agent (session abc12345)

---

## 2026-05-28 18:10 — Prefer pnpm over npm in new projects

**Type**: preference_expressed
**Observed**: User said "use pnpm" when initializing a TS project.
**Already in AGENTS.md**: no
**Evidence**: Session abc12345 messages [88]
**Cross-session count**: 1 (first time)
**Proposed action**: AGENTS.md edit when cross-session count reaches 2
**Status**: pending_more_evidence
**Recorded by**: agent (session abc12345)

---

## 2026-05-28 18:15 — Skill candidate: pr-create

**Type**: skill_candidate
**Observed**: User ran `gh pr create --assignee <handle> ...` 4 times this session.
**Pattern signature**: `bash:gh pr create --assignee <str> --title <str> --body <str>`
**Cross-session count**: 1
**Proposed action**: promote to skill `pr-create`
**Status**: pending_user_approval (see Skills Proposed)
**Recorded by**: agent (session abc12345)

---

## 2026-05-29 09:14 — Prefer pnpm over npm in new projects [SECOND OCCURRENCE]

**Type**: preference_expressed
**Observed**: User said "always use pnpm" in a different project context.
**Already in AGENTS.md**: no
**Evidence**: Session def67890 messages [12]
**Cross-session count**: 2  ← THRESHOLD REACHED
**Proposed action**: AGENTS.md edit — add "Use pnpm in new TS projects" under preferences
**Status**: pending_user_approval (run /agents-edit)
**Recorded by**: agent (session def67890)

---
