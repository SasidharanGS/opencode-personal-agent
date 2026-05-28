# /promote

Turn a repeated tool pattern into a reusable opencode skill.

## When to use

When the personal-agent nudges you that a pattern has been repeated 3+ times, or when you see a skill candidate in `/wrap` output.

## What it does

1. Finds the pattern candidate in the "Skills Proposed" Joplin note
2. Calls the LLM to generate a SKILL.md draft based on the pattern
3. Asks you: global skill (`~/.config/opencode/skills/`) or project-local (`.opencode/skills/`)?
4. Shows you the draft and asks for confirmation
5. Writes the file and marks the candidate as promoted in Joplin

## How to use

When the agent surfaces a pattern nudge, it will offer to run `/promote` for you. You can also run it manually:

```
/promote <name>
```

Where `<name>` is the pattern name shown in the nudge or in `/wrap` output (e.g. `bash:git status`).

The agent will:
1. Show you the generated SKILL.md draft
2. Ask whether to save globally or project-locally
3. Run `/promote <name> --scope=<global|project> --confirm` on your approval

## Agent instructions

When you see a `PROMOTE_CANDIDATE` block in the plugin output:

1. Show the user the draft content (between `---DRAFT---` and end of output)
2. Ask: "Should I save this globally (available in all projects) or just for this project?"
3. On their answer, run:
   `/promote <sig> --scope=global --confirm`
   or
   `/promote <sig> --scope=project --confirm`
4. Report the result to the user

If the user says no or wants to edit the draft first, do not run the confirm command. Let them know they can run `/promote <name>` again after editing their preference.

## Notes

- Safe to run multiple times — already-promoted candidates are ignored
- If the LLM is unavailable, the command returns an error and the candidate stays pending
- After writing, restart opencode to load the new skill
