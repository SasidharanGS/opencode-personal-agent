# Phase 4 — Pattern Detection + `/promote` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a tool call repeats 3+ times in a session, the plugin injects a nudge into the next conversation turn and durably records it in Joplin; the user can then run `/promote <name>` (guided by the agent) to generate and write a SKILL.md with one confirmation.

**Architecture:** Two new modules (`patterns.ts`, `promote.ts`) mirror the existing `wrap.ts` pattern. `plugin.ts` grows three small extensions: a threshold check in `tool.execute.before`, a nudge injection in `experimental.chat.system.transform`, and a `/promote` command handler. The idle pass calls `writeNewPatterns` after `reflect`. All I/O is fire-and-forget; `SessionState` is the source of truth mid-session.

**Tech Stack:** TypeScript, Bun (test runner: `bun test`), Joplin MCP via `JoplinClient`, OpenAI-compatible LLM endpoint (same as reflection).

**Spec:** `docs/superpowers/specs/2026-05-28-phase-4-pattern-detection-promote-design.md`

---

## File Map

| File | Action |
|---|---|
| `src/types.ts` | Extend — add `PatternCandidate`, `pendingPromotions` to `SessionState` |
| `src/patterns.ts` | Create — `detectPatterns`, `skillsProposedEntry`, `markPromoted`, `writeNewPatterns` |
| `src/promote.ts` | Create — `runPromote`, `resolveSkillPath`, LLM call for SKILL.md draft |
| `src/plugin.ts` | Extend — threshold check, nudge injection, idle extension, `/promote` handler |
| `skills/promote/SKILL.md` | Create — user-facing skill docs |
| `tests/patterns.test.ts` | Create — unit tests for pure functions in `patterns.ts` |
| `tests/promote.test.ts` | Create — unit tests for entry parsing, path resolution |

---

## Task 1: Extend types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add `PatternCandidate` interface and `pendingPromotions` to `SessionState`**

Open `src/types.ts`. Make these two changes:

Add after the existing `ToolCall` interface:

```ts
export interface PatternCandidate {
  sig: string
  tool: string
  hits: number
}
```

Add `pendingPromotions` to `SessionState`:

```ts
export interface SessionState {
  sessionId: string
  startedAt: Date
  lastActivityTs: Date
  lastReflectionTs: Date | null
  toolCalls: ToolCall[]
  patternCandidates: Map<string, number>
  pendingPromotions: Set<string>          // ← add this line
  bootstrappedContext: string | null
  idleTimer: ReturnType<typeof setTimeout> | null
}
```

- [ ] **Step 2: Initialize `pendingPromotions` in `plugin.ts` session creation**

In `src/plugin.ts`, find the `SessionState` object literal inside `session.created` handler (around line 44). Add `pendingPromotions: new Set(),` alongside the other fields:

```ts
const state: SessionState = {
  sessionId,
  startedAt: new Date(),
  lastActivityTs: new Date(),
  lastReflectionTs: null,
  toolCalls: [],
  patternCandidates: new Map(),
  pendingPromotions: new Set(),
  bootstrappedContext: null,
  idleTimer: null,
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
bun run tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/plugin.ts
git commit -m "feat: add PatternCandidate type and pendingPromotions to SessionState"
```

---

## Task 2: Create `src/patterns.ts` — pure functions

**Files:**
- Create: `src/patterns.ts`
- Create: `tests/patterns.test.ts`

- [ ] **Step 1: Write the failing tests first**

Create `tests/patterns.test.ts`:

```ts
import { expect, test, describe } from "bun:test"
import { detectPatterns, skillsProposedEntry, markPromoted } from "../src/patterns"

describe("detectPatterns", () => {
  test("returns empty array for empty map", () => {
    expect(detectPatterns(new Map(), new Set())).toEqual([])
  })

  test("returns empty array when all sigs below threshold", () => {
    const m = new Map([["bash:git status", 2], ["bash:git log", 1]])
    expect(detectPatterns(m, new Set())).toEqual([])
  })

  test("returns candidates at exactly threshold (3)", () => {
    const m = new Map([["bash:git status", 3]])
    const result = detectPatterns(m, new Set())
    expect(result).toHaveLength(1)
    expect(result[0].sig).toBe("bash:git status")
    expect(result[0].tool).toBe("bash")
    expect(result[0].hits).toBe(3)
  })

  test("returns candidates above threshold", () => {
    const m = new Map([["bash:git status", 5]])
    const result = detectPatterns(m, new Set())
    expect(result[0].hits).toBe(5)
  })

  test("filters out sigs already in alreadyProposed", () => {
    const m = new Map([["bash:git status", 4], ["bash:git log", 3]])
    const result = detectPatterns(m, new Set(["bash:git status"]))
    expect(result).toHaveLength(1)
    expect(result[0].sig).toBe("bash:git log")
  })

  test("extracts tool name from sig prefix", () => {
    const m = new Map([["write:src/index.ts", 3]])
    const result = detectPatterns(m, new Set())
    expect(result[0].tool).toBe("write")
  })

  test("handles unknown tool prefix gracefully", () => {
    const m = new Map([["mytool:somestuff", 3]])
    const result = detectPatterns(m, new Set())
    expect(result[0].tool).toBe("mytool")
  })
})

describe("skillsProposedEntry", () => {
  test("renders correct markdown block", () => {
    const now = new Date("2026-05-28T12:00:00Z")
    const entry = skillsProposedEntry({ sig: "bash:git status", tool: "bash", hits: 4 }, now)
    expect(entry).toContain("## bash:git status — proposed")
    expect(entry).toContain("**Tool**: bash")
    expect(entry).toContain("**Hits this session**: 4")
    expect(entry).toContain("**Status**: pending")
    expect(entry).toContain("2026-05-28")
    expect(entry).toContain("---")
  })
})

describe("markPromoted", () => {
  test("replaces Status: pending with Status: promoted", () => {
    const body = "## bash:git status — proposed\n\n**Status**: pending\n\n---"
    const result = markPromoted(body, "bash:git status")
    expect(result).toContain("**Status**: promoted")
    expect(result).not.toContain("**Status**: pending")
  })

  test("only replaces within the matching section", () => {
    const body = [
      "## bash:git status — proposed",
      "",
      "**Status**: pending",
      "",
      "---",
      "",
      "## bash:git log — proposed",
      "",
      "**Status**: pending",
      "",
      "---",
    ].join("\n")
    const result = markPromoted(body, "bash:git status")
    const sections = result.split("---")
    expect(sections[0]).toContain("**Status**: promoted")
    expect(sections[1]).toContain("**Status**: pending")
  })

  test("returns body unchanged if sig not found", () => {
    const body = "## bash:git status — proposed\n\n**Status**: pending\n\n---"
    expect(markPromoted(body, "bash:git log")).toBe(body)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/patterns.test.ts
```

Expected: FAIL — "Cannot find module '../src/patterns'"

- [ ] **Step 3: Implement `src/patterns.ts`**

Create `src/patterns.ts`:

```ts
import type { PatternCandidate } from "./types.js"
import type { JoplinClient } from "./clients/joplin.js"

const PATTERN_THRESHOLD = 3

export function detectPatterns(
  candidates: Map<string, number>,
  alreadyProposed: Set<string>,
  threshold = PATTERN_THRESHOLD,
): PatternCandidate[] {
  const result: PatternCandidate[] = []
  for (const [sig, hits] of candidates) {
    if (hits < threshold) continue
    if (alreadyProposed.has(sig)) continue
    const tool = sig.split(":")[0] ?? sig
    result.push({ sig, tool, hits })
  }
  return result
}

export function skillsProposedEntry(candidate: PatternCandidate, now: Date): string {
  const ts = now.toISOString().slice(0, 10)
  return [
    `## ${candidate.sig} — proposed`,
    "",
    `**Tool**: ${candidate.tool}`,
    `**Hits this session**: ${candidate.hits}`,
    `**Status**: pending`,
    `**Proposed**: ${ts}`,
    "",
    "---",
  ].join("\n")
}

export function markPromoted(body: string, sig: string): string {
  const sectionStart = body.indexOf(`## ${sig} — proposed`)
  if (sectionStart === -1) return body
  const nextSection = body.indexOf("\n## ", sectionStart + 1)
  const sectionEnd = nextSection === -1 ? body.length : nextSection
  const section = body.slice(sectionStart, sectionEnd)
  const updated = section.replace("**Status**: pending", "**Status**: promoted")
  return body.slice(0, sectionStart) + updated + body.slice(sectionEnd)
}

export async function writeNewPatterns(
  candidates: PatternCandidate[],
  joplin: JoplinClient,
): Promise<void> {
  if (candidates.length === 0) return
  const existing = await joplin.getNote("Skills Proposed")
  const existingBody = existing?.body ?? ""
  const alreadyInNote = new Set(
    [...existingBody.matchAll(/^## (.+?) — proposed/gm)].map(m => m[1])
  )
  const newEntries = candidates
    .filter(c => !alreadyInNote.has(c.sig))
    .map(c => skillsProposedEntry(c, new Date()))
    .join("\n")
  if (!newEntries) return
  await joplin.appendToNote("Skills Proposed", "\n" + newEntries)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/patterns.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/patterns.ts tests/patterns.test.ts
git commit -m "feat: patterns module — detectPatterns, skillsProposedEntry, markPromoted, writeNewPatterns"
```

---

## Task 3: Create `src/promote.ts`

**Files:**
- Create: `src/promote.ts`
- Create: `tests/promote.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/promote.test.ts`:

```ts
import { expect, test, describe } from "bun:test"
import { findCandidate, resolveSkillPath, buildPromotePrompt } from "../src/promote"

const SAMPLE_NOTE_BODY = [
  "## bash:git status — proposed",
  "",
  "**Tool**: bash",
  "**Hits this session**: 4",
  "**Status**: pending",
  "**Proposed**: 2026-05-28",
  "",
  "---",
  "",
  "## bash:git log --oneline -10 — proposed",
  "",
  "**Tool**: bash",
  "**Hits this session**: 3",
  "**Status**: pending",
  "**Proposed**: 2026-05-28",
  "",
  "---",
  "",
  "## bash:git diff — proposed",
  "",
  "**Tool**: bash",
  "**Hits this session**: 5",
  "**Status**: promoted",
  "**Proposed**: 2026-05-27",
  "",
  "---",
].join("\n")

describe("findCandidate", () => {
  test("finds by exact sig match", () => {
    const result = findCandidate(SAMPLE_NOTE_BODY, "bash:git status")
    expect(result).not.toBeNull()
    expect(result!.sig).toBe("bash:git status")
    expect(result!.hits).toBe(4)
  })

  test("fuzzy matches on partial tool name token", () => {
    const result = findCandidate(SAMPLE_NOTE_BODY, "git status")
    expect(result).not.toBeNull()
    expect(result!.sig).toBe("bash:git status")
  })

  test("returns null when name not found", () => {
    expect(findCandidate(SAMPLE_NOTE_BODY, "nonexistent")).toBeNull()
  })

  test("ignores already-promoted entries", () => {
    const result = findCandidate(SAMPLE_NOTE_BODY, "bash:git diff")
    expect(result).toBeNull()
  })

  test("returns first pending match on ambiguous fuzzy", () => {
    const result = findCandidate(SAMPLE_NOTE_BODY, "git")
    expect(result).not.toBeNull()
    expect(result!.sig).toBe("bash:git status")
  })
})

describe("resolveSkillPath", () => {
  test("global scope uses ~/.config/opencode/skills/", () => {
    const home = "/Users/testuser"
    const path = resolveSkillPath("git-status", "global", "/some/project", home)
    expect(path).toBe("/Users/testuser/.config/opencode/skills/git-status/SKILL.md")
  })

  test("project scope uses <cwd>/.opencode/skills/", () => {
    const path = resolveSkillPath("git-status", "project", "/Users/testuser/myproject", "/Users/testuser")
    expect(path).toBe("/Users/testuser/myproject/.opencode/skills/git-status/SKILL.md")
  })

  test("sanitizes skill name to lowercase-kebab", () => {
    const path = resolveSkillPath("Git Status Check", "global", "/cwd", "/home/user")
    expect(path).toBe("/home/user/.config/opencode/skills/git-status-check/SKILL.md")
  })
})

describe("buildPromotePrompt", () => {
  test("includes sig, tool, and hits in the prompt", () => {
    const prompt = buildPromotePrompt({ sig: "bash:git status", tool: "bash", hits: 4 })
    expect(prompt).toContain("bash:git status")
    expect(prompt).toContain("bash")
    expect(prompt).toContain("4")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/promote.test.ts
```

Expected: FAIL — "Cannot find module '../src/promote'"

- [ ] **Step 3: Implement `src/promote.ts`**

Create `src/promote.ts`:

```ts
import * as fs from "node:fs/promises"
import * as nodePath from "node:path"
import type { PatternCandidate } from "./types.js"
import type { JoplinClient } from "./clients/joplin.js"
import { markPromoted } from "./patterns.js"

const LLM_BASE  = process.env.OPENCODE_PA_LLM_URL   ?? "http://127.0.0.1:8889/v1"
const LLM_KEY   = process.env.OPENCODE_PA_LLM_KEY   ?? "1"
const LLM_MODEL = process.env.OPENCODE_PA_LLM_MODEL ?? "CLAUDE_4_6_SONNET"

export interface FoundCandidate {
  sig: string
  tool: string
  hits: number
}

export function findCandidate(noteBody: string, name: string): FoundCandidate | null {
  const sections = noteBody.split(/\n(?=## )/)
  const pending = sections.filter(s => s.includes("**Status**: pending"))

  for (const section of pending) {
    const sigMatch = section.match(/^## (.+?) — proposed/)
    if (!sigMatch) continue
    const sig = sigMatch[1]
    if (sig === name) {
      return extractCandidate(section, sig)
    }
  }

  const lowerName = name.toLowerCase()
  for (const section of pending) {
    const sigMatch = section.match(/^## (.+?) — proposed/)
    if (!sigMatch) continue
    const sig = sigMatch[1]
    if (sig.toLowerCase().includes(lowerName)) {
      return extractCandidate(section, sig)
    }
  }

  return null
}

function extractCandidate(section: string, sig: string): FoundCandidate {
  const toolMatch = section.match(/\*\*Tool\*\*: (.+)/)
  const hitsMatch = section.match(/\*\*Hits this session\*\*: (\d+)/)
  return {
    sig,
    tool: toolMatch?.[1]?.trim() ?? sig.split(":")[0] ?? sig,
    hits: hitsMatch ? parseInt(hitsMatch[1], 10) : 0,
  }
}

export function resolveSkillPath(
  name: string,
  scope: "global" | "project",
  cwd: string,
  home: string,
): string {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  if (scope === "global") {
    return nodePath.join(home, ".config", "opencode", "skills", sanitized, "SKILL.md")
  }
  return nodePath.join(cwd, ".opencode", "skills", sanitized, "SKILL.md")
}

export function buildPromotePrompt(candidate: PatternCandidate): string {
  return `You are helping a developer turn a repeated tool pattern into an opencode skill.

Pattern details:
- Signature: ${candidate.sig}
- Tool: ${candidate.tool}
- Times repeated this session: ${candidate.hits}

Write a SKILL.md file for this pattern. The skill should:
1. Have a short title matching the pattern
2. Explain when to use this skill (1-2 sentences)
3. Show the exact command or action to perform
4. Include any important notes or caveats

Format:
# <skill title>

## When to use
<1-2 sentences>

## What it does
<brief description>

## How to use
<exact command or steps>

## Notes
<any caveats>

Output only the SKILL.md content, no prose before or after.`
}

export async function generateSkillMd(candidate: PatternCandidate): Promise<string> {
  const response = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LLM_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "user", content: buildPromotePrompt(candidate) },
      ],
      max_tokens: 600,
    }),
  })
  if (!response.ok) throw new Error(`LLM error: ${response.status}`)
  const data = await response.json() as any
  return data.choices?.[0]?.message?.content?.trim() ?? ""
}

export async function writeSkillFile(path: string, content: string): Promise<void> {
  const dir = nodePath.dirname(path)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path, content, "utf-8")
}

export async function runPromote(
  args: string,
  sessionId: string,
  cwd: string,
  client: any,
  joplin: JoplinClient,
  pendingPromotions: Set<string>,
): Promise<string> {
  const parts = args.trim().split(/\s+/)
  const confirmFlag = parts.includes("--confirm")
  const scopeFlag = parts.find(p => p.startsWith("--scope="))
  const name = parts.filter(p => !p.startsWith("--")).join(" ").trim()

  if (!name) {
    return "Usage: /promote <name>  or  /promote <name> --scope=global --confirm"
  }

  const note = await joplin.getNote("Skills Proposed")
  if (!note?.body) {
    return "No pending skill candidates found. Run a session with repeated tool calls first."
  }

  const candidate = findCandidate(note.body, name)
  if (!candidate) {
    return `No pending skill candidate matching '${name}'. Run /wrap to see candidates.`
  }

  if (confirmFlag && scopeFlag) {
    const scope = scopeFlag.replace("--scope=", "") as "global" | "project"
    if (scope !== "global" && scope !== "project") {
      return `Invalid scope '${scope}'. Use --scope=global or --scope=project.`
    }
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp"
    const skillPath = resolveSkillPath(candidate.sig, scope, cwd, home)

    let draft: string
    try {
      draft = await generateSkillMd(candidate)
    } catch (err) {
      return `LLM unavailable — can't generate draft. Try again when endpoint is up. (${String(err)})`
    }

    if (!draft) {
      return "LLM returned empty draft. Try again."
    }

    try {
      await writeSkillFile(skillPath, draft)
    } catch (err) {
      return `File write failed at ${skillPath}: ${String(err)}\n\nDraft content:\n\n${draft}`
    }

    try {
      const updatedBody = markPromoted(note.body, candidate.sig)
      await joplin.appendToNote("Skills Proposed", "")
      const freshNote = await joplin.getNote("Skills Proposed")
      if (freshNote) {
        await joplin.updateNote(freshNote.id, updatedBody)
      }
    } catch {
      // Joplin write failure is non-fatal — skill file already written
    }

    pendingPromotions.delete(candidate.sig)

    return `Written to ${skillPath}. Restart opencode to load the new skill.`
  }

  let draft: string
  try {
    draft = await generateSkillMd(candidate)
  } catch (err) {
    return `LLM unavailable — can't generate draft. Try again when endpoint is up. (${String(err)})`
  }

  if (!draft) {
    return "LLM returned empty draft. Try again."
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp"
  const globalPath = resolveSkillPath(candidate.sig, "global", cwd, home)
  const projectPath = resolveSkillPath(candidate.sig, "project", cwd, home)

  return [
    `PROMOTE_CANDIDATE`,
    `sig: ${candidate.sig}`,
    `tool: ${candidate.tool}`,
    `hits: ${candidate.hits}`,
    `global_path: ${globalPath}`,
    `project_path: ${projectPath}`,
    `---DRAFT---`,
    draft,
  ].join("\n")
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/promote.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/promote.ts tests/promote.test.ts
git commit -m "feat: promote module — findCandidate, resolveSkillPath, generateSkillMd, runPromote"
```

---

## Task 4: Extend `plugin.ts` — threshold check + nudge + idle extension + command handler

**Files:**
- Modify: `src/plugin.ts`

- [ ] **Step 1: Add import for new modules at the top of `plugin.ts`**

Add to the existing imports block:

```ts
import { detectPatterns, writeNewPatterns } from "./patterns.js"
import { runPromote } from "./promote.js"
```

- [ ] **Step 2: Add threshold check in `tool.execute.before`**

Find the existing `tool.execute.before` handler. After the existing lines that update `patternCandidates`, add the threshold check:

```ts
"tool.execute.before": async (input, output) => {
  const state = sessions.get(input.sessionID)
  if (!state) return
  state.lastActivityTs = new Date()
  const sig = normalizeArgs(input.tool, output.args)
  state.toolCalls.push({ ts: new Date(), tool: input.tool, argsSignature: sig })
  if (state.toolCalls.length > 200) state.toolCalls.shift()
  const newCount = (state.patternCandidates.get(sig) ?? 0) + 1
  state.patternCandidates.set(sig, newCount)
  if (newCount === PATTERN_THRESHOLD && !state.pendingPromotions.has(sig)) {
    state.pendingPromotions.add(sig)
    await client.app.log({
      body: { service: "personal-agent", level: "info", message: `pattern flagged: ${sig}`, extra: { hits: newCount } },
    })
  }
},
```

Add the constant near the top of the file alongside the other constants:

```ts
const PATTERN_THRESHOLD = Number(process.env.OPENCODE_PA_PATTERN_THRESHOLD ?? 3)
```

- [ ] **Step 3: Add nudge injection in `experimental.chat.system.transform`**

Find the existing `experimental.chat.system.transform` handler. Add pendingPromotions nudge after the existing bootstrappedContext push:

```ts
"experimental.chat.system.transform": async (input, output) => {
  const sessionId = input.sessionID
  if (!sessionId) return
  const state = sessions.get(sessionId)
  if (state?.bootstrappedContext) {
    output.system.push(state.bootstrappedContext)
  }
  if (state && state.pendingPromotions.size > 0) {
    const sigs = [...state.pendingPromotions].join(", ")
    output.system.push(
      `[personal-agent] Pattern nudge: the following tool patterns have repeated 3+ times this session and are ready to promote into skills: ${sigs}. Proactively mention this to the user and offer to run /promote.`
    )
  }
},
```

- [ ] **Step 4: Add `writeNewPatterns` call in the idle timer**

Find the idle timer callback (inside `session.idle` handler). After the existing `reflect(...)` call, add:

```ts
reflect(s, client, joplin).then(async () => {
  const alreadyProposed = new Set(
    [...(await joplin.getNote("Skills Proposed") ?? { body: "" }).body.matchAll(/^## (.+?) — proposed/gm)]
      .map((m: RegExpMatchArray) => m[1])
  )
  const candidates = detectPatterns(s.patternCandidates, alreadyProposed)
  await writeNewPatterns(candidates, joplin)
}).catch(async (err) => {
  await client.app.log({ body: { service: "personal-agent", level: "warn", message: "reflect/pattern error", extra: { error: String(err) } } })
})
```

Replace the existing `.catch` block that was on `reflect(...)` alone.

- [ ] **Step 5: Add `/promote` command handler**

Find the existing `command.execute.before` handler (the `/wrap` handler). Add a branch for `/promote` alongside the existing `/wrap` branch:

```ts
"command.execute.before": async (input, output) => {
  if (input.command === "wrap") {
    const state = sessions.get(input.sessionID)
    if (!state) {
      output.parts.push({ type: "text", text: "personal-agent: no session state found for /wrap" } as any)
      return
    }
    try {
      const summary = await runWrap(state, client, joplin)
      output.parts.push({ type: "text", text: summary } as any)
    } catch (err) {
      output.parts.push({ type: "text", text: `personal-agent: /wrap failed — ${String(err)}` } as any)
    }
    return
  }

  if (input.command === "promote") {
    const state = sessions.get(input.sessionID)
    const args = (input as any).args ?? ""
    const cwd = (state as any)?.cwd ?? process.cwd()
    try {
      const result = await runPromote(
        args,
        input.sessionID,
        cwd,
        client,
        joplin,
        state?.pendingPromotions ?? new Set(),
      )
      output.parts.push({ type: "text", text: result } as any)
    } catch (err) {
      output.parts.push({ type: "text", text: `personal-agent: /promote failed — ${String(err)}` } as any)
    }
    return
  }
},
```

- [ ] **Step 6: Register `/promote` as a command file**

Create `skills/promote/SKILL.md` (done in Task 5) — the plugin discovers commands from `skills/` directory the same way `/wrap` is registered. Verify by checking how `wrap` is registered:

```bash
grep -r "wrap" ~/.config/opencode/opencode.jsonc 2>/dev/null || grep -r "commands" src/plugin.ts | head -5
```

If commands are auto-discovered from the skills directory, no extra registration is needed. If explicit, add `"promote"` to the commands list alongside `"wrap"`.

- [ ] **Step 7: Verify TypeScript compiles**

```bash
bun run tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/plugin.ts
git commit -m "feat: plugin — threshold check, pendingPromotions nudge, idle pattern write, /promote handler"
```

---

## Task 5: Create `skills/promote/SKILL.md`

**Files:**
- Create: `skills/promote/SKILL.md`

- [ ] **Step 1: Write the skill file**

Create `skills/promote/SKILL.md`:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add skills/promote/SKILL.md
git commit -m "feat: /promote SKILL.md"
```

---

## Task 6: Run full test suite + verify

- [ ] **Step 1: Run all tests**

```bash
bun test
```

Expected: all tests pass, including the new `patterns.test.ts` and `promote.test.ts`.

- [ ] **Step 2: Check TypeScript**

```bash
bun run tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Verify `/promote` appears as a registered command**

```bash
ls skills/
```

Expected: both `wrap/` and `promote/` directories present.

- [ ] **Step 4: Final commit and PR**

```bash
git add -A
git status   # verify only intended files staged; AGENTS.md must NOT appear
git commit -m "chore: phase 4 complete — pattern detection + /promote"
gh pr create --title "feat: phase 4 — pattern detection + /promote" \
  --body "Implements phase 4 per spec docs/superpowers/specs/2026-05-28-phase-4-pattern-detection-promote-design.md

- src/patterns.ts: detectPatterns, skillsProposedEntry, markPromoted, writeNewPatterns
- src/promote.ts: findCandidate, resolveSkillPath, generateSkillMd, runPromote
- plugin.ts: threshold check, pendingPromotions nudge, idle pattern write, /promote handler
- skills/promote/SKILL.md: user-facing skill docs
- tests: patterns.test.ts, promote.test.ts" \
  --assignee SasidharanGS
```
