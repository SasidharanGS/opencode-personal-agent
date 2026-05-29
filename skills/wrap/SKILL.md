---
name: wrap
description: "Use at the end of a work session, after a milestone, or when you want to see what the personal-agent has saved to Joplin. Runs an immediate reflection and shows what was written plus any pending skill or AGENTS.md proposals."
---

# /wrap

Wrap up the current opencode session: run an immediate reflection, then show a summary of what was saved and what's pending.

## When to use

- At the end of a work session before closing opencode
- After a significant decision or milestone
- When you want to check what the agent has saved so far this session
- When you want to see pending skill promotions or AGENTS.md proposals

## What it does

1. Runs an immediate (synchronous) reflection on this session's transcript
2. Writes any new decisions, memories, and agent learnings to Joplin
3. Shows a structured summary:
   - What was saved to `Decisions — YYYY-MM` (with titles)
   - What was saved to `Memories — YYYY-MM` (with titles)
   - Any skill candidates awaiting `/promote`
   - Any AGENTS.md proposals awaiting `/agents-edit`

## How to use

Type:

```
/wrap
```

The plugin runs the reflection and presents the summary. You can then:
- Run `/promote <name>` to convert a flagged tool pattern into a skill
- Run `/agents-edit` to review and apply any AGENTS.md proposals
- Close opencode knowing everything has been saved

## Notes

- Safe to run multiple times — reflection deduplication prevents double-writing
- If the LLM endpoint is down, `/wrap` still shows pending items from prior saves
- Joplin must be running for writes to succeed
