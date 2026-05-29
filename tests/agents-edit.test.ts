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
  test("returns llmPatch directly when it already contains # Agent Learnings", () => {
    const patch = "# Agent Learnings\n\n## Behavioral Rules\n\n### New rule\n- **Rule**: foo\n"
    expect(patchAgentLearningsFile("", patch)).toBe(patch)
  })

  test("wraps in skeleton when content is empty and patch has no headers", () => {
    const result = patchAgentLearningsFile("", "### Use kebab-case\n- **Rule**: kebab")
    expect(result).toContain("# Agent Learnings")
    expect(result).toContain("Auto-maintained")
    expect(result).toContain("Use kebab-case")
  })

  test("returns existing content when patch is partial and file already exists", () => {
    const existing = "# Agent Learnings\n\n## Behavioral Rules\n"
    const partial = "### Just a snippet\n- **Rule**: foo"
    expect(patchAgentLearningsFile(existing, partial)).toBe(existing)
  })

  test("returns llmPatch directly when existing content is present and patch is full", () => {
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
