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

  test("instructs the model to emit YAML frontmatter (name + description)", () => {
    const prompt = buildPromotePrompt({ sig: "bash:git status", tool: "bash", hits: 4 })
    expect(prompt).toContain("---")
    expect(prompt).toContain("name:")
    expect(prompt).toContain("description:")
    expect(prompt).toMatch(/frontmatter/i)
  })
})
