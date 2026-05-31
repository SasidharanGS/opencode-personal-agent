import { expect, test, describe } from "bun:test"
import { parseReflectionJson, renderDecision, renderMemory, renderLearning, agentLearningsNoteName, renderProjectNoteEntry, projectNoteName } from "../src/reflect"
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
})

describe("renderDecision", () => {
  const decision: ReflectionDecision = {
    title: "Use SQLite",
    context: "Picking a database",
    decision: "SQLite",
    rationale: "Simpler ops",
    rejected: ["Postgres — too heavy"],
    project_tag: "myrepo",
    confidence: 0.9,
  }

  test("includes title in heading", () => {
    expect(renderDecision(decision, new Date("2026-05-28T14:32:00Z"))).toContain("Use SQLite")
  })

  test("includes project tag", () => {
    expect(renderDecision(decision, new Date("2026-05-28T14:32:00Z"))).toContain("+myrepo")
  })

  test("includes rejected alternatives", () => {
    expect(renderDecision(decision, new Date("2026-05-28T14:32:00Z"))).toContain("Postgres")
  })

  test("includes session recorded-by marker", () => {
    expect(renderDecision(decision, new Date("2026-05-28T14:32:00Z"), "ses_abc123")).toContain("ses_abc123")
  })
})

describe("renderMemory", () => {
  const memory: ReflectionMemory = {
    title: "PR merged",
    what_happened: "Merged main.",
    significance: "Unblocks release",
    files_touched: ["README.md"],
    loose_ends: ["Write changelog"],
    project_tag: null,
    confidence: 0.8,
  }

  test("includes title", () => {
    expect(renderMemory(memory, new Date())).toContain("PR merged")
  })

  test("includes files touched", () => {
    expect(renderMemory(memory, new Date())).toContain("README.md")
  })

  test("includes loose ends", () => {
    expect(renderMemory(memory, new Date())).toContain("Write changelog")
  })
})

describe("renderLearning", () => {
  const learning: ReflectionLearning = {
    type: "preference_expressed",
    observed: "User said use pnpm",
    evidence_message_indices: [3],
    proposed_action: "AGENTS.md edit",
    confidence: 0.7,
  }

  test("includes observed text", () => {
    expect(renderLearning(learning, new Date(), 1, "ses_x")).toContain("use pnpm")
  })

  test("includes cross-session count", () => {
    expect(renderLearning(learning, new Date(), 2, "ses_x")).toContain("2")
  })
})

describe("agentLearningsNoteName", () => {
  test("returns monthly note name", () => {
    expect(agentLearningsNoteName(new Date("2026-05-28"))).toBe("Agent Learnings \u2014 2026-05")
  })
})

describe("renderProjectNoteEntry", () => {
  test("includes type and summary", () => {
    const entry = renderProjectNoteEntry("decision", "My Title", "My summary", new Date("2026-05-31T14:32:00Z"), "ses123")
    expect(entry).toContain("**Type**: decision")
    expect(entry).toContain("**Summary**: My summary")
    expect(entry).toContain("My Title")
    expect(entry).toContain("ses123")
  })

  test("includes memory type", () => {
    const entry = renderProjectNoteEntry("memory", "T", "S", new Date(), "s")
    expect(entry).toContain("**Type**: memory")
  })

  test("ends with --- separator", () => {
    const entry = renderProjectNoteEntry("decision", "T", "S", new Date(), "s")
    expect(entry.trimEnd()).toEndWith("---")
  })
})

describe("projectNoteName", () => {
  test("returns correct note name", () => {
    expect(projectNoteName("opencode-personal-agent")).toBe("Project Notes \u2014 opencode-personal-agent")
  })
})
