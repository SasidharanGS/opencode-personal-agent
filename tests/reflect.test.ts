import { expect, test, describe } from "bun:test"
import { parseReflectionJson, renderDecision, renderMemory, renderLearning, agentLearningsNoteName } from "../src/reflect"
import type { ReflectionDecision, ReflectionMemory, ReflectionLearning } from "../src/types"

describe("parseReflectionJson", () => {
  test("parses valid JSON string", () => {
    const raw = JSON.stringify({
      decisions: [{ title: "Use SQLite", context: "db choice", decision: "SQLite", rationale: "simple", rejected: ["Postgres — too heavy"], project_tag: null, confidence: 0.8 }],
      memories: [],
      agent_learnings: [],
    })
    const result = parseReflectionJson(raw)
    expect(result.decisions).toHaveLength(1)
    expect(result.decisions[0].title).toBe("Use SQLite")
  })

  test("extracts JSON wrapped in prose (regex fallback)", () => {
    const raw = `Here is the result:\n${JSON.stringify({ decisions: [], memories: [], agent_learnings: [] })}\nDone.`
    const result = parseReflectionJson(raw)
    expect(result.decisions).toHaveLength(0)
  })

  test("filters decisions below confidence 0.6", () => {
    const raw = JSON.stringify({
      decisions: [
        { title: "High", context: "", decision: "", rationale: "", rejected: [], project_tag: null, confidence: 0.9 },
        { title: "Low", context: "", decision: "", rationale: "", rejected: [], project_tag: null, confidence: 0.4 },
      ],
      memories: [],
      agent_learnings: [],
    })
    const result = parseReflectionJson(raw)
    expect(result.decisions).toHaveLength(1)
    expect(result.decisions[0].title).toBe("High")
  })

  test("filters memories below confidence 0.6", () => {
    const raw = JSON.stringify({
      decisions: [],
      memories: [{ title: "m", what_happened: "", significance: "", files_touched: [], loose_ends: [], project_tag: null, confidence: 0.3 }],
      agent_learnings: [],
    })
    const result = parseReflectionJson(raw)
    expect(result.memories).toHaveLength(0)
  })

  test("returns empty result on invalid JSON", () => {
    const result = parseReflectionJson("not json at all")
    expect(result.decisions).toHaveLength(0)
    expect(result.memories).toHaveLength(0)
    expect(result.agent_learnings).toHaveLength(0)
  })

  test("returns empty result on empty string", () => {
    const result = parseReflectionJson("")
    expect(result.decisions).toHaveLength(0)
  })

  test("handles missing fields gracefully (no crash)", () => {
    const result = parseReflectionJson(JSON.stringify({ decisions: null }))
    expect(result.decisions).toHaveLength(0)
  })

  test("preserves significance: number on decisions", () => {
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

  test("clamps out-of-range significance to [1,10]", () => {
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

  test("defaults significance to 5 when missing", () => {
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
})

describe("agentLearningsNoteName", () => {
  test("returns monthly note name", () => {
    expect(agentLearningsNoteName(new Date("2026-05-28"))).toBe("Agent Learnings \u2014 2026-05")
  })
})

describe("renderDecision — v2 compact", () => {
  const now = new Date("2026-06-06T14:32:00Z")

  test("renders compact decision with proj/sig/why/chose/vs", () => {
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

  test("uses 'general' for null project_tag", () => {
    const d = {
      title: "t", context: "c", decision: "d", rationale: "r",
      rejected: ["a"], project_tag: null, confidence: 0.9, significance: 5,
    }
    const out = renderDecision(d, now, "ses_x")
    expect(out).toContain("proj: general")
  })

  test("omits vs: line when rejected is empty", () => {
    const d = {
      title: "t", context: "c", decision: "d", rationale: "r",
      rejected: [], project_tag: "p", confidence: 0.9, significance: 5,
    }
    const out = renderDecision(d, now, "ses_x")
    expect(out).not.toContain("vs:")
  })
})

describe("renderMemory — v2 compact", () => {
  const now = new Date("2026-06-06T14:32:00Z")

  test("renders compact memory with proj/sig/why/did/files/loose", () => {
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

  test("omits files: and loose: lines when empty", () => {
    const m = {
      title: "t", what_happened: "w", significance_text: "s",
      files_touched: [], loose_ends: [],
      project_tag: "p", confidence: 0.9, significance: 5,
    }
    const out = renderMemory(m, now, "ses_x")
    expect(out).not.toContain("files:")
    expect(out).not.toContain("loose:")
  })

  test("joins multiple files with comma-space", () => {
    const m = {
      title: "t", what_happened: "w", significance_text: "s",
      files_touched: ["a.ts", "b.ts"], loose_ends: [],
      project_tag: "p", confidence: 0.9, significance: 5,
    }
    const out = renderMemory(m, now, "ses_x")
    expect(out).toContain("files: a.ts, b.ts")
  })
})

describe("renderLearning — v2 compact", () => {
  const now = new Date("2026-06-06T14:32:00Z")

  test("renders compact learning with type/sig/seen/observed/action", () => {
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
      "action: AGENTS.md edit (proposed_agents_edit)"
    )
  })

  test("shows proposed_agents_edit status when seen >= 2", () => {
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
