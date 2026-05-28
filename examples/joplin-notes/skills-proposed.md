# Example: `Skills Proposed`

A single rolling Joplin note (no monthly suffix). One ever. Append-only. Read by `/wrap` and `/promote`.

The plugin appends a section whenever pattern detection flags a tool-usage pattern. Run `/promote <name>` to convert a pending pattern into a real skill file.

---

# Skills Proposed

Auto-detected tool-usage patterns that may deserve a dedicated skill.
Run `/promote <name>` to convert one. Run `/wrap` to see the freshest list.

---

## pr-create — proposed 2026-05-28

**Pattern**: `bash:gh pr create --assignee <str> --title <str> --body <str>`
**Hits this session**: 4
**Cross-session count**: 1
**Example invocations**:
  - `gh pr create --assignee my-handle --title "fix: x" --body "..."`
  - `gh pr create --assignee my-handle --title "feat: y" --body "..."`
  - `gh pr create --assignee my-handle --title "docs: z" --body "..."`
  - `gh pr create --assignee my-handle --title "chore: w" --body "..."`
**Status**: pending

---

## morning-standup — proposed 2026-05-20

**Pattern**: `joplin_create_note title="Standup — <date>"`
**Hits this session**: 1
**Cross-session count**: 5 (5 days in a row)
**Status**: pending

---

## release-checklist — proposed 2026-05-15

**Pattern**: sequence of `bash:npm version`, `bash:git push --tags`, `bash:gh release create`
**Hits this session**: 1 (full sequence)
**Cross-session count**: 3
**Status**: promoted 2026-05-22 → ~/.config/opencode/skills/release-checklist/SKILL.md

---
