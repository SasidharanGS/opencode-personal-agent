import { expect, test, describe } from "bun:test"
import { formatWrapSummary, type WrapData } from "../src/wrap"

describe("formatWrapSummary", () => {
  const now = new Date("2026-05-28T18:14:00Z")

  test("shows saved decisions", () => {
    const data: WrapData = {
      savedDecisions: ["Use SQLite over Postgres", "Use Bun over Node"],
      savedMemories: [], skillCandidates: [], agentsMdProposals: [], reflectError: null,
    }
    const s = formatWrapSummary(data, "2026-05", now)
    expect(s).toContain("Decisions \u2014 2026-05")
    expect(s).toContain("Use SQLite over Postgres")
    expect(s).toContain("Use Bun over Node")
  })

  test("shows saved memories", () => {
    const data: WrapData = {
      savedDecisions: [], savedMemories: ["PR merged \u2014 public release done"],
      skillCandidates: [], agentsMdProposals: [], reflectError: null,
    }
    const s = formatWrapSummary(data, "2026-05", now)
    expect(s).toContain("Memories \u2014 2026-05")
    expect(s).toContain("PR merged")
  })

  test("shows skill candidates with /promote hint", () => {
    const data: WrapData = {
      savedDecisions: [], savedMemories: [],
      skillCandidates: [{ name: "pr-create", hits: 4 }],
      agentsMdProposals: [], reflectError: null,
    }
    const s = formatWrapSummary(data, "2026-05", now)
    expect(s).toContain("pr-create")
    expect(s).toContain("4")
    expect(s).toContain("/promote")
  })

  test("shows AGENTS.md proposals with /agents-edit hint", () => {
    const data: WrapData = {
      savedDecisions: [], savedMemories: [], skillCandidates: [],
      agentsMdProposals: [{ observed: "Always confirm before pushing", crossSessionCount: 2 }],
      reflectError: null,
    }
    const s = formatWrapSummary(data, "2026-05", now)
    expect(s).toContain("Always confirm before pushing")
    expect(s).toContain("/agents-edit")
  })

  test("shows nothing-flagged when all empty", () => {
    const data: WrapData = {
      savedDecisions: [], savedMemories: [], skillCandidates: [], agentsMdProposals: [], reflectError: null,
    }
    const s = formatWrapSummary(data, "2026-05", now)
    expect(s).toContain("Nothing else flagged")
  })

  test("shows reflection error when present", () => {
    const data: WrapData = {
      savedDecisions: [], savedMemories: [], skillCandidates: [], agentsMdProposals: [],
      reflectError: "LLM timeout",
    }
    const s = formatWrapSummary(data, "2026-05", now)
    expect(s).toContain("LLM timeout")
  })

  test("includes date in header", () => {
    const s = formatWrapSummary(
      { savedDecisions: [], savedMemories: [], skillCandidates: [], agentsMdProposals: [], reflectError: null },
      "2026-05", now,
    )
    expect(s).toContain("2026-05-28")
  })

  test("shows entry count in section header", () => {
    const data: WrapData = {
      savedDecisions: ["A", "B"], savedMemories: [], skillCandidates: [], agentsMdProposals: [], reflectError: null,
    }
    const s = formatWrapSummary(data, "2026-05", now)
    expect(s).toContain("(2 entries)")
  })

  test("shows singular 'entry' for count of 1", () => {
    const data: WrapData = {
      savedDecisions: ["Just one decision"], savedMemories: [],
      skillCandidates: [], agentsMdProposals: [], reflectError: null,
    }
    const s = formatWrapSummary(data, "2026-05", new Date("2026-05-28T18:14:00Z"))
    expect(s).toContain("(1 entry)")
    expect(s).not.toContain("(1 entries)")
  })
})
