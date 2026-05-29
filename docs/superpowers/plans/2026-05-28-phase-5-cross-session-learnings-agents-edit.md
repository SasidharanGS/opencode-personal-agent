# Phase 5 — Cross-Session Learnings + `/agents-edit` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the reflection module detects the same agent correction across 2+ sessions, the plugin proactively surfaces it, lets the user review a structured patch via `/agents-edit`, and writes it to a separate LLM-managed `agent-learnings.md` file — leaving the user's handcrafted `AGENTS.md` untouched.

**Architecture:** New `src/agents-edit.ts` mirrors `src/promote.ts`. `src/bootstrap.ts` and `src/types.ts` gain small extensions. `plugin.ts` gets a `pendingAgentsEdits` nudge (same pattern as `pendingPromotions`) and a `/agents-edit` command handler. The idle timer's `.then()` chain is extended to scan Agent Learnings after reflect. `agent-learnings.md` is a structured markdown file the LLM owns entirely.

**Tech Stack:** TypeScript, Bun (test runner: `bun test`), Joplin MCP via `JoplinClient`, OpenAI-compatible LLM endpoint, Node.js `fs/promises` for file I/O.

**Spec:** `docs/superpowers/specs/2026-05-28-phase-5-cross-session-learnings-agents-edit-design.md`

---

## File Map

| File | Action |
|---|---|
| `src/types.ts` | Extend — `AgentLearningEntry` interface; `pendingAgentsEdits: Set<string>` on `SessionState`; `agentLearnings: string \| null` on `BootstrapData` |
| `src/bootstrap.ts` | Extend — read `agent-learnings.md` from disk; inject in `composeBootstrapMessage` |
| `src/agents-edit.ts` | Create — `findAgentLearnings`, `buildAgentsMdPrompt`, `patchAgentLearningsFile`, `markLearningStatus`, `resolveAgentLearningsPath`, `generateAgentsMdPatch`, `runAgentsEdit` |
| `src/plugin.ts` | Extend — `pendingAgentsEdits: new Set()` in session creation; scan Agent Learnings in idle `.then()`; nudge in `system.transform`; `/agents-edit` command handler |
| `skills/agents-edit/SKILL.md` | Create — agent instructions for apply/skip/edit flow |
| `tests/agents-edit.test.ts` | Create — unit tests for all pure functions |
| `~/.config/opencode/AGENTS.md` | Update — add reference note pointing to `agent-learnings.md` |

---

## Task 1: Extend types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add `AgentLearningEntry` interface, `pendingAgentsEdits` to `SessionState`, and `agentLearnings` to `BootstrapData`**

Open `src/types.ts`. Make three changes:

**1. Add `AgentLearningEntry` after `PatternCandidate`:**

```ts
export interface AgentLearningEntry {
  observed: string
  type: string
  crossSessionCount: number
  projectTag: string | null
  status: string
}
```

**2. Add `pendingAgentsEdits` to `SessionState`:**

```ts
export interface SessionState {
  sessionId: string
  startedAt: Date
  lastActivityTs: Date
  lastReflectionTs: Date | null
  toolCalls: ToolCall[]
  patternCandidates: Map<string, number>
  pendingPromotions: Set<string>
  pendingAgentsEdits: Set<string>          // ← add this line
  bootstrappedContext: string | null
  idleTimer: ReturnType<typeof setTimeout> | null
}
```

**3. Add `agentLearnings` to `BootstrapData`:**

```ts
export interface BootstrapData {
  projectName: string
  recentDecisions: string[]
  recentMemories: string[]
  projectNotes: string[]
  activitySummary: string | null
  agentLearnings: string | null            // ← add this line
}
```

- [ ] **Step 2: Initialize `pendingAgentsEdits` in `plugin.ts` session creation**

In `src/plugin.ts`, find the `SessionState` object literal in the `session.created` handler. Add `pendingAgentsEdits: new Set()` alongside `pendingPromotions`:

```ts
const state: SessionState = {
  sessionId,
  startedAt: new Date(),
  lastActivityTs: new Date(),
  lastReflectionTs: null,
  toolCalls: [],
  patternCandidates: new Map(),
  pendingPromotions: new Set(),
  pendingAgentsEdits: new Set(),
  bootstrappedContext: null,
  idleTimer: null,
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
bun run tsc --noEmit
```

Expected: errors only about `agentLearnings` not yet used in `bootstrap.ts` — those are acceptable at this stage. If there are errors about `pendingAgentsEdits`, fix them.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/plugin.ts
git commit -m "feat: add AgentLearningEntry, pendingAgentsEdits, agentLearnings to types"
```

---

## Task 2: Extend `bootstrap.ts` — read and inject `agent-learnings.md`

**Files:**
- Modify: `src/bootstrap.ts`
- Modify: `tests/bootstrap.test.ts`

- [ ] **Step 1: Add failing tests for the new bootstrap behaviour**

Open `tests/bootstrap.test.ts` and add these tests at the end of the file:

```ts
describe("composeBootstrapMessage — agent learnings", () => {
  test("includes agent learnings section when present", () => {
    const data: BootstrapData = {
      projectName: "myproject",
      recentDecisions: [],
      recentMemories: [],
      projectNotes: [],
      activitySummary: null,
      agentLearnings: "## Behavioral Rules\n\n### Use kebab-case\n- **Rule**: always kebab-case",
    }
    const msg = composeBootstrapMessage(data)
    expect(msg).toContain("Agent Learnings")
    expect(msg).toContain("Use kebab-case")
  })

  test("omits agent learnings section when null", () => {
    const data: BootstrapData = {
      projectName: "myproject",
      recentDecisions: [],
      recentMemories: [],
      projectNotes: [],
      activitySummary: null,
      agentLearnings: null,
    }
    const msg = composeBootstrapMessage(data)
    expect(msg).not.toContain("Agent Learnings")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/bootstrap.test.ts
```

Expected: FAIL — type errors on `agentLearnings` field.

- [ ] **Step 3: Extend `bootstrap.ts`**

**3a. Add `readAgentLearnings(home)` function** — reads `agent-learnings.md` from disk, returns content or null:

```ts
import * as fs from "node:fs/promises"
import * as nodePath from "node:path"
```

Add at the top of `src/bootstrap.ts` alongside existing imports. Then add the function:

```ts
export async function readAgentLearnings(home: string): Promise<string | null> {
  try {
    const path = nodePath.join(home, ".config", "opencode", "agent-learnings.md")
    return await fs.readFile(path, "utf-8")
  } catch {
    return null
  }
}
```

**3b. Extend `composeBootstrapMessage`** — add agent learnings section after project notes:

```ts
export function composeBootstrapMessage(data: BootstrapData): string {
  const lines: string[] = ["## Memory bootstrap", ""]
  lines.push(`**Active project (from cwd)**: ${data.projectName}`)
  if (data.activitySummary) {
    lines.push(`**Today's activity**: ${data.activitySummary}`)
  }
  lines.push("")
  if (data.recentDecisions.length > 0) {
    lines.push("### Recent decisions (last 7 days)")
    for (const d of data.recentDecisions) lines.push(`- ${d}`)
    lines.push("")
  }
  if (data.recentMemories.length > 0) {
    lines.push("### Recent memories (last 7 days)")
    for (const m of data.recentMemories) lines.push(`- ${m}`)
    lines.push("")
  }
  if (data.projectNotes.length > 0) {
    lines.push("### Project-tagged notes (last 7 days)")
    for (const n of data.projectNotes) lines.push(`- ${n}`)
    lines.push("")
  }
  if (data.agentLearnings) {
    lines.push("### Agent Learnings")
    lines.push(data.agentLearnings)
    lines.push("")
  }
  lines.push("_End memory bootstrap. Continue normally._")
  return lines.join("\n")
}
```

**3c. Update `gatherBootstrapData` in `plugin.ts`** — pass `agentLearnings` into `BootstrapData`. Find `gatherBootstrapData` at the bottom of `src/plugin.ts` and update it:

```ts
async function gatherBootstrapData(
  joplin: JoplinClient,
  memory: MemoryClient,
  cwd: string,
): Promise<BootstrapData> {
  const now = new Date()
  const projectName = detectProject(cwd, PROJECT_MAP)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
  const [decisionsNote, memoriesNote, projectNotes, activities, agentLearnings] = await Promise.all([
    joplin.getNote(decisionsNoteName(now)),
    joplin.getNote(memoriesNoteName(now)),
    joplin.searchNotes(`+${projectName}`, 5),
    memory.getTodayActivities(),
    readAgentLearnings(home),
  ])
  return {
    projectName,
    recentDecisions: decisionsNote ? JoplinClient.parseDecisionLines(decisionsNote.body, 7, now) : [],
    recentMemories: memoriesNote ? JoplinClient.parseDecisionLines(memoriesNote.body, 7, now) : [],
    projectNotes: projectNotes.slice(0, 5).map(n => `${n.title} \u2014 ${n.body.slice(0, 80).replace(/\n/g, " ")}`),
    activitySummary: activities ? MemoryClient.summarizeActivities(activities) : null,
    agentLearnings,
  }
}
```

Also add the import for `readAgentLearnings` at the top of `plugin.ts`:

```ts
import { detectProject, decisionsNoteName, memoriesNoteName, composeBootstrapMessage, readAgentLearnings } from "./bootstrap.js"
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/bootstrap.test.ts
```

Expected: all bootstrap tests PASS.

- [ ] **Step 5: Run full test suite**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/bootstrap.ts src/plugin.ts tests/bootstrap.test.ts
git commit -m "feat: bootstrap reads and injects agent-learnings.md into session context"
```

---

## Task 3: Create `src/agents-edit.ts` + tests

**Files:**
- Create: `src/agents-edit.ts`
- Create: `tests/agents-edit.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/agents-edit.test.ts`:

```ts
import { expect, test, describe } from "bun:test"
import {
  findAgentLearnings,
  markLearningStatus,
  buildAgentsMdPrompt,
  patchAgentLearningsFile,
  resolveAgentLearningsPath,
} from "../src/agents-edit"
import type { AgentLearningEntry } from "../src/types"

const SAMPLE_LEARNINGS_BODY = [
  "## 2026-05-28 12:00 — Always use kebab-case for file names",
  "",
  "**Type**: behavior_correction",
  "**Observed**: Always use kebab-case for file names",
  "**Evidence**: session abc messages [1, 3]",
  "**Cross-session count**: 2",
  "**Proposed action**: AGENTS.md edit",
  "**Status**: proposed_agents_edit",
  "**Recorded by**: agent (session abc)",
  "",
  "---",
  "",
  "## 2026-05-27 10:00 — Prefer bun over npm",
  "",
  "**Type**: preference_expressed",
  "**Observed**: Prefer bun over npm",
  "**Evidence**: session xyz messages [2]",
  "**Cross-session count**: 2",
  "**Proposed action**: AGENTS.md edit",
  "**Status**: proposed_agents_edit",
  "**Recorded by**: agent (session xyz)",
  "",
  "---",
  "",
  "## 2026-05-26 09:00 — Use conventional commits",
  "",
  "**Type**: behavior_correction",
  "**Observed**: Use conventional commits",
  "**Evidence**: session old messages [0]",
  "**Cross-session count**: 1",
  "**Proposed action**: AGENTS.md edit",
  "**Status**: applied",
  "**Recorded by**: agent (session old)",
  "",
  "---",
].join("\n")

describe("findAgentLearnings", () => {
  test("returns empty array for empty body", () => {
    expect(findAgentLearnings("")).toEqual([])
  })

  test("returns only proposed_agents_edit entries", () => {
    const result = findAgentLearnings(SAMPLE_LEARNINGS_BODY)
    expect(result).toHaveLength(2)
  })

  test("ignores applied and skipped entries", () => {
    const result = findAgentLearnings(SAMPLE_LEARNINGS_BODY)
    expect(result.every(e => e.status === "proposed_agents_edit")).toBe(true)
  })

  test("parses observed correctly", () => {
    const result = findAgentLearnings(SAMPLE_LEARNINGS_BODY)
    expect(result[0].observed).toBe("Always use kebab-case for file names")
  })

  test("parses type correctly", () => {
    const result = findAgentLearnings(SAMPLE_LEARNINGS_BODY)
    expect(result[0].type).toBe("behavior_correction")
    expect(result[1].type).toBe("preference_expressed")
  })

  test("parses crossSessionCount correctly", () => {
    const result = findAgentLearnings(SAMPLE_LEARNINGS_BODY)
    expect(result[0].crossSessionCount).toBe(2)
  })

  test("parses projectTag as null when absent", () => {
    const result = findAgentLearnings(SAMPLE_LEARNINGS_BODY)
    expect(result[0].projectTag).toBeNull()
  })
})

describe("markLearningStatus", () => {
  test("replaces proposed_agents_edit with applied in correct section", () => {
    const result = markLearningStatus(
      SAMPLE_LEARNINGS_BODY,
      "Always use kebab-case for file names",
      "applied",
    )
    const sections = result.split(/^---$/m)
    expect(sections[0]).toContain("**Status**: applied")
    expect(sections[1]).toContain("**Status**: proposed_agents_edit")
  })

  test("replaces proposed_agents_edit with skipped in correct section", () => {
    const result = markLearningStatus(
      SAMPLE_LEARNINGS_BODY,
      "Prefer bun over npm",
      "skipped",
    )
    const sections = result.split(/^---$/m)
    expect(sections[1]).toContain("**Status**: skipped")
    expect(sections[0]).toContain("**Status**: proposed_agents_edit")
  })

  test("returns body unchanged if observed not found", () => {
    expect(markLearningStatus(SAMPLE_LEARNINGS_BODY, "nonexistent", "applied")).toBe(SAMPLE_LEARNINGS_BODY)
  })
})

describe("buildAgentsMdPrompt", () => {
  const entry: AgentLearningEntry = {
    observed: "Always use kebab-case for file names",
    type: "behavior_correction",
    crossSessionCount: 2,
    projectTag: null,
    status: "proposed_agents_edit",
  }

  test("includes observed text", () => {
    const prompt = buildAgentsMdPrompt(entry, "")
    expect(prompt).toContain("Always use kebab-case for file names")
  })

  test("includes type", () => {
    const prompt = buildAgentsMdPrompt(entry, "")
    expect(prompt).toContain("behavior_correction")
  })

  test("includes cross-session count", () => {
    const prompt = buildAgentsMdPrompt(entry, "")
    expect(prompt).toContain("2")
  })

  test("includes editInstruction when provided", () => {
    const prompt = buildAgentsMdPrompt(entry, "", "make it less strict")
    expect(prompt).toContain("make it less strict")
  })

  test("includes existing content when non-empty", () => {
    const prompt = buildAgentsMdPrompt(entry, "## Behavioral Rules\n\n### Some rule")
    expect(prompt).toContain("## Behavioral Rules")
  })
})

describe("patchAgentLearningsFile", () => {
  test("wraps in skeleton when existing content is empty", () => {
    const result = patchAgentLearningsFile("", "### Use kebab-case\n- **Rule**: kebab")
    expect(result).toContain("# Agent Learnings")
    expect(result).toContain("Auto-maintained")
    expect(result).toContain("Use kebab-case")
  })

  test("returns llmPatch directly when existing content is present", () => {
    const existing = "# Agent Learnings\n\n## Behavioral Rules\n"
    const patch = "# Agent Learnings\n\n## Behavioral Rules\n\n### New rule\n- **Rule**: foo\n"
    expect(patchAgentLearningsFile(existing, patch)).toBe(patch)
  })
})

describe("resolveAgentLearningsPath", () => {
  test("global scope returns ~/.config/opencode/agent-learnings.md", () => {
    const path = resolveAgentLearningsPath("global", "/some/project", "/Users/testuser")
    expect(path).toBe("/Users/testuser/.config/opencode/agent-learnings.md")
  })

  test("project scope returns <cwd>/agent-learnings.md", () => {
    const path = resolveAgentLearningsPath("project", "/Users/testuser/myproject", "/Users/testuser")
    expect(path).toBe("/Users/testuser/myproject/agent-learnings.md")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/agents-edit.test.ts
```

Expected: FAIL — "Cannot find module '../src/agents-edit'"

- [ ] **Step 3: Implement `src/agents-edit.ts`**

Create `src/agents-edit.ts`:

```ts
import * as fs from "node:fs/promises"
import * as nodePath from "node:path"
import type { AgentLearningEntry } from "./types.js"
import type { JoplinClient } from "./clients/joplin.js"
import { agentLearningsNoteName } from "./reflect.js"

const LLM_BASE  = process.env.OPENCODE_PA_LLM_URL   ?? "http://127.0.0.1:8889/v1"
const LLM_KEY   = process.env.OPENCODE_PA_LLM_KEY   ?? "1"
const LLM_MODEL = process.env.OPENCODE_PA_LLM_MODEL ?? "CLAUDE_4_6_SONNET"

const AGENT_LEARNINGS_SKELETON = `# Agent Learnings

> Auto-maintained by opencode personal-agent. Do not edit manually.
> Last updated: {DATE}

## Table of Contents

- [Behavioral Rules](#behavioral-rules)
- [Preferences](#preferences)
- [Project-Specific](#project-specific)

---

## Behavioral Rules

Rules the agent must follow, learned from corrections across sessions.

---

## Preferences

User preferences that shape how the agent works.

---

## Project-Specific

Rules that apply only within specific projects.
`

export function findAgentLearnings(noteBody: string): AgentLearningEntry[] {
  if (!noteBody.trim()) return []
  const sections = noteBody.split(/\n(?=## )/)
  const results: AgentLearningEntry[] = []
  for (const section of sections) {
    const statusMatch = section.match(/\*\*Status\*\*: (\S+)/)
    if (!statusMatch || statusMatch[1] !== "proposed_agents_edit") continue
    const observedMatch = section.match(/\*\*Observed\*\*: (.+)/)
    const typeMatch = section.match(/\*\*Type\*\*: (\S+)/)
    const countMatch = section.match(/\*\*Cross-session count\*\*: (\d+)/)
    const projectMatch = section.match(/\*\*Project\*\*: (.+)/)
    if (!observedMatch) continue
    results.push({
      observed: observedMatch[1].trim(),
      type: typeMatch?.[1]?.trim() ?? "behavior_correction",
      crossSessionCount: countMatch ? parseInt(countMatch[1], 10) : 1,
      projectTag: projectMatch ? projectMatch[1].trim() : null,
      status: "proposed_agents_edit",
    })
  }
  return results
}

export function markLearningStatus(
  body: string,
  observed: string,
  status: "applied" | "skipped",
): string {
  const sectionStart = body.indexOf(`**Observed**: ${observed}`)
  if (sectionStart === -1) return body
  const prevHeading = body.lastIndexOf("\n## ", sectionStart)
  const start = prevHeading === -1 ? 0 : prevHeading
  const nextSection = body.indexOf("\n## ", sectionStart)
  const end = nextSection === -1 ? body.length : nextSection
  const section = body.slice(start, end)
  const updated = section.replace("**Status**: proposed_agents_edit", `**Status**: ${status}`)
  return body.slice(0, start) + updated + body.slice(end)
}

export function buildAgentsMdPrompt(
  entry: AgentLearningEntry,
  existingContent: string,
  editInstruction?: string,
): string {
  const editNote = editInstruction
    ? `\n\nUser edit instruction: "${editInstruction}". Incorporate this into your output.`
    : ""

  const existingNote = existingContent
    ? `\n\nCurrent file content:\n${existingContent}`
    : "\n\nThe file does not exist yet — produce a full file using the skeleton structure."

  return `You are maintaining agent-learnings.md, a structured markdown file that records behavioral rules and preferences for an AI coding agent.

New learning to incorporate:
- Observed: ${entry.observed}
- Type: ${entry.type}
- Cross-session count: ${entry.crossSessionCount}
- Project tag: ${entry.projectTag ?? "none (global)"}${editNote}${existingNote}

Instructions:
1. If the existing file is empty or missing, output the full file using this skeleton:
   - # Agent Learnings header with "Auto-maintained" note and today's date
   - ## Behavioral Rules section (for behavior_correction type)
   - ## Preferences section (for preference_expressed type)
   - ## Project-Specific section (for entries with a project tag)
   - Table of Contents linking to each section

2. If the file already exists:
   - Add the new learning to the correct section based on type
   - If a similar entry already exists, update it instead of duplicating
   - Update the "Last updated" date
   - Keep all existing entries intact

3. Format each entry as:
   ### <short title from observed>
   - **Learned**: <date>
   - **Evidence**: Corrected/expressed <N> times across sessions
   - **Rule** or **Preference**: <concise actionable rule>

4. Output ONLY the complete file content, no prose before or after.`
}

export function patchAgentLearningsFile(
  existingContent: string,
  llmPatch: string,
): string {
  if (!existingContent.trim()) {
    const skeleton = AGENT_LEARNINGS_SKELETON.replace("{DATE}", new Date().toISOString().slice(0, 10))
    return skeleton + "\n" + llmPatch
  }
  return llmPatch
}

export function resolveAgentLearningsPath(
  scope: "global" | "project",
  cwd: string,
  home: string,
): string {
  if (scope === "global") {
    return nodePath.join(home, ".config", "opencode", "agent-learnings.md")
  }
  return nodePath.join(cwd, "agent-learnings.md")
}

async function generatePatch(
  entry: AgentLearningEntry,
  existingContent: string,
  editInstruction?: string,
): Promise<string> {
  const response = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LLM_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: "user", content: buildAgentsMdPrompt(entry, existingContent, editInstruction) }],
      max_tokens: 1200,
    }),
  })
  if (!response.ok) throw new Error(`LLM error: ${response.status}`)
  const data = await response.json() as any
  return data.choices?.[0]?.message?.content?.trim() ?? ""
}

export async function runAgentsEdit(
  args: string,
  sessionId: string,
  cwd: string,
  joplin: JoplinClient,
  pendingAgentsEdits: Set<string>,
): Promise<string> {
  const parts = args.trim().split(/\s+/)
  const confirmFlag = parts.includes("--confirm")
  const skipFlag = parts.includes("--skip")
  const scopeFlag = parts.find(p => p.startsWith("--scope="))
  const editFlag = args.match(/--edit="([^"]*)"/)
  const editInstruction = editFlag?.[1]
  const name = parts.filter(p => !p.startsWith("--") && !p.startsWith('"')).join(" ").trim()

  if (!name) {
    return "Usage: /agents-edit <name>  or  /agents-edit <name> --scope=global --confirm"
  }

  const now = new Date()
  const learningsNote = await joplin.getNote(agentLearningsNoteName(now))
  if (!learningsNote?.body) {
    return "Can't read Agent Learnings from Joplin. Is Joplin running?"
  }

  const entries = findAgentLearnings(learningsNote.body)
  const lowerName = name.toLowerCase()
  const entry = entries.find(e => e.observed === name) ??
    entries.find(e => e.observed.toLowerCase().includes(lowerName)) ??
    null

  if (!entry) {
    return `No proposed agent learning matching '${name}'. Run /wrap to see candidates.`
  }

  if (skipFlag) {
    try {
      const updatedBody = markLearningStatus(learningsNote.body, entry.observed, "skipped")
      await joplin.updateNote(learningsNote.id, updatedBody)
    } catch {
      // non-fatal
    }
    pendingAgentsEdits.delete(entry.observed)
    return "Skipped. Won't propose again."
  }

  if (confirmFlag && scopeFlag) {
    const scope = scopeFlag.replace("--scope=", "") as "global" | "project"
    if (scope !== "global" && scope !== "project") {
      return `Invalid scope '${scope}'. Use --scope=global or --scope=project.`
    }
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp"
    const filePath = resolveAgentLearningsPath(scope, cwd, home)

    let existingContent = ""
    try {
      existingContent = await fs.readFile(filePath, "utf-8")
    } catch {
      // file doesn't exist yet — start fresh
    }

    let patch: string
    try {
      patch = await generatePatch(entry, existingContent, editInstruction)
    } catch (err) {
      return `LLM unavailable — can't generate patch. Try again when endpoint is up. (${String(err)})`
    }

    if (!patch) return "LLM returned empty patch. Try again."

    const finalContent = patchAgentLearningsFile(existingContent, patch)

    try {
      const dir = nodePath.dirname(filePath)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(filePath, finalContent, "utf-8")
    } catch (err) {
      return `File write failed at ${filePath}: ${String(err)}\n\nPatch content:\n\n${finalContent}`
    }

    try {
      const updatedBody = markLearningStatus(learningsNote.body, entry.observed, "applied")
      await joplin.updateNote(learningsNote.id, updatedBody)
    } catch {
      // Joplin write failure is non-fatal — file already written
    }

    pendingAgentsEdits.delete(entry.observed)
    return `Written to ${filePath}. Agent learnings updated.`
  }

  // Preview mode — generate patch and return for agent to show user
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp"
  const globalPath = resolveAgentLearningsPath("global", cwd, home)
  const projectPath = resolveAgentLearningsPath("project", cwd, home)

  let existingContent = ""
  try {
    existingContent = await fs.readFile(globalPath, "utf-8")
  } catch {
    // file doesn't exist yet
  }

  let patch: string
  try {
    patch = await generatePatch(entry, existingContent)
  } catch (err) {
    return `LLM unavailable — can't generate patch. Try again when endpoint is up. (${String(err)})`
  }

  if (!patch) return "LLM returned empty patch. Try again."

  return [
    "AGENTS_EDIT_CANDIDATE",
    `observed: ${entry.observed}`,
    `type: ${entry.type}`,
    `cross_session_count: ${entry.crossSessionCount}`,
    `global_path: ${globalPath}`,
    `project_path: ${projectPath}`,
    "---PATCH---",
    patch,
  ].join("\n")
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/agents-edit.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents-edit.ts tests/agents-edit.test.ts
git commit -m "feat: agents-edit module — findAgentLearnings, markLearningStatus, buildAgentsMdPrompt, runAgentsEdit"
```

---

## Task 4: Extend `plugin.ts` — idle scan + nudge + `/agents-edit` handler

**Files:**
- Modify: `src/plugin.ts`

- [ ] **Step 1: Add import for `runAgentsEdit`**

Add to the existing imports block at the top of `src/plugin.ts`:

```ts
import { runAgentsEdit } from "./agents-edit.js"
```

- [ ] **Step 2: Extend the idle timer `.then()` chain to scan Agent Learnings**

Find the idle timer `.then()` callback. It currently ends after `writeNewPatterns`. Extend it to also scan Agent Learnings and populate `pendingAgentsEdits`:

```ts
reflect(s, client, joplin).then(async () => {
  const skillsNote = await joplin.getNote("Skills Proposed")
  const alreadyProposed = new Set(
    [...(skillsNote?.body ?? "").matchAll(/^## (.+?) — proposed/gm)].map((m: RegExpMatchArray) => m[1])
  )
  const candidates = detectPatterns(s.patternCandidates, alreadyProposed, PATTERN_THRESHOLD)
  await writeNewPatterns(candidates, joplin, JOPLIN_NOTEBOOK)

  const now = new Date()
  const learningsNoteName = `Agent Learnings \u2014 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  const learningsNote = await joplin.getNote(learningsNoteName)
  if (learningsNote?.body) {
    const sections = learningsNote.body.split(/\n(?=## )/)
    for (const section of sections) {
      const statusMatch = section.match(/\*\*Status\*\*: (\S+)/)
      const observedMatch = section.match(/\*\*Observed\*\*: (.+)/)
      if (statusMatch?.[1] === "proposed_agents_edit" && observedMatch) {
        const observed = observedMatch[1].trim()
        if (!s.pendingAgentsEdits.has(observed)) {
          s.pendingAgentsEdits.add(observed)
          await client.app.log({
            body: { service: "personal-agent", level: "info", message: `agents-edit flagged: ${observed}`, extra: {} },
          })
        }
      }
    }
  }
}).catch(async (err) => {
  await client.app.log({ body: { service: "personal-agent", level: "warn", message: "reflect/pattern error", extra: { error: String(err) } } })
})
```

- [ ] **Step 3: Add `pendingAgentsEdits` nudge in `experimental.chat.system.transform`**

Find the `experimental.chat.system.transform` handler. After the existing `pendingPromotions` nudge, add:

```ts
if (state && state.pendingAgentsEdits.size > 0) {
  const observed = [...state.pendingAgentsEdits].join("; ")
  output.system.push(
    `[personal-agent] Agent learning nudge: the following cross-session learnings are ready to apply to agent-learnings.md: ${observed}. Proactively mention this to the user and offer to run /agents-edit.`
  )
}
```

- [ ] **Step 4: Add `/agents-edit` command handler**

Find the `command.execute.before` handler. Add a `/agents-edit` branch after the existing `/promote` branch:

```ts
if (input.command === "agents-edit") {
  const state = sessions.get(input.sessionID)
  const args = (input as any).args ?? ""
  const cwd = process.cwd()
  try {
    const result = await runAgentsEdit(
      args,
      input.sessionID,
      cwd,
      joplin,
      state?.pendingAgentsEdits ?? new Set(),
    )
    output.parts.push({ type: "text", text: result } as any)
  } catch (err) {
    output.parts.push({ type: "text", text: `personal-agent: /agents-edit failed — ${String(err)}` } as any)
  }
  return
}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
bun run tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Run full test suite**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/plugin.ts
git commit -m "feat: plugin — idle agents-edit scan, pendingAgentsEdits nudge, /agents-edit handler"
```

---

## Task 5: Create `skills/agents-edit/SKILL.md`

**Files:**
- Create: `skills/agents-edit/SKILL.md`

- [ ] **Step 1: Write the skill file**

Create `skills/agents-edit/SKILL.md`:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add skills/agents-edit/SKILL.md
git commit -m "feat: /agents-edit SKILL.md"
```

---

## Task 6: Update `~/.config/opencode/AGENTS.md` + final verification

**Files:**
- Update: `~/.config/opencode/AGENTS.md`

- [ ] **Step 1: Add reference note to global AGENTS.md**

Open `~/.config/opencode/AGENTS.md`. Add this block near the top, after any title/header but before the main content:

```markdown
## LLM-Maintained Learnings

Agent behavioral rules and preferences learned across sessions are stored separately in:
`~/.config/opencode/agent-learnings.md`

This file is auto-maintained by the personal-agent plugin. Do not edit it manually.
Both this file and `agent-learnings.md` are injected into every session at startup.
```

- [ ] **Step 2: Run full test suite**

```bash
bun test
```

Expected: all 106+ tests pass (95 from phases 1-4 + 11 new from agents-edit).

- [ ] **Step 3: Verify TypeScript**

```bash
bun run tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Verify skills directory**

```bash
ls skills/
```

Expected: `agents-edit/`, `promote/`, `wrap/` all present.

- [ ] **Step 5: Final commit and PR**

```bash
git add -A
git status   # verify AGENTS.md in ~/.config/opencode/ is NOT staged (it's outside the repo)
git commit -m "chore: phase 5 complete — cross-session learnings + /agents-edit" --allow-empty
gh pr create \
  --title "feat: phase 5 — cross-session learnings + /agents-edit" \
  --body "Implements phase 5 per spec \`docs/superpowers/specs/2026-05-28-phase-5-cross-session-learnings-agents-edit-design.md\`

## What's in this PR

- \`src/agents-edit.ts\` — findAgentLearnings, markLearningStatus, buildAgentsMdPrompt, patchAgentLearningsFile, resolveAgentLearningsPath, runAgentsEdit
- \`src/bootstrap.ts\` — reads agent-learnings.md at session start, injects into system prompt
- \`src/types.ts\` — AgentLearningEntry, pendingAgentsEdits on SessionState, agentLearnings on BootstrapData
- \`src/plugin.ts\` — idle Agent Learnings scan, pendingAgentsEdits nudge, /agents-edit command handler
- \`skills/agents-edit/SKILL.md\` — agent instructions for apply/skip/edit flow
- \`tests/agents-edit.test.ts\` — unit tests for all pure functions
- \`tests/bootstrap.test.ts\` — extended with agent-learnings injection tests" \
  --assignee SasidharanGS
```
