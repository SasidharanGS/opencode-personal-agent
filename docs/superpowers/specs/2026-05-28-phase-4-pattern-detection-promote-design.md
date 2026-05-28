# Phase 4 Design — Pattern Detection + `/promote`

**Date**: 2026-05-28  
**Status**: Approved  
**Scope**: `src/patterns.ts`, `src/promote.ts`, `src/plugin.ts` (extend), `src/types.ts` (extend), `skills/promote/SKILL.md`, tests

---

## 1. Goal

When a user repeats the same tool call 3+ times in a session, the plugin automatically surfaces it as a skill candidate — injecting a nudge into the next conversation turn so the agent proactively offers to promote it. The user can then run `/promote <name>` (guided by the agent) to generate and write a SKILL.md with zero friction.

---

## 2. Architecture

Three additions on top of the existing plugin:

1. **`src/patterns.ts`** — pure `detectPatterns()` function + `writeNewPatterns()` I/O helper + `skillsProposedEntry()` renderer.
2. **Idle pass extension** — after `reflect()` in the idle timer, call `writeNewPatterns()` to durably record new candidates in the "Skills Proposed" Joplin note.
3. **`src/promote.ts`** — `runPromote()` command handler: reads candidates, calls LLM, writes SKILL.md, marks promoted.
4. **`plugin.ts` extensions** — threshold toast + `pendingPromotions` nudge in `experimental.chat.system.transform` + `/promote` command handler.

---

## 3. Data Flow

```
tool.execute.before
  → state.patternCandidates.set(sig, count + 1)       [already implemented]
  → if count + 1 >= PATTERN_THRESHOLD (3):
      state.pendingPromotions.add(sig)                  [new]
      client.app.log("pattern flagged: <sig>")          [new — log line]

experimental.chat.system.transform (every turn)
  → if state.pendingPromotions.size > 0:
      append nudge to system prompt                     [new]
      "Pattern detected: <sig> repeated 3+ times. Consider /promote."

idle timer fires
  → reflect(state, client, joplin)                     [existing]
  → detectPatterns(state.patternCandidates, alreadyProposed)  [new]
  → writeNewPatterns(candidates, joplin)               [new — appends to "Skills Proposed"]

/promote <name>
  → read "Skills Proposed" note
  → find entry matching <name> (exact then fuzzy)
  → call LLM → SKILL.md draft
  → return draft + metadata as text block
  → SKILL.md instructs agent to ask scope + confirm

/promote <name> --scope=<global|project> --confirm
  → resolve file path
  → mkdir -p + write SKILL.md
  → mark entry "Status: promoted" in Joplin note
  → remove sig from state.pendingPromotions
  → return confirmation
```

---

## 4. SessionState Changes

Add to `SessionState` in `types.ts`:

```ts
pendingPromotions: Set<string>   // sigs that hit threshold but not yet promoted
```

Populated in `tool.execute.before`, cleared after `/promote --confirm` succeeds.

---

## 5. New Interfaces

### `PatternCandidate` (added to `types.ts`)

```ts
export interface PatternCandidate {
  sig: string    // normalized signature e.g. "bash:git status"
  tool: string   // raw tool name e.g. "bash"
  hits: number   // count this session
}
```

### `detectPatterns(candidates, alreadyProposed, threshold?)` — pure, no I/O

```ts
function detectPatterns(
  candidates: Map<string, number>,
  alreadyProposed: Set<string>,
  threshold?: number,   // default 3
): PatternCandidate[]
```

Returns only sigs ≥ threshold not already in `alreadyProposed`.

### "Skills Proposed" note entry format (rendered by `skillsProposedEntry()`)

```markdown
## <sig> — proposed

**Tool**: <tool>
**Hits this session**: <n>
**Status**: pending
**Proposed**: <ISO timestamp>

---
```

`markPromoted()` replaces `Status: pending` → `Status: promoted` in the note body.

---

## 6. Files & Modules

| File | Status | What changes |
|---|---|---|
| `src/patterns.ts` | **New** | `detectPatterns()`, `writeNewPatterns()`, `skillsProposedEntry()`, `markPromoted()` |
| `src/promote.ts` | **New** | `runPromote()` — reads note, fuzzy-matches candidate, calls LLM, writes file, marks promoted |
| `src/plugin.ts` | **Extend** | Threshold check + `pendingPromotions` in `tool.execute.before`; nudge in `system.transform`; `writeNewPatterns` after `reflect()` on idle; `/promote` command handler |
| `src/types.ts` | **Extend** | `PatternCandidate` interface; `pendingPromotions: Set<string>` on `SessionState` |
| `skills/promote/SKILL.md` | **New** | User-facing skill docs for `/promote` |
| `tests/patterns.test.ts` | **New** | Unit tests for `detectPatterns`, `skillsProposedEntry`, `markPromoted` |
| `tests/promote.test.ts` | **New** | Unit tests for entry parsing, fuzzy match, file path resolution |

`src/wrap.ts`, `src/reflect.ts` — **no changes**.

---

## 7. `/promote` Interaction Model

The command handler is **two-step**, delegating conversation to the agent via SKILL.md:

**Step 1 — `/promote <name>`**
- Plugin reads "Skills Proposed", finds candidate, calls LLM for SKILL.md draft
- Returns structured text block: draft content + suggested path + candidate metadata
- SKILL.md instructs the agent to: present the draft, ask global-vs-project, confirm with user

**Step 2 — `/promote <name> --scope=<global|project> --confirm`**
- Plugin resolves path, writes file, marks entry promoted, clears `pendingPromotions`
- Returns: `"Written to <path>. Restart opencode to load the new skill."`

**File paths**:
- Global: `~/.config/opencode/skills/<name>/SKILL.md`
- Project: `<cwd>/.opencode/skills/<name>/SKILL.md`

---

## 8. Error Handling

| Failure | Behaviour |
|---|---|
| Joplin down when writing "Skills Proposed" | Log warn, skip write. Candidate stays in `pendingPromotions` — nudge still fires next turn. |
| LLM down during `/promote` | Return: "LLM unavailable — can't generate draft. Try again when endpoint is up." |
| "Skills Proposed" note missing | Auto-create via `JoplinClient.appendToNote` (same pattern as Decisions/Memories) |
| `/promote <name>` — no matching candidate | Return: "No pending skill candidate matching '\<name\>'. Run /wrap to see candidates." |
| File write fails | Return error with path. SKILL.md draft still shown so user can save manually. |
| Already promoted | Return: "\<name\> was already promoted. Check \<path\>." |

No retries on Joplin writes. `SessionState` is source of truth mid-session; Joplin is the durable record.

---

## 9. Testing

**`tests/patterns.test.ts`**
- `detectPatterns` with empty map → `[]`
- `detectPatterns` with sigs below threshold → `[]`
- `detectPatterns` with sigs at exactly 3 → returns candidates
- `detectPatterns` filters sigs already in `alreadyProposed`
- `skillsProposedEntry` renders correct markdown
- `markPromoted` replaces `Status: pending` → `Status: promoted`

**`tests/promote.test.ts`**
- Entry parser finds correct candidate by exact sig match
- Entry parser fuzzy-matches on tool name (e.g. "git" matches `bash:git status`)
- File path resolver: global → `~/.config/opencode/skills/<name>/SKILL.md`
- File path resolver: project → `<cwd>/.opencode/skills/<name>/SKILL.md`

---

## 10. Acceptance Criteria (from design.md § 9)

- Running the same bash command 3 times in one session results in a system prompt nudge on the next turn and a "Skills Proposed" Joplin entry within 3 min (next idle).
- `/promote <name>` asks global-vs-project (via agent), generates a draft SKILL.md, writes it on approval.
- New skill appears under chosen base after restart.
- Pattern normalizer handles `bash`, `write`, `edit`, `read` distinctly; falls back to generic for others (already implemented in `src/normalizer.ts`).
