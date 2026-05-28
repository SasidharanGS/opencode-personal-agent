import { expect, test, describe } from "bun:test"
import { detectPatterns, skillsProposedEntry, markPromoted, writeNewPatterns } from "../src/patterns"

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

describe("writeNewPatterns", () => {
  test("does nothing when candidates array is empty", async () => {
    const joplin = {
      getNote: async () => null,
      appendToNote: async () => { throw new Error("should not be called") },
    } as any
    await expect(writeNewPatterns([], joplin, "Second Brain")).resolves.toBeUndefined()
  })

  test("appends new candidates not already in note", async () => {
    const appended: string[] = []
    const joplin = {
      getNote: async () => null,
      appendToNote: async (_title: string, content: string, _nb: string) => { appended.push(content); return true },
    } as any
    const candidates = [{ sig: "bash:git status", tool: "bash", hits: 3 }]
    await writeNewPatterns(candidates, joplin, "Second Brain")
    expect(appended).toHaveLength(1)
    expect(appended[0]).toContain("bash:git status")
  })

  test("skips candidates already in note body", async () => {
    const appended: string[] = []
    const joplin = {
      getNote: async () => ({ body: "## bash:git status — proposed\n\n**Status**: pending\n\n---" }),
      appendToNote: async (_title: string, content: string, _nb: string) => { appended.push(content); return true },
    } as any
    const candidates = [{ sig: "bash:git status", tool: "bash", hits: 3 }]
    await writeNewPatterns(candidates, joplin, "Second Brain")
    expect(appended).toHaveLength(0)
  })
})
