# Joplin Compact Schema v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the opencode-personal-agent Joplin schema from verbose v1 to compact v2 — adding a numeric `significance` field, replacing the verbose `**Field**:` body with compact `field:` prefixes, deleting the `Project Notes — <tag>` mirror entity, and replacing the flat bootstrap projection with a two-tier (12 active + 7 cross-project, sig≥6) shape — to cut bootstrap injection from ~2.5 KB to ≤1.6 KB while increasing signal per token.

**Architecture:** Land changes in an order that keeps the repo green and the live system functional at every step. Types and the dual-format parser ship first so reads keep working. Reflection prompt and compact renderers ship next; writes flip to new format. Bootstrap projection flips to two-tier. Migration script then converts existing data and deletes the mirror entity. Each task is a single atomic commit.

**Tech Stack:** TypeScript (Bun runtime), Vitest, Joplin REST data API, Node fetch.

**Spec:** `docs/superpowers/specs/2026-06-06-joplin-compact-schema-v2-design.md`

---

## Task 1: Add new types alongside old (backward compatible)

Add the v2 schema types without removing the v1 types. This task introduces no behavior change — it only makes the new shapes available for later tasks to consume.

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Read current types**

Run: `cat src/types.ts | wc -l`
Expected: 106

- [ ] **Step 2: Add `BootstrapEntry` type and reshape `BootstrapData` with backward-compat fields**

Edit `src/types.ts`. Replace the `BootstrapData` interface (lines 54–61) with:

```typescript
export interface BootstrapEntry {
  date: string         // ISO date "YYYY-MM-DD"
  time: string         // "HH:MM"
  kind: "m" | "d"      // memory or decision
  projectTag: string   // "general" when null
  sig: number          // 1-10, clamped
  title: string
  summary: string      // first sentence of why/did/chose, ~60 chars max
}

export interface BootstrapData {
  projectName: string
  // v2 fields (set by gatherBootstrapData in Task 5):
  recentActive: BootstrapEntry[]
  recentOther: BootstrapEntry[]
  activitySummary: string | null
  agentLearnings: string | null
  // v1 fields — DEPRECATED; retained for one task to keep tests green.
  // Removed in Task 5.
  recentDecisions?: string[]
  recentMemories?: string[]
  projectNotes?: string[]
}
```

- [ ] **Step 3: Add numeric `significance` to all three reflection types**

In the same file, replace the three reflection interfaces (lines 69–95) with:

```typescript
export interface ReflectionDecision {
  title: string
  context: string
  decision: string
  rationale: string
  rejected: string[]
  project_tag: string | null
  confidence: number
  significance: number     // 1-10, clamped at parse time, default 5
}

export interface ReflectionMemory {
  title: string
  what_happened: string
  significance_text: string   // renamed from `significance` (string) — qualitative one-liner
  files_touched: string[]
  loose_ends: string[]
  project_tag: string | null
  confidence: number
  significance: number        // 1-10 numeric — NEW
}

export interface ReflectionLearning {
  type: "behavior_correction" | "preference_expressed"
  observed: string
  evidence_message_indices: number[]
  proposed_action: "AGENTS.md edit" | "skill" | "behavior only"
  confidence: number
  significance: number     // 1-10, NEW
}
```

The existing string field `ReflectionMemory.significance` is renamed to `significance_text` to free the field name for the new numeric value. This rename ripples to `reflect.ts` `renderMemory` and tests — fixed in Steps 4-5 of this task.

- [ ] **Step 4: Fix the consumer of the renamed `significance` field in `renderMemory`**

Edit `src/reflect.ts` line 63 — change:

```typescript
return `## ${ts} \u2014 ${m.title}\n\n**Project**: ${m.project_tag ?? "general"}${tag}\n**What happened**: ${m.what_happened}\n**Significance**: ${m.significance}\n**Files touched**:\n${files}\n**Loose ends**:\n${loose}\n\n**Recorded by**: agent (session ${sessionId})\n\n---`
```

to:

```typescript
return `## ${ts} \u2014 ${m.title}\n\n**Project**: ${m.project_tag ?? "general"}${tag}\n**What happened**: ${m.what_happened}\n**Significance**: ${m.significance_text}\n**Files touched**:\n${files}\n**Loose ends**:\n${loose}\n\n**Recorded by**: agent (session ${sessionId})\n\n---`
```

(Replaces `${m.significance}` with `${m.significance_text}` — exactly one substitution.)

- [ ] **Step 5: Clamp + default `significance` in `parseReflectionJson`**

Edit `src/reflect.ts` lines 42-48 (the filter pipeline) — replace with:

```typescript
const clampSig = (v: any): number => {
  const n = Number(v)
  if (!Number.isFinite(n)) return 5
  return Math.max(1, Math.min(10, Math.round(n)))
}
const decisions: ReflectionDecision[] = (Array.isArray(parsed.decisions) ? parsed.decisions : [])
  .filter((d: any) => d && typeof d === "object" && (d.confidence ?? 0) >= CONFIDENCE_THRESHOLD)
  .map((d: any) => ({ ...d, significance: clampSig(d.significance) }))
const memories: ReflectionMemory[] = (Array.isArray(parsed.memories) ? parsed.memories : [])
  .filter((m: any) => m && typeof m === "object" && (m.confidence ?? 0) >= CONFIDENCE_THRESHOLD)
  .map((m: any) => ({ ...m, significance_text: m.significance_text ?? m.significance ?? "", significance: clampSig(m.significance_num ?? m.significance) }))
const agent_learnings: ReflectionLearning[] = (Array.isArray(parsed.agent_learnings) ? parsed.agent_learnings : [])
  .filter((l: any) => l && typeof l === "object")
  .map((l: any) => ({ ...l, significance: clampSig(l.significance) }))
return { decisions, memories, agent_learnings }
```

Note for memories: the LLM today emits `significance` as a string. After Task 3 it will emit BOTH `significance_text` (string) AND `significance` (number). This parser handles both transitional states.

- [ ] **Step 6: Update `tests/reflect.test.ts` fixtures**

Run: `grep -n significance tests/reflect.test.ts`

For each fixture object passed to `renderMemory`, add `significance_text: "<existing text>"` and rename the existing `significance: "..."` to `significance_text: "..."`. Add `significance: 5` to every ReflectionMemory, ReflectionDecision, and ReflectionLearning fixture. Add the same to `parseReflectionJson` test inputs as required.

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: 150/150 pass (same count as before this task).

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/reflect.ts tests/reflect.test.ts
git commit -m "feat(types): add v2 schema types alongside v1

- Add BootstrapEntry; reshape BootstrapData with deprecated v1 fields retained
- Add significance: number (1-10, clamped) to all three reflection types
- Rename ReflectionMemory.significance: string -> significance_text
- Clamp + default significance at parse boundary

No behavior change. Renderers + bootstrap unchanged in this commit."
```

---

## Task 2: Dual-format parser — `parseEntries`

Add a new parser that returns structured `BootstrapEntry[]` and handles both v1 and v2 note bodies. Keep the old `parseDecisionLines` in place for now — Task 5 will retire it once bootstrap stops calling it.

**Files:**
- Modify: `src/clients/joplin.ts`
- Modify: `tests/clients.test.ts`

- [ ] **Step 1: Write failing tests for v1 (old) format parsing**

Add to `tests/clients.test.ts` (place near the existing `parseDecisionLines` describe block):

```typescript
import { JoplinClient } from "../src/clients/joplin.js"

describe("parseEntries — v1 (legacy) format", () => {
  const v1Body = `## 2026-06-06 14:32 \u2014 Fix /compact

**Project**: jll-schema-proxy  +jll-schema-proxy
**Context**: Bedrock rejected /compact payloads
**Decision**: Inject stub tools at proxy
**Rationale**: Preserves history; Falcon not owned
**Rejected**:
  - strip blocks — loses context

**Recorded by**: agent (session ses_x)

---

## 2026-06-01 09:10 \u2014 Old entry

**Project**: general
**What happened**: Something happened
**Significance**: Notable
**Files touched**:
  - (none)
**Loose ends**:
  - (none)

**Recorded by**: agent (session ses_y)

---`

  it("extracts entries from v1 body with default sig=5", () => {
    const entries = JoplinClient.parseEntries(v1Body, { withinDays: 30, now: new Date("2026-06-07") })
    expect(entries).toHaveLength(2)
    expect(entries[0].date).toBe("2026-06-06")
    expect(entries[0].time).toBe("14:32")
    expect(entries[0].title).toBe("Fix /compact")
    expect(entries[0].projectTag).toBe("jll-schema-proxy")
    expect(entries[0].sig).toBe(5)
    expect(entries[0].kind).toBe("d") // has Decision field
  })

  it("filters by withinDays", () => {
    const entries = JoplinClient.parseEntries(v1Body, { withinDays: 3, now: new Date("2026-06-07") })
    expect(entries).toHaveLength(1)
    expect(entries[0].date).toBe("2026-06-06")
  })

  it("returns empty array on empty body", () => {
    const entries = JoplinClient.parseEntries("", { withinDays: 7, now: new Date() })
    expect(entries).toEqual([])
  })
})
```

- [ ] **Step 2: Write failing tests for v2 (new) format parsing**

Add to the same file:

```typescript
describe("parseEntries — v2 (compact) format", () => {
  const v2Body = `## 2026-06-06 14:32 \u2014 Inject stub tools at schema-proxy
proj: jll-schema-proxy \u00b7 sig: 9
why: Bedrock rejects /compact when tools missing but tool blocks present
chose: Reconstruct tools at proxy; tool_choice:none; preserves message history
vs: strip blocks (loses context); fix Falcon Java (not owned)

## 2026-06-06 13:18 \u2014 Joplin dedup script merged 85 notes
proj: opencode-personal-agent \u00b7 sig: 8
why: Duplicate-notes bug created 11 title groups in Personal Agent
did: Wrote dedup script; oldest-wins; PUT merged bodies; DELETE survivors
files: scripts/dedup-notes.ts
`

  it("extracts entries with explicit sig from v2 body", () => {
    const entries = JoplinClient.parseEntries(v2Body, { withinDays: 30, now: new Date("2026-06-07") })
    expect(entries).toHaveLength(2)
    expect(entries[0].sig).toBe(9)
    expect(entries[0].kind).toBe("d") // has `chose:` field
    expect(entries[0].projectTag).toBe("jll-schema-proxy")
    expect(entries[0].summary).toContain("Reconstruct tools")
    expect(entries[1].sig).toBe(8)
    expect(entries[1].kind).toBe("m") // has `did:` field, no `chose:`
  })

  it("clamps out-of-range sig", () => {
    const body = `## 2026-06-06 10:00 \u2014 t1\nproj: x \u00b7 sig: 99\nwhy: y\ndid: z\n`
    const entries = JoplinClient.parseEntries(body, { withinDays: 30, now: new Date("2026-06-07") })
    expect(entries[0].sig).toBe(10)
  })
})
```

- [ ] **Step 3: Run tests — expect failure**

Run: `npm test -- tests/clients.test.ts`
Expected: FAIL — `parseEntries is not a function`.

- [ ] **Step 4: Implement `parseEntries` on `JoplinClient`**

Add to `src/clients/joplin.ts` after the existing `parseDecisionLines` method (line 190):

```typescript
  static parseEntries(
    body: string,
    opts: { withinDays: number; now: Date },
  ): import("../types.js").BootstrapEntry[] {
    if (!body) return []
    const cutoff = new Date(opts.now.getTime() - opts.withinDays * 24 * 60 * 60 * 1000)
    const out: import("../types.js").BootstrapEntry[] = []

    // Split on `## YYYY-MM-DD HH:MM — title` headers. Use a positive lookahead so
    // the header line stays at the start of each chunk.
    const HEADER_RE = /(?=^##\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\u2014)/m
    const sections = body.split(HEADER_RE).map(s => s.trim()).filter(Boolean)

    for (const section of sections) {
      const headerMatch = section.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+\u2014\s+(.+)$/m)
      if (!headerMatch) continue
      const [, date, time, title] = headerMatch
      const entryDate = new Date(date)
      if (isNaN(entryDate.getTime()) || entryDate < cutoff) continue

      // Try v2 first: `proj: <tag> · sig: <n>`
      const v2Meta = section.match(/^proj:\s+(\S+)\s+\u00b7\s+sig:\s+(\d+)/m)
      let projectTag = "general"
      let sig = 5
      let isV2 = false

      if (v2Meta) {
        isV2 = true
        projectTag = v2Meta[1]
        sig = Math.max(1, Math.min(10, parseInt(v2Meta[2], 10) || 5))
      } else {
        // v1: `**Project**: <tag>` (drop the trailing `+tag` if present)
        const v1Proj = section.match(/^\*\*Project\*\*:\s+([^\s+]+)/m)
        if (v1Proj) projectTag = v1Proj[1]
      }

      // Kind: decision if `chose:` (v2) or `**Decision**:` (v1) present
      const kind: "m" | "d" =
        /^(chose:|\*\*Decision\*\*:)/m.test(section) ? "d" : "m"

      // Summary: first content line after metadata
      let summary = title.trim()
      if (isV2) {
        const sumMatch = section.match(/^(?:chose|did|why):\s+(.+)$/m)
        if (sumMatch) summary = sumMatch[1].trim().slice(0, 100)
      } else {
        const sumMatch = section.match(/^\*\*(?:Decision|What happened)\*\*:\s+(.+)$/m)
        if (sumMatch) summary = sumMatch[1].trim().slice(0, 100)
      }

      out.push({
        date,
        time,
        kind,
        projectTag: projectTag.trim(),
        sig,
        title: title.trim(),
        summary,
      })
    }

    return out
  }
```

- [ ] **Step 5: Run tests — expect pass**

Run: `npm test -- tests/clients.test.ts`
Expected: all `parseEntries` tests PASS. Full `npm test` should still report 150 + new tests.

- [ ] **Step 6: Commit**

```bash
git add src/clients/joplin.ts tests/clients.test.ts
git commit -m "feat(joplin): add parseEntries — dual-format BootstrapEntry parser

Accepts v1 (verbose, **Field**:) and v2 (compact, field:) bodies, returns
structured BootstrapEntry[]. v1 entries default sig=5. v2 entries read
explicit sig (clamped 1-10). Filters by withinDays.

Old parseDecisionLines retained — Task 5 removes it."
```

---

## Task 3: Reflection prompt emits `significance`

Update the LLM system prompt to require `significance: 1-10` on all three structures. Use TDD on `parseReflectionJson` to verify the boundary clamp covers LLM noise (out-of-range, missing, non-numeric).

**Files:**
- Modify: `src/reflect.ts`
- Modify: `tests/reflect.test.ts`

- [ ] **Step 1: Write failing test — LLM emits significance, parser preserves it**

Add to `tests/reflect.test.ts` (inside the existing `parseReflectionJson` describe block):

```typescript
it("preserves significance: number on decisions", () => {
  const raw = JSON.stringify({
    decisions: [{
      title: "t", context: "c", decision: "d", rationale: "r",
      rejected: ["a"], project_tag: null, confidence: 0.9,
      significance: 8,
    }],
    memories: [], agent_learnings: [],
  })
  const out = parseReflectionJson(raw)
  expect(out.decisions[0].significance).toBe(8)
})

it("clamps out-of-range significance to [1,10]", () => {
  const raw = JSON.stringify({
    decisions: [{
      title: "t", context: "c", decision: "d", rationale: "r",
      rejected: ["a"], project_tag: null, confidence: 0.9,
      significance: 99,
    }],
    memories: [], agent_learnings: [],
  })
  const out = parseReflectionJson(raw)
  expect(out.decisions[0].significance).toBe(10)
})

it("defaults significance to 5 when missing", () => {
  const raw = JSON.stringify({
    decisions: [{
      title: "t", context: "c", decision: "d", rationale: "r",
      rejected: ["a"], project_tag: null, confidence: 0.9,
    }],
    memories: [], agent_learnings: [],
  })
  const out = parseReflectionJson(raw)
  expect(out.decisions[0].significance).toBe(5)
})
```

- [ ] **Step 2: Run — expect pass (clamp already exists from Task 1)**

Run: `npm test -- tests/reflect.test.ts`
Expected: all three new tests PASS. (Clamping was added in Task 1 Step 5.)

- [ ] **Step 3: Update the LLM system prompt**

Edit `src/reflect.ts` lines 15-28 — replace `REFLECTION_SYSTEM_PROMPT` with:

```typescript
const REFLECTION_SYSTEM_PROMPT = `You are the reflection module of a personal AI agent. You read a session transcript and emit JSON describing what should be remembered.

Output schema (strict JSON, no prose):
{
  "decisions": [{"title":"<short>","context":"<what was being worked on>","decision":"<chosen path>","rationale":"<why this over alternatives>","rejected":["<alt with one-line why>"],"project_tag":"<tag or null>","confidence":0.0,"significance":5}],
  "memories": [{"title":"<short>","what_happened":"<single paragraph>","significance_text":"<one line qualitative>","files_touched":["<path>"],"loose_ends":["<line>"],"project_tag":"<tag or null>","confidence":0.0,"significance":5}],
  "agent_learnings": [{"type":"behavior_correction","observed":"<what happened>","evidence_message_indices":[0],"proposed_action":"AGENTS.md edit","confidence":0.0,"significance":5}]
}

Rules:
- A decision requires a rejected alternative. Otherwise it is a memory.
- agent_learnings only when user CORRECTED the agent or expressed a preference. Not routine work.
- confidence >= 0.6 means worth writing. Plugin drops items below 0.6.
- significance is an integer 1-10. 1 = trivial, 10 = pivotal. Default 5 if unsure.
   Reserve 8+ for entries that will still matter weeks later (architectural decisions,
   recurring patterns, hard-won bug root causes). Reserve <=3 for routine work.
- Output only NEW items from this session. If nothing notable happened, return empty arrays.`
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/reflect.ts tests/reflect.test.ts
git commit -m "feat(reflect): LLM prompt requires significance 1-10

Prompt now declares the field on all three structures with an explicit
calibration anchor (1 trivial, 10 pivotal, default 5). Renamed
significance string field to significance_text to free the field for
the numeric value. parseReflectionJson clamps; tests cover preserve,
clamp, default."
```

---

## Task 4: Compact renderers + delete project-mirror writes

Switch `renderDecision`, `renderMemory`, `renderLearning` to the compact v2 format. Delete `renderProjectNoteEntry`, `projectNoteName`, and the project-mirror append loops in `reflect()`. The dual-format parser (Task 2) keeps bootstrap working against any v1 data still on disk.

**Files:**
- Modify: `src/reflect.ts`
- Modify: `tests/reflect.test.ts`

- [ ] **Step 1: Write failing tests for compact `renderDecision`**

Add to `tests/reflect.test.ts`:

```typescript
describe("renderDecision — v2 compact", () => {
  const now = new Date("2026-06-06T14:32:00Z")

  it("renders compact decision with proj/sig/why/chose/vs", () => {
    const d = {
      title: "Inject stub tools at proxy",
      context: "Bedrock rejects /compact",
      decision: "Reconstruct tools; tool_choice:none",
      rationale: "Preserves history",
      rejected: ["strip blocks — loses context", "fix Falcon — not owned"],
      project_tag: "jll-schema-proxy",
      confidence: 0.95,
      significance: 9,
    }
    const out = renderDecision(d, now, "ses_x")
    expect(out).toBe(
      "## 2026-06-06 14:32 \u2014 Inject stub tools at proxy\n" +
      "proj: jll-schema-proxy \u00b7 sig: 9\n" +
      "why: Bedrock rejects /compact\n" +
      "chose: Reconstruct tools; tool_choice:none\n" +
      "vs: strip blocks \u2014 loses context; fix Falcon \u2014 not owned"
    )
  })

  it("uses 'general' for null project_tag", () => {
    const d = {
      title: "t", context: "c", decision: "d", rationale: "r",
      rejected: ["a"], project_tag: null, confidence: 0.9, significance: 5,
    }
    const out = renderDecision(d, now, "ses_x")
    expect(out).toContain("proj: general")
  })

  it("omits vs: line when rejected is empty", () => {
    const d = {
      title: "t", context: "c", decision: "d", rationale: "r",
      rejected: [], project_tag: "p", confidence: 0.9, significance: 5,
    }
    const out = renderDecision(d, now, "ses_x")
    expect(out).not.toContain("vs:")
  })
})
```

- [ ] **Step 2: Write failing tests for compact `renderMemory`**

Add:

```typescript
describe("renderMemory — v2 compact", () => {
  const now = new Date("2026-06-06T14:32:00Z")

  it("renders compact memory with proj/sig/why/did/files/loose", () => {
    const m = {
      title: "Dedup script merged 85 notes",
      what_happened: "Duplicate-notes bug created 11 title groups",
      significance_text: "Cleaned Personal Agent notebook",
      files_touched: ["scripts/dedup-notes.ts"],
      loose_ends: ["monitor for re-emergence"],
      project_tag: "opencode-personal-agent",
      confidence: 0.9,
      significance: 8,
    }
    const out = renderMemory(m, now, "ses_x")
    expect(out).toBe(
      "## 2026-06-06 14:32 \u2014 Dedup script merged 85 notes\n" +
      "proj: opencode-personal-agent \u00b7 sig: 8\n" +
      "why: Duplicate-notes bug created 11 title groups\n" +
      "did: Cleaned Personal Agent notebook\n" +
      "files: scripts/dedup-notes.ts\n" +
      "loose: monitor for re-emergence"
    )
  })

  it("omits files: and loose: lines when empty", () => {
    const m = {
      title: "t", what_happened: "w", significance_text: "s",
      files_touched: [], loose_ends: [],
      project_tag: "p", confidence: 0.9, significance: 5,
    }
    const out = renderMemory(m, now, "ses_x")
    expect(out).not.toContain("files:")
    expect(out).not.toContain("loose:")
  })

  it("joins multiple files with comma-space", () => {
    const m = {
      title: "t", what_happened: "w", significance_text: "s",
      files_touched: ["a.ts", "b.ts"], loose_ends: [],
      project_tag: "p", confidence: 0.9, significance: 5,
    }
    const out = renderMemory(m, now, "ses_x")
    expect(out).toContain("files: a.ts, b.ts")
  })
})
```

- [ ] **Step 3: Write failing tests for compact `renderLearning`**

Add:

```typescript
describe("renderLearning — v2 compact", () => {
  const now = new Date("2026-06-06T14:32:00Z")

  it("renders compact learning with type/sig/seen/observed/action", () => {
    const l = {
      type: "preference_expressed" as const,
      observed: "User prefers Joplin /search not /notes",
      evidence_message_indices: [3, 7],
      proposed_action: "AGENTS.md edit" as const,
      confidence: 0.9,
      significance: 8,
    }
    const out = renderLearning(l, now, 3, "ses_x")
    expect(out).toBe(
      "## 2026-06-06 14:32 \u2014 User prefers Joplin /search not /notes\n" +
      "type: preference_expressed \u00b7 sig: 8 \u00b7 seen: 3\n" +
      "observed: User prefers Joplin /search not /notes\n" +
      "action: AGENTS.md edit (pending_more_evidence)"
    )
  })

  it("shows proposed_agents_edit status when seen >= 2", () => {
    const l = {
      type: "behavior_correction" as const,
      observed: "x",
      evidence_message_indices: [],
      proposed_action: "AGENTS.md edit" as const,
      confidence: 0.9,
      significance: 5,
    }
    const out = renderLearning(l, now, 2, "ses_x")
    expect(out).toContain("action: AGENTS.md edit (proposed_agents_edit)")
  })
})
```

- [ ] **Step 4: Run tests — expect failure**

Run: `npm test -- tests/reflect.test.ts`
Expected: FAIL — the v1 renderers still produce verbose output.

- [ ] **Step 5: Replace `renderDecision`**

In `src/reflect.ts`, replace lines 51-56 with:

```typescript
export function renderDecision(d: ReflectionDecision, now: Date, _sessionId = "unknown"): string {
  const ts = now.toISOString().slice(0, 16).replace("T", " ")
  const proj = d.project_tag ?? "general"
  const lines = [
    `## ${ts} \u2014 ${d.title}`,
    `proj: ${proj} \u00b7 sig: ${d.significance}`,
    `why: ${d.context}`,
    `chose: ${d.decision}`,
  ]
  if (d.rejected.length > 0) {
    lines.push(`vs: ${d.rejected.join("; ")}`)
  }
  return lines.join("\n")
}
```

- [ ] **Step 6: Replace `renderMemory`**

Replace lines 58-64 with:

```typescript
export function renderMemory(m: ReflectionMemory, now: Date, _sessionId = "unknown"): string {
  const ts = now.toISOString().slice(0, 16).replace("T", " ")
  const proj = m.project_tag ?? "general"
  const lines = [
    `## ${ts} \u2014 ${m.title}`,
    `proj: ${proj} \u00b7 sig: ${m.significance}`,
    `why: ${m.what_happened}`,
    `did: ${m.significance_text}`,
  ]
  if (m.files_touched.length > 0) {
    lines.push(`files: ${m.files_touched.join(", ")}`)
  }
  if (m.loose_ends.length > 0) {
    lines.push(`loose: ${m.loose_ends.join(", ")}`)
  }
  return lines.join("\n")
}
```

- [ ] **Step 7: Replace `renderLearning`**

Replace lines 66-75 with:

```typescript
export function renderLearning(
  l: ReflectionLearning,
  now: Date,
  crossSessionCount: number,
  _sessionId: string,
): string {
  const ts = now.toISOString().slice(0, 16).replace("T", " ")
  const status = crossSessionCount >= 2 ? "proposed_agents_edit" : "pending_more_evidence"
  return [
    `## ${ts} \u2014 ${l.observed.slice(0, 60)}`,
    `type: ${l.type} \u00b7 sig: ${l.significance} \u00b7 seen: ${crossSessionCount}`,
    `observed: ${l.observed}`,
    `action: ${l.proposed_action} (${status})`,
  ].join("\n")
}
```

- [ ] **Step 8: Delete `renderProjectNoteEntry` and `projectNoteName`**

Remove lines 77-90 entirely (the two exported functions). Also remove unused imports if any test fixtures referenced them — check with:

Run: `grep -rn "renderProjectNoteEntry\|projectNoteName" src tests`
Expected after edit: only references in `src/reflect.ts` should be gone; any test reference must be deleted too.

- [ ] **Step 9: Delete project-mirror append loops in `reflect()`**

In `src/reflect.ts`, find lines 161-164 and 169-172 (the two inner `if (d.project_tag)` / `if (m.project_tag)` blocks that call `joplin.appendToNote(projectNoteName(...))`).

Replace lines 159-173 with:

```typescript
  for (const d of result.decisions) {
    await joplin.appendToNote(decisionsNoteName(now), renderDecision(d, now, state.sessionId), JOPLIN_NOTEBOOK)
  }

  for (const m of result.memories) {
    await joplin.appendToNote(memoriesNoteName(now), renderMemory(m, now, state.sessionId), JOPLIN_NOTEBOOK)
  }
```

This removes the only two callers of `renderProjectNoteEntry` and `projectNoteName`.

- [ ] **Step 10: Remove any v1 `renderProjectNoteEntry` test**

Run: `grep -n "renderProjectNoteEntry\|projectNoteName" tests/`
Expected: zero matches. Delete any leftover test block that referenced them.

- [ ] **Step 11: Run all tests**

Run: `npm test`
Expected: all pass. New compact-render tests green; v1 render tests deleted or updated to v2.

- [ ] **Step 12: Commit**

```bash
git add src/reflect.ts tests/reflect.test.ts
git commit -m "feat(reflect): compact v2 renderers; remove Project Notes mirror writes

- renderDecision -> proj/sig/why/chose/vs (~50% smaller)
- renderMemory   -> proj/sig/why/did/files/loose (~40% smaller)
- renderLearning -> type/sig/seen/observed/action (~40% smaller)
- Empty arrays omit the field line (no '(none)' bullets)
- Deleted renderProjectNoteEntry + projectNoteName + the two
  Project Notes mirror append loops in reflect()

Existing Project Notes notes in Joplin still readable; migration in
Task 6 reconciles their data into parent Memories/Decisions and
deletes the mirror notes."
```

---

## Task 5: Two-tier bootstrap projection

Switch `composeBootstrapMessage` to the two-tier shape (12 active + 7 cross-project, sig≥6). Rewrite `gatherBootstrapData` to use the new `parseEntries` and produce `BootstrapEntry[]`. Delete the now-orphaned `parseDecisionLines` and the deprecated v1 fields on `BootstrapData`.

**Files:**
- Modify: `src/bootstrap.ts`
- Modify: `src/plugin.ts`
- Modify: `src/types.ts`
- Modify: `src/clients/joplin.ts`
- Modify: `tests/bootstrap.test.ts`

- [ ] **Step 1: Write failing test for two-tier projection**

Add to `tests/bootstrap.test.ts`:

```typescript
import { composeBootstrapMessage, BOOTSTRAP_ACTIVE_CAP, BOOTSTRAP_OTHER_CAP } from "../src/bootstrap.js"
import type { BootstrapEntry, BootstrapData } from "../src/types.js"

const mkEntry = (over: Partial<BootstrapEntry>): BootstrapEntry => ({
  date: "2026-06-06", time: "10:00", kind: "m",
  projectTag: "general", sig: 5,
  title: "t", summary: "s", ...over,
})

describe("composeBootstrapMessage — two-tier", () => {
  it("renders active and other sections with caps", () => {
    const active = Array.from({ length: 5 }, (_, i) => mkEntry({
      title: `active${i}`, sig: 9 - i, projectTag: "opencode-personal-agent",
    }))
    const other = Array.from({ length: 3 }, (_, i) => mkEntry({
      title: `other${i}`, sig: 7, projectTag: `proj${i}`,
    }))
    const data: BootstrapData = {
      projectName: "opencode-personal-agent",
      recentActive: active,
      recentOther: other,
      activitySummary: null,
      agentLearnings: null,
    }
    const out = composeBootstrapMessage(data)
    expect(out).toContain("### Active repo (last 7d, ranked by sig)")
    expect(out).toContain("### Other recent work (last 3d, top 7 by sig \u22656)")
    expect(out).toContain("active0")
    expect(out).toContain("other0")
    expect(out).toContain("_End memory bootstrap. Continue normally._")
  })

  it("caps are exported as 12 and 7", () => {
    expect(BOOTSTRAP_ACTIVE_CAP).toBe(12)
    expect(BOOTSTRAP_OTHER_CAP).toBe(7)
  })

  it("omits Other section when recentOther is empty", () => {
    const data: BootstrapData = {
      projectName: "x", recentActive: [], recentOther: [],
      activitySummary: null, agentLearnings: null,
    }
    const out = composeBootstrapMessage(data)
    expect(out).not.toContain("### Other recent work")
  })
})
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- tests/bootstrap.test.ts`
Expected: FAIL — `BOOTSTRAP_ACTIVE_CAP` and the two-tier sections don't exist yet.

- [ ] **Step 3: Rewrite `composeBootstrapMessage` and add caps**

Replace `src/bootstrap.ts` lines 47-76 with:

```typescript
export const BOOTSTRAP_ACTIVE_CAP = 12
export const BOOTSTRAP_OTHER_CAP = 7
export const BOOTSTRAP_OTHER_SIG_THRESHOLD = 6

function renderActiveLine(e: import("./types.js").BootstrapEntry): string {
  // - MM-DD HH:MM [<k> sig:N] Title — summary
  const md = e.date.slice(5)  // MM-DD
  return `- ${md} ${e.time} [${e.kind} sig:${e.sig}] ${e.title} \u2014 ${e.summary}`
}

function renderOtherLine(e: import("./types.js").BootstrapEntry): string {
  // - MM-DD HH:MM [<project>] Title
  const md = e.date.slice(5)
  return `- ${md} ${e.time} [${e.projectTag}] ${e.title}`
}

export function composeBootstrapMessage(data: BootstrapData): string {
  const lines: string[] = ["## Memory bootstrap", ""]
  lines.push(`proj: ${data.projectName}`)
  if (data.activitySummary) {
    lines.push(`today: ${data.activitySummary}`)
  }
  lines.push("")

  if (data.recentActive.length > 0) {
    lines.push("### Active repo (last 7d, ranked by sig)")
    for (const e of data.recentActive) lines.push(renderActiveLine(e))
    lines.push("")
  }

  if (data.recentOther.length > 0) {
    lines.push(`### Other recent work (last 3d, top ${BOOTSTRAP_OTHER_CAP} by sig \u2265${BOOTSTRAP_OTHER_SIG_THRESHOLD})`)
    for (const e of data.recentOther) lines.push(renderOtherLine(e))
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

- [ ] **Step 4: Remove deprecated v1 fields from `BootstrapData`**

Edit `src/types.ts` — remove the three `?` fields (recentDecisions, recentMemories, projectNotes) from `BootstrapData`. Final shape:

```typescript
export interface BootstrapData {
  projectName: string
  recentActive: BootstrapEntry[]
  recentOther: BootstrapEntry[]
  activitySummary: string | null
  agentLearnings: string | null
}
```

- [ ] **Step 5: Rewrite `gatherBootstrapData`**

Edit `src/plugin.ts`. Replace the function body (lines 305-337) with:

```typescript
async function gatherBootstrapData(
  joplin: JoplinClient,
  memory: MemoryClient,
  cwd: string,
): Promise<BootstrapData> {
  const now = new Date()
  const prev = prevMonth(now)
  const projectName = detectProject(cwd, PROJECT_MAP)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp"
  const [
    decisionsNote, prevDecisionsNote,
    memoriesNote, prevMemoriesNote,
    activities, agentLearnings,
  ] = await Promise.all([
    joplin.getNote(decisionsNoteName(now)),
    joplin.getNote(decisionsNoteName(prev)),
    joplin.getNote(memoriesNoteName(now)),
    joplin.getNote(memoriesNoteName(prev)),
    memory.getTodayActivities(),
    readAgentLearnings(home),
  ])
  const decisionsBody = mergeNoteBodies(decisionsNote?.body ?? null, prevDecisionsNote?.body ?? null)
  const memoriesBody  = mergeNoteBodies(memoriesNote?.body ?? null,  prevMemoriesNote?.body ?? null)

  const decisionsEntries = JoplinClient.parseEntries(decisionsBody, { withinDays: 7, now })
  const memoriesEntries  = JoplinClient.parseEntries(memoriesBody,  { withinDays: 7, now })
  const all = [...decisionsEntries, ...memoriesEntries]

  // Active: entries whose projectTag matches the active project, last 7d (already filtered)
  const active = all
    .filter(e => e.projectTag === projectName)
    .sort((a, b) => b.sig - a.sig || `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))
    .slice(0, BOOTSTRAP_ACTIVE_CAP)

  // Other: not the active project, last 3d, sig >= threshold
  const threeDayCutoff = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)
  const other = all
    .filter(e => e.projectTag !== projectName
              && new Date(e.date) >= threeDayCutoff
              && e.sig >= BOOTSTRAP_OTHER_SIG_THRESHOLD)
    .sort((a, b) => b.sig - a.sig || `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))
    .slice(0, BOOTSTRAP_OTHER_CAP)

  return {
    projectName,
    recentActive: active,
    recentOther: other,
    activitySummary: activities ? MemoryClient.summarizeActivities(activities) : null,
    agentLearnings,
  }
}
```

Update the import line at the top of `src/plugin.ts` (line 2):

```typescript
import {
  detectProject, decisionsNoteName, memoriesNoteName, composeBootstrapMessage,
  readAgentLearnings, prevMonth, mergeNoteBodies,
  BOOTSTRAP_ACTIVE_CAP, BOOTSTRAP_OTHER_CAP, BOOTSTRAP_OTHER_SIG_THRESHOLD,
} from "./bootstrap.js"
```

The `tag:${projectName}` `searchNotes` call is gone — project filtering happens client-side on already-parsed entries.

- [ ] **Step 6: Delete `parseDecisionLines`**

Edit `src/clients/joplin.ts` — remove lines 177-190 (the entire `static parseDecisionLines` method). Run:

Run: `grep -rn "parseDecisionLines" src tests`
Expected: zero matches.

- [ ] **Step 7: Update old `parseDecisionLines` tests**

Run: `grep -n "parseDecisionLines" tests/clients.test.ts`
For every matching `describe` / `it` block, delete it. The dual-format coverage from Task 2's `parseEntries` tests replaces it.

- [ ] **Step 8: Run all tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/bootstrap.ts src/plugin.ts src/clients/joplin.ts tests/bootstrap.test.ts tests/clients.test.ts
git commit -m "feat(bootstrap): two-tier projection (12 active + 7 cross, sig>=6)

- composeBootstrapMessage emits 'Active repo' + 'Other recent work'
- gatherBootstrapData parses notes via parseEntries, splits by project
- BOOTSTRAP_ACTIVE_CAP=12, BOOTSTRAP_OTHER_CAP=7,
  BOOTSTRAP_OTHER_SIG_THRESHOLD=6 exported for future tuning
- Removed legacy parseDecisionLines and deprecated v1 BootstrapData fields
- Removed the searchNotes('tag:project') call — project filtering now
  client-side on parsed entries (same source of truth as ranking)

Expected token impact: ~2.5 KB -> ~1.6 KB on typical day."
```

---

## Task 6: Migration script — convert v1 → v2 + delete Project Notes mirror

Add `scripts/migrate-note-format.ts` mirroring the structure of the existing `scripts/dedup-notes.ts`. Backup first, dry-run by default, idempotent.

**Files:**
- Create: `scripts/migrate-note-format.ts`
- Create: `scripts/.backups/` (directory)

- [ ] **Step 1: Read the dedup script to match style**

Run: `cat scripts/dedup-notes.ts | head -60`
Expected: confirms `JoplinClient` usage, `--execute` flag pattern, env-var notebook resolution.

- [ ] **Step 2: Create the backup directory**

```bash
mkdir -p scripts/.backups
echo "*.json" > scripts/.backups/.gitignore
git add scripts/.backups/.gitignore
```

- [ ] **Step 3: Write `scripts/migrate-note-format.ts` — pre-flight backup**

Create `scripts/migrate-note-format.ts` with the following full content:

```typescript
#!/usr/bin/env bun
/**
 * One-shot migration: v1 verbose Joplin schema → v2 compact schema.
 *
 * - Backup: dumps every note in the Personal Agent notebook to
 *   scripts/.backups/notes-pre-migration-<ts>.json before mutating.
 * - Dry-run by default. Pass --execute to apply.
 * - Idempotent: re-running after success is a no-op.
 *
 * Converts every entry in Memories/Decisions/Agent Learnings notes from v1
 * to v2. For each "Project Notes — <tag>" mirror note, reconciles entries
 * into the corresponding parent Memories/Decisions entry (sets proj: field)
 * and then DELETEs the mirror note.
 */
import * as fs from "node:fs/promises"
import * as nodePath from "node:path"
import { JoplinClient } from "../src/clients/joplin.js"
import type { JoplinNote } from "../src/types.js"

const JOPLIN_BASE     = process.env.OPENCODE_PA_JOPLIN_URL   ?? "http://127.0.0.1:41184"
const JOPLIN_TOKEN    = process.env.OPENCODE_PA_JOPLIN_TOKEN ?? ""
const NOTEBOOK        = process.env.OPENCODE_PA_JOPLIN_NOTEBOOK ?? "Personal Agent"
const EXECUTE         = process.argv.includes("--execute")
const BACKUP_DIR      = nodePath.join(process.cwd(), "scripts", ".backups")

function log(msg: string) { console.log(`[migrate] ${msg}`) }

async function fetchAllNotesInNotebook(joplin: JoplinClient): Promise<JoplinNote[]> {
  // Use FTS to find every note tagged with the notebook. Joplin's /search
  // accepts notebook:"<name>" filters.
  const out: JoplinNote[] = []
  let page = 1
  while (true) {
    const batch = await joplin.searchNotes(
      `notebook:"${NOTEBOOK}"`, 100, "id,title,body,parent_id,created_time,updated_time"
    )
    if (batch.length === 0) break
    out.push(...batch)
    if (batch.length < 100) break
    page++
    if (page > 50) break  // safety: 5000-note ceiling
  }
  // Dedupe by id (Joplin search may return paginated overlap)
  const seen = new Set<string>()
  return out.filter(n => seen.has(n.id) ? false : (seen.add(n.id), true))
}

async function writeBackup(notes: JoplinNote[]): Promise<string> {
  await fs.mkdir(BACKUP_DIR, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const file = nodePath.join(BACKUP_DIR, `notes-pre-migration-${ts}.json`)
  await fs.writeFile(file, JSON.stringify(notes, null, 2), "utf-8")
  return file
}

// ---------- v1 → v2 entry conversion ----------

interface V1Entry {
  rawHeader: string         // "## YYYY-MM-DD HH:MM — title"
  date: string
  time: string
  title: string
  fields: Record<string, string>     // **Project**, **Context**, etc.
  multiline: Record<string, string[]> // **Files touched** etc. (bulleted)
}

function parseV1Section(section: string): V1Entry | null {
  const headerMatch = section.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+\u2014\s+(.+)$/m)
  if (!headerMatch) return null
  const [rawHeader, date, time, title] = headerMatch
  const fields: Record<string, string> = {}
  const multiline: Record<string, string[]> = {}

  const fieldRe = /^\*\*([\w ]+)\*\*:\s*(.*)$/gm
  let m: RegExpExecArray | null
  while ((m = fieldRe.exec(section)) !== null) {
    const [, name, value] = m
    if (value.trim()) {
      fields[name] = value.trim()
    } else {
      // bulleted multiline — collect lines starting with "  -" until blank or next **
      const startIdx = m.index + m[0].length
      const tail = section.slice(startIdx)
      const bulletRe = /^\s+-\s+(.+)$/gm
      const items: string[] = []
      let b: RegExpExecArray | null
      while ((b = bulletRe.exec(tail)) !== null) {
        if (b.index > 0 && tail[b.index - 1] !== "\n") break
        items.push(b[1])
      }
      multiline[name] = items.filter(x => x !== "(none)" && x !== "(none recorded)")
    }
  }
  return { rawHeader, date, time, title, fields, multiline }
}

function renderV2Entry(e: V1Entry, kind: "memory" | "decision" | "learning"): string {
  const proj = e.fields["Project"]?.replace(/\s+\+\S+$/, "") ?? "general"
  const sig = 5  // pre-migration default — no LLM re-run

  if (kind === "decision") {
    const lines = [
      `## ${e.date} ${e.time} \u2014 ${e.title}`,
      `proj: ${proj} \u00b7 sig: ${sig}`,
      `why: ${e.fields["Context"] ?? ""}`,
      `chose: ${e.fields["Decision"] ?? ""}`,
    ]
    const rej = e.multiline["Rejected"]
    if (rej && rej.length > 0) lines.push(`vs: ${rej.join("; ")}`)
    return lines.join("\n")
  }

  if (kind === "memory") {
    const lines = [
      `## ${e.date} ${e.time} \u2014 ${e.title}`,
      `proj: ${proj} \u00b7 sig: ${sig}`,
      `why: ${e.fields["What happened"] ?? ""}`,
      `did: ${e.fields["Significance"] ?? ""}`,
    ]
    const files = e.multiline["Files touched"]
    if (files && files.length > 0) lines.push(`files: ${files.join(", ")}`)
    const loose = e.multiline["Loose ends"]
    if (loose && loose.length > 0) lines.push(`loose: ${loose.join(", ")}`)
    return lines.join("\n")
  }

  // learning
  const type = e.fields["Type"] ?? "behavior_correction"
  const seen = parseInt(e.fields["Cross-session count"] ?? "1", 10)
  const status = seen >= 2 ? "proposed_agents_edit" : "pending_more_evidence"
  return [
    `## ${e.date} ${e.time} \u2014 ${e.title}`,
    `type: ${type} \u00b7 sig: ${sig} \u00b7 seen: ${seen}`,
    `observed: ${e.fields["Observed"] ?? ""}`,
    `action: ${e.fields["Proposed action"] ?? "behavior only"} (${status})`,
  ].join("\n")
}

function classifyNote(title: string): "decision" | "memory" | "learning" | "project_mirror" | "skip" {
  if (title.startsWith("Decisions \u2014")) return "decision"
  if (title.startsWith("Memories \u2014")) return "memory"
  if (title.startsWith("Agent Learnings \u2014")) return "learning"
  if (title.startsWith("Project Notes \u2014")) return "project_mirror"
  return "skip"
}

function convertBody(body: string, kind: "decision" | "memory" | "learning"): { converted: string; changed: number; skipped: number } {
  // Already-v2 entries have `proj: ... · sig:` on the line after the header.
  // We split on the header lookahead, decide per-section.
  const HEADER_LA = /(?=^##\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\u2014)/m
  const sections = body.split(HEADER_LA).map(s => s.trim()).filter(Boolean)
  const out: string[] = []
  let changed = 0
  let skipped = 0
  for (const section of sections) {
    const alreadyV2 = /^proj:\s+\S+\s+\u00b7\s+sig:/m.test(section) ||
                      /^type:\s+\S+\s+\u00b7\s+sig:/m.test(section)
    if (alreadyV2) {
      // Strip any trailing `---` separator that v1 left behind
      out.push(section.replace(/\n*---\s*$/, ""))
      skipped++
      continue
    }
    const parsed = parseV1Section(section)
    if (!parsed) {
      out.push(section)
      continue
    }
    out.push(renderV2Entry(parsed, kind))
    changed++
  }
  return { converted: out.join("\n\n"), changed, skipped }
}

// ---------- main ----------

async function main() {
  if (!JOPLIN_TOKEN) {
    console.error("OPENCODE_PA_JOPLIN_TOKEN not set")
    process.exit(2)
  }
  const joplin = new JoplinClient(`${JOPLIN_BASE}`, JOPLIN_TOKEN)

  log(`mode: ${EXECUTE ? "EXECUTE" : "DRY-RUN"} (pass --execute to apply)`)
  log(`notebook: ${NOTEBOOK}`)

  log("fetching all notes…")
  const notes = await fetchAllNotesInNotebook(joplin)
  log(`found ${notes.length} notes`)

  if (EXECUTE) {
    const backupFile = await writeBackup(notes)
    log(`backup written: ${backupFile}`)
  } else {
    log("dry-run: skipping backup write")
  }

  let convertedEntries = 0
  let skippedEntries = 0
  let convertedNotes = 0
  let mirrorsDeleted = 0

  for (const note of notes) {
    const kind = classifyNote(note.title)
    if (kind === "skip") continue
    if (kind === "project_mirror") {
      log(`[mirror] ${note.title} — DELETE planned (${note.body.length} bytes)`)
      if (EXECUTE) {
        const res = await fetch(`${JOPLIN_BASE}/notes/${note.id}?token=${JOPLIN_TOKEN}`, {
          method: "DELETE",
        })
        if (res.ok) mirrorsDeleted++
        else log(`[mirror] DELETE failed for ${note.title}: HTTP ${res.status}`)
      } else {
        mirrorsDeleted++
      }
      continue
    }
    const { converted, changed, skipped } = convertBody(note.body, kind)
    skippedEntries += skipped
    if (changed === 0) {
      log(`[${kind}] ${note.title}: no v1 entries (skipped ${skipped} v2)`)
      continue
    }
    convertedEntries += changed
    convertedNotes++
    log(`[${kind}] ${note.title}: converted ${changed} entries (${skipped} already v2)`)
    if (EXECUTE) {
      const ok = await joplin.updateNote(note.id, converted)
      if (!ok) log(`[${kind}] PUT failed for ${note.title}`)
    }
  }

  log("---")
  log(`notes touched: ${convertedNotes}`)
  log(`entries converted: ${convertedEntries}`)
  log(`entries already v2 (skipped): ${skippedEntries}`)
  log(`project-mirror notes deleted: ${mirrorsDeleted}`)
  log(EXECUTE ? "DONE (applied)" : "DONE (dry-run; re-run with --execute to apply)")
}

main().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-note-format.ts scripts/.backups/.gitignore
git commit -m "feat(scripts): add migrate-note-format.ts — v1 -> v2 schema migration

Backup + dry-run + idempotent. Converts every entry in
Memories/Decisions/Agent Learnings notes from v1 verbose format to
v2 compact format (pre-migration entries get sig=5). Deletes every
Project Notes — <tag> mirror note.

Dry-run by default. Pass --execute to apply. Backup JSON written to
scripts/.backups/ before any mutation."
```

---

## Task 7: Run migration on live Joplin

Dry-run, inspect, then execute. Verify post-state.

**Files:** (no source changes — operational task)

- [ ] **Step 1: Confirm env vars are exported**

Run: `echo "URL=$OPENCODE_PA_JOPLIN_URL TOKEN_LEN=${#OPENCODE_PA_JOPLIN_TOKEN} NB=$OPENCODE_PA_JOPLIN_NOTEBOOK"`
Expected: URL non-empty, TOKEN_LEN >= 32, NB = "Personal Agent".

If empty, source the env file used by the plugin:

```bash
source ~/.config/opencode/personal-agent.env
```

- [ ] **Step 2: Dry-run**

Run: `bun scripts/migrate-note-format.ts`
Expected output includes:
- `mode: DRY-RUN`
- `found N notes` (N >= 12)
- Per-note conversion counts
- Summary line with `entries converted: X` and `project-mirror notes deleted: Y`

If the entry-converted count is suspiciously zero on every note, inspect a sample with `joplin_get_note` to confirm format. Halt and debug; do NOT proceed to --execute.

- [ ] **Step 3: Spot-check the conversion preview**

Pick one Memories or Decisions note from the dry-run output. Inspect a few lines manually with:

```bash
bun -e 'import("./src/clients/joplin.js").then(async ({JoplinClient}) => {
  const j = new JoplinClient(process.env.OPENCODE_PA_JOPLIN_URL, process.env.OPENCODE_PA_JOPLIN_TOKEN)
  const n = await j.getNote("Memories \u2014 2026-06", "Personal Agent")
  console.log(n?.body?.slice(0, 800))
})'
```

Confirm the body still contains v1 markers (`**Project**:`, `**What happened**:`, `---`) — meaning v1→v2 conversion has a real target. If body is already pure v2, the dry-run summary should reflect that and `--execute` will be a no-op (idempotency check).

- [ ] **Step 4: Execute**

Run: `bun scripts/migrate-note-format.ts --execute`
Expected:
- `mode: EXECUTE`
- `backup written: scripts/.backups/notes-pre-migration-<ts>.json`
- Per-note `[memory|decision|learning] <title>: converted N entries` lines
- `[mirror] <title> — DELETE planned` lines for each Project Notes mirror
- Final summary identical to dry-run summary, minus any deletion failures.

- [ ] **Step 5: Verify post-state**

Run: `bun scripts/migrate-note-format.ts`
Expected: second dry-run reports `entries converted: 0` and `project-mirror notes deleted: 0` (idempotent — nothing left to do).

Also confirm via Joplin search:

```bash
bun -e 'import("./src/clients/joplin.js").then(async ({JoplinClient}) => {
  const j = new JoplinClient(process.env.OPENCODE_PA_JOPLIN_URL, process.env.OPENCODE_PA_JOPLIN_TOKEN)
  const m = await j.searchNotes("Project Notes", 50)
  console.log("Project Notes notes remaining:", m.length)
  console.log(m.map(n => n.title))
})'
```

Expected: 0 results.

- [ ] **Step 6: Commit migration log (optional)**

If you want to checkpoint the post-migration state, no source change is needed. Just note the backup-file path:

```bash
ls -la scripts/.backups/notes-pre-migration-*.json | tail -1
```

(No commit on this step — backup files are gitignored.)

---

## Task 8: Docs + dist sync + live verification

Update README/ARCHITECTURE for the new format. Rebuild. Sync to the OpenCode cache. Trigger a real reflect and confirm a single-note append in v2 format.

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Build: `dist/plugin.js`
- Sync: `~/.cache/opencode/packages/opencode-personal-agent@git+.../dist/plugin.js`

- [ ] **Step 1: Read current README sections that mention the schema**

Run: `grep -n -E "Project Notes|Recent decisions|Recent memories|recentDecisions|bootstrap" README.md`
Expected: lists every line needing an update.

- [ ] **Step 2: Update README.md**

Replace any sample bootstrap output in the README with the new two-tier shape:

```markdown
## Memory bootstrap

proj: opencode-personal-agent
today: VSCode 2h, Terminal 1h, Joplin 30m

### Active repo (last 7d, ranked by sig)
- 06-06 14:32 [d sig:9] Inject stub tools at schema-proxy — Reconstruct tools at proxy
- 06-06 13:18 [m sig:8] Joplin dedup script merged 85 notes — Cleaned Personal Agent notebook
...

### Other recent work (last 3d, top 7 by sig ≥6)
- 06-06 11:00 [2brn] Timezone bug fixed at daemon level
- 06-06 10:50 [jll-schema-proxy] toolConfig root-caused
...

### Agent Learnings
<contents of agent-learnings.md>

_End memory bootstrap. Continue normally._
```

Add a new subsection "**Schema (v2 compact)**" describing the on-disk format with one example each for memory, decision, learning. Use the exact strings produced by the v2 renderers from Task 4.

Delete or update any prose referring to "Project Notes — <tag>" mirror notes. State the migration was applied on 2026-06-06.

Add env-var documentation for the caps (read-only at the moment — the caps are exported constants but not yet env-driven; document them as "constants in src/bootstrap.ts: 12, 7, 6").

- [ ] **Step 3: Update ARCHITECTURE.md**

Run: `grep -n -E "renderDecision|renderMemory|parseDecisionLines|Project Notes" ARCHITECTURE.md`
For each match, update the prose to reference the new functions and remove references to deleted ones. In the data-flow section, add a paragraph on two-tier projection and the sig threshold.

- [ ] **Step 4: Rebuild plugin**

Run: `npm run build`
Expected: `dist/plugin.js` regenerated. Inspect file size:

Run: `ls -la dist/plugin.js`
Expected: file exists, similar order of magnitude to the previous build.

- [ ] **Step 5: Sync to OpenCode cache**

Run:
```bash
CACHE_DIST="$(find ~/.cache/opencode/packages -path '*opencode-personal-agent*/dist/plugin.js' -type f 2>/dev/null | head -1)"
echo "cache target: $CACHE_DIST"
cp dist/plugin.js "$CACHE_DIST"
shasum -a 256 dist/plugin.js "$CACHE_DIST"
```
Expected: both sha256 hashes match.

- [ ] **Step 6: Trigger a real reflect**

Start a fresh OpenCode session in any repo, do one short interaction that warrants a memory (e.g. "remind me — what was the schema-proxy fix?"). Let the session idle for the reflection interval (~10 minutes by default, or whatever `OPENCODE_PA_REFLECT_IDLE_MS` is set to).

While idling, tail the proxy log:

```bash
tail -f ~/tools/jll-ai-stack/schema-proxy/proxy.log | grep -i 'personal-agent\|reflect'
```

Expected: a `reflect: wrote Nd Mm Ll` log line.

- [ ] **Step 7: Inspect the resulting Joplin note**

Run:
```bash
bun -e 'import("./src/clients/joplin.js").then(async ({JoplinClient}) => {
  const j = new JoplinClient(process.env.OPENCODE_PA_JOPLIN_URL, process.env.OPENCODE_PA_JOPLIN_TOKEN)
  const now = new Date()
  const m = await j.getNote(`Memories \u2014 ${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`, "Personal Agent")
  console.log(m?.body?.split("\n## ").slice(-1)[0])
})'
```
Expected: the newest entry's body uses the v2 compact format (`proj: ... · sig: N`, `why:`, `did:` / `chose:`, no `**Field**:` syntax, no trailing `---`).

Verify zero Project Notes mirror writes:

```bash
bun -e 'import("./src/clients/joplin.js").then(async ({JoplinClient}) => {
  const j = new JoplinClient(process.env.OPENCODE_PA_JOPLIN_URL, process.env.OPENCODE_PA_JOPLIN_TOKEN)
  const m = await j.searchNotes("Project Notes", 5)
  console.log("Project Notes notes:", m.length)
})'
```
Expected: 0.

- [ ] **Step 8: Inspect the next session's bootstrap injection**

Open a fresh OpenCode session in `opencode-personal-agent`. The session's first user-visible message should contain the new two-tier bootstrap. Check size:

```bash
# In a separate terminal, capture proxy log entries for the next /chat call
tail -100 ~/tools/jll-ai-stack/schema-proxy/proxy.log | grep -A 1 'bootstrap'
```

If the bootstrap content is visible in your terminal, copy it to a file and measure:

```bash
wc -c /tmp/bootstrap.txt
```
Expected: ≤ 1600 bytes on a typical day with active entries present. Sanity-check that "### Active repo" and "### Other recent work" sections both appear if data warrants.

- [ ] **Step 9: Commit docs + dist**

```bash
git add README.md ARCHITECTURE.md dist/plugin.js
git commit -m "docs: update README+ARCHITECTURE for v2 compact schema

- Bootstrap example shows two-tier output
- On-disk entry examples for memory/decision/learning v2
- Removed references to Project Notes — <tag> mirror entity
- Documented BOOTSTRAP_ACTIVE_CAP / OTHER_CAP / OTHER_SIG_THRESHOLD
- dist/plugin.js rebuilt and synced to OpenCode cache"
```

- [ ] **Step 10: Final verification — full test suite + build**

Run: `npm test && npm run build`
Expected: all tests pass; build succeeds.

Run: `git log --oneline -10`
Expected: at least 8 new commits since the start of this plan.

---

## Self-Review (planner: completed before handoff)

**Spec coverage:**
- §4.1 Memory/Decision/Learning on-disk format → Tasks 4 (renderers) + 6 (migration converts existing)
- §4.2 sig field → Tasks 1 (type) + 3 (LLM prompt + clamp)
- §4.3 Removed body fields → Task 4 (new renderers omit them)
- §4.4 Removed Project Notes mirror → Tasks 4 (no writes) + 6 (delete on Joplin)
- §4.5 Two-tier bootstrap shape → Task 5
- §4.6 Caps (12 + 7, sig≥6) → Task 5 exports as constants
- §4.7 Migration with backup/dry-run/idempotency → Task 6 + 7 (run)
- §4.8 Per-file changes → covered task-by-task; types/parser/renderers/bootstrap/plugin/script/tests/docs
- §4.9 Risks → all mitigated (backup before mutation, clamp, dual-format parser, idempotent migration)
- §5 Acceptance criteria → verification steps in Task 8 Steps 6-10

**Placeholder scan:** No "TBD", no "TODO later", no "similar to Task N" — code shown inline in every code-changing step.

**Type consistency:** `BootstrapEntry` and `BootstrapData` shapes referenced consistently across Tasks 1, 2, 5; `significance` (number) vs `significance_text` (string) disambiguation consistent across Tasks 1, 3, 4; field-name prefixes (`proj:`, `sig:`, `why:`, `did:`, `chose:`, `vs:`, `files:`, `loose:`, `type:`, `seen:`, `observed:`, `action:`) consistent between Tasks 4 (renderers) and 6 (migration output).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-06-joplin-compact-schema-v2.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan because Task 7 is destructive (live Joplin mutation) and benefits from a review checkpoint before --execute.

**2. Inline Execution** — Execute tasks in this session using executing-plans. Batch with checkpoints. Fewer context switches but I'm carrying more state.

**Which approach?**
