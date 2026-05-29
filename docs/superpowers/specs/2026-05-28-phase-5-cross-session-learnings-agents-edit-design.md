# Phase 5 Design — Cross-Session Learnings + `/agents-edit`

**Date**: 2026-05-28
**Status**: Approved
**Scope**: `src/agents-edit.ts`, `src/types.ts` (extend), `src/bootstrap.ts` (extend), `src/plugin.ts` (extend), `skills/agents-edit/SKILL.md`, `~/.config/opencode/AGENTS.md` (update), tests

---

## 1. Goal

When the reflection module detects the same agent correction or preference across 2+ sessions, the plugin proactively surfaces it as a proposed change — injecting a nudge into the next conversation turn. The user runs `/agents-edit <name>` (guided by the agent) to review a structured patch, then applies, skips, or edits it via natural language.

Critically: the patch is written to a **separate LLM-managed file** (`~/.config/opencode/agent-learnings.md`), never to the user's handcrafted `AGENTS.md`. The user's `AGENTS.md` gets a single reference line pointing to the new file. Both are loaded at session start.

---

## 2. Architecture

Four additions on top of the existing plugin:

1. **`src/agents-edit.ts`** — `findAgentLearnings()`, `buildAgentsMdPrompt()`, `patchAgentLearningsFile()`, `markLearningStatus()`, `runAgentsEdit()`. Mirrors the shape of `src/promote.ts`.
2. **`pendingAgentsEdits: Set<string>`** on `SessionState` — populated after `reflect()` writes learnings with `crossCount >= 2`. Cleared on apply/skip.
3. **`src/bootstrap.ts` extension** — reads `agent-learnings.md` at session start, injects alongside Joplin context.
4. **`plugin.ts` extensions** — populate `pendingAgentsEdits` in idle `.then()` chain; nudge in `system.transform`; `/agents-edit` command handler.

---

## 3. Data Flow

```
session.created
  → read ~/.config/opencode/agent-learnings.md     [new]
  → inject into system prompt alongside Joplin context

reflect() completes (idle timer .then() chain)
  → read Agent Learnings note from Joplin (current month)
  → for each entry with status proposed_agents_edit
    not already in state.pendingAgentsEdits:
      state.pendingAgentsEdits.add(observed)         [new]
      client.app.log("agents-edit flagged: <observed>")

experimental.chat.system.transform (every turn)
  → if pendingAgentsEdits.size > 0:
      append nudge to system prompt                  [new]
      "[personal-agent] Agent learning ready: <observed>. Offer to run /agents-edit."

/agents-edit <name>
  → search Joplin Agent Learnings notes
  → find entry matching <name> with status proposed_agents_edit
  → ask: global (~/.config/opencode/) or project (<cwd>/) scope?
  → read existing agent-learnings.md (or prepare skeleton)
  → LLM patches the file — adds/updates the relevant section
  → return AGENTS_EDIT_CANDIDATE block (patch + paths)
  → SKILL.md instructs agent to show patch, offer apply/skip/edit

/agents-edit <name> --scope=<global|project> --confirm
  → write patched agent-learnings.md to disk
  → mark Joplin entry "applied" via updateNote
  → remove observed from state.pendingAgentsEdits
  → return "Written to <path>."

/agents-edit <name> --skip
  → mark Joplin entry "skipped" via updateNote
  → remove observed from state.pendingAgentsEdits
  → return "Skipped. Won't propose again."

/agents-edit <name> --scope=<global|project> --edit="<instruction>" --confirm
  → same as --confirm but passes editInstruction to LLM
  → LLM regenerates patch incorporating the instruction
  → write + mark applied
```

---

## 4. SessionState Changes

Add to `SessionState` in `types.ts`:

```ts
pendingAgentsEdits: Set<string>   // observed strings that crossed threshold, not yet applied/skipped
```

Populated in the idle timer's `.then()` chain after `reflect()`, alongside `writeNewPatterns`. Cleared after `/agents-edit --confirm` or `--skip`.

---

## 5. New Interfaces

### `AgentLearningEntry` (added to `types.ts`)

```ts
export interface AgentLearningEntry {
  observed: string
  type: string              // "behavior_correction" | "preference_expressed"
  crossSessionCount: number
  projectTag: string | null
  status: string            // "proposed_agents_edit" | "pending_more_evidence" | "applied" | "skipped"
}
```

### `findAgentLearnings(noteBody): AgentLearningEntry[]` — pure, no I/O

Parses all sections from an Agent Learnings note body. Returns only entries with `status === "proposed_agents_edit"`.

### `buildAgentsMdPrompt(entry, existingContent, editInstruction?)` — pure

```ts
function buildAgentsMdPrompt(
  entry: AgentLearningEntry,
  existingContent: string,
  editInstruction?: string,
): string
```

Returns an LLM prompt that produces a patched version of `agent-learnings.md` — adding or updating the relevant section while preserving existing content.

### `markLearningStatus(body, observed, status)` — pure

```ts
function markLearningStatus(
  body: string,
  observed: string,
  status: "applied" | "skipped",
): string
```

Replaces `**Status**: proposed_agents_edit` → `**Status**: <status>` in the matching section only. Mirrors `markPromoted` from `patterns.ts`.

### `patchAgentLearningsFile(existingContent, llmPatch)` — pure

```ts
function patchAgentLearningsFile(
  existingContent: string,
  llmPatch: string,
): string
```

Returns the final file content. If `existingContent` is empty, wraps `llmPatch` in the skeleton structure. Otherwise returns `llmPatch` directly (the LLM is instructed to return the full patched file).

---

## 6. `agent-learnings.md` File Structure

The LLM owns this file entirely. Structured for maximum LLM legibility — TOC, typed sections, stable anchors:

```markdown
# Agent Learnings

> Auto-maintained by opencode personal-agent. Do not edit manually.
> Last updated: YYYY-MM-DD

## Table of Contents

- [Behavioral Rules](#behavioral-rules)
- [Preferences](#preferences)
- [Project-Specific](#project-specific)

---

## Behavioral Rules

Rules the agent must follow, learned from corrections across sessions.

### Always use kebab-case for file names
- **Learned**: 2026-05-28
- **Evidence**: Corrected 2 times across sessions
- **Rule**: When creating files, always use lowercase kebab-case (e.g. `my-file.ts` not `myFile.ts`)

---

## Preferences

User preferences that shape how the agent works.

### Prefer bun over npm
- **Learned**: 2026-05-28
- **Evidence**: Expressed preference in session
- **Preference**: Use `bun` instead of `npm` for all package management commands

---

## Project-Specific

Rules that apply only within specific projects.

### opencode-personal-agent: commit message format
- **Project**: opencode-personal-agent
- **Learned**: 2026-05-28
- **Rule**: Use conventional commits (feat/fix/chore/docs)
```

Section placement by `type`:
- `behavior_correction` → **Behavioral Rules**
- `preference_expressed` → **Preferences**
- Either with a non-null `projectTag` → **Project-Specific**

---

## 7. `bootstrap.ts` Extension

`BootstrapData` gains:
```ts
agentLearnings: string | null   // full content of agent-learnings.md, or null if missing
```

`gatherBootstrapData()` reads the file from disk (path: `HOME/.config/opencode/agent-learnings.md`). Failure is silent — returns `null`.

`composeBootstrapMessage()` appends a fenced block when `agentLearnings` is non-null:

```
--- Agent Learnings ---
<content>
--- End Agent Learnings ---
```

---

## 8. Files & Modules

| File | Status | What changes |
|---|---|---|
| `src/agents-edit.ts` | **New** | `findAgentLearnings`, `buildAgentsMdPrompt`, `patchAgentLearningsFile`, `markLearningStatus`, `runAgentsEdit` |
| `src/types.ts` | **Extend** | `AgentLearningEntry` interface; `pendingAgentsEdits: Set<string>` on `SessionState` |
| `src/bootstrap.ts` | **Extend** | Read `agent-learnings.md`; add `agentLearnings` to `BootstrapData`; inject in `composeBootstrapMessage` |
| `src/plugin.ts` | **Extend** | Populate `pendingAgentsEdits` in idle `.then()` by re-reading Agent Learnings note; nudge in `system.transform`; `/agents-edit` command handler; init `pendingAgentsEdits: new Set()` in session creation |
| `skills/agents-edit/SKILL.md` | **New** | Agent-facing instructions for apply/skip/edit flow |
| `tests/agents-edit.test.ts` | **New** | Unit tests for all pure functions |
| `~/.config/opencode/AGENTS.md` | **Update** | Add reference note pointing to `agent-learnings.md` |

`src/reflect.ts`, `src/patterns.ts`, `src/promote.ts`, `src/wrap.ts` — **no changes**.

---

## 9. Error Handling

| Failure | Behaviour |
|---|---|
| `agent-learnings.md` missing at bootstrap | Skip injection silently — session starts normally |
| `agent-learnings.md` missing at `--confirm` | Create it with skeleton structure + new section |
| Joplin down when reading Agent Learnings | Return: "Can't read Agent Learnings from Joplin. Is Joplin running?" |
| LLM down during `/agents-edit` | Return: "LLM unavailable — can't generate patch. Try again when endpoint is up." |
| Entry not found matching `<name>` | Return: "No proposed agent learning matching '\<name\>'. Run /wrap to see candidates." |
| File write fails | Return error with path + show patch content so user can apply manually |
| Already applied/skipped | Return: "\<name\> was already \<applied|skipped\>." |

No retries on Joplin writes. `SessionState` is source of truth mid-session.

---

## 10. Testing

**`tests/agents-edit.test.ts`**
- `findAgentLearnings` with empty body → `[]`
- `findAgentLearnings` returns only `proposed_agents_edit` entries
- `findAgentLearnings` ignores `applied` and `skipped` entries
- `findAgentLearnings` parses `observed`, `type`, `crossSessionCount`, `projectTag` correctly
- `markLearningStatus` replaces `proposed_agents_edit` → `applied` in correct section only
- `markLearningStatus` replaces `proposed_agents_edit` → `skipped` in correct section only
- `markLearningStatus` returns body unchanged if observed not found
- `buildAgentsMdPrompt` includes observed, type, cross-session count
- `buildAgentsMdPrompt` includes `editInstruction` when provided
- `patchAgentLearningsFile` wraps in skeleton when existing content is empty
- `patchAgentLearningsFile` returns llmPatch directly when existing content present

---

## 11. Acceptance Criteria (from design.md § 9)

- After 2 sessions with the same correction, an Agent Learning entry shows `Cross-session count: 2` and `Proposed action: AGENTS.md edit` — system prompt nudge fires on next turn.
- `/agents-edit` shows a patch generated by the LLM, supports apply / skip / edit.
- Apply writes to `agent-learnings.md` (global or project-scoped per user choice).
- Skip marks the entry so it won't propose again.
- `~/.config/opencode/AGENTS.md` is never modified by the plugin — `agent-learnings.md` is the LLM's file.
- `agent-learnings.md` is injected into every session's system prompt at bootstrap.
