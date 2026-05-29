---
name: agents-edit
description: "Use when the personal-agent surfaces a cross-session learning ready to be applied, or when /wrap output lists an AGENTS.md proposal. Reviews the LLM-generated patch and applies it to agent-learnings.md after user approval."
---

# /agents-edit

Review and apply a cross-session agent learning to `agent-learnings.md`.

## When to use

When the personal-agent nudges you that a cross-session learning is ready, or when you see an AGENTS.md proposal in `/wrap` output.

## What it does

1. Finds the learning in the Agent Learnings Joplin note
2. Reads the existing `agent-learnings.md` (or creates it fresh)
3. Calls the LLM to produce a patched version of the file
4. Shows you the patch and asks: apply, skip, or edit?
5. Writes the file on confirmation and marks the Joplin entry as applied

## How to use

When the agent surfaces a learning nudge, it will offer to run `/agents-edit` for you. You can also run it manually:

```
/agents-edit <name>
```

Where `<name>` is the observed learning shown in the nudge or in `/wrap` output.

## Agent instructions

When you see an `AGENTS_EDIT_CANDIDATE` block in the plugin output:

1. Show the user the patch content (between `---PATCH---` and end of output)
2. Ask: "Should I save this globally (`~/.config/opencode/agent-learnings.md`) or just for this project (`<cwd>/agent-learnings.md`)?"
3. Ask: "Looks good to apply, skip, or would you like to change anything?"

**On apply:**
Run: `/agents-edit <observed> --scope=<global|project> --confirm`

**On skip:**
Run: `/agents-edit <observed> --skip`

**On edit (user describes a change in natural language):**
Run: `/agents-edit <observed> --scope=<global|project> --edit="<user instruction>" --confirm`
The plugin will regenerate the patch incorporating the instruction before writing.

**Important:** Use the exact `observed` string from the `AGENTS_EDIT_CANDIDATE` block as `<observed>` — it may contain spaces and colons.

## Notes

- `agent-learnings.md` is the LLM's file — your handcrafted `AGENTS.md` is never touched
- Both files are injected into every session at startup
- Safe to run multiple times — applied/skipped entries are ignored
- After writing, the new rules take effect on the next session start
