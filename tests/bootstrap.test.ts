import { expect, test, describe } from "bun:test"
import { detectProject, decisionsNoteName, memoriesNoteName, composeBootstrapMessage } from "../src/bootstrap"
import type { BootstrapData } from "../src/types"

describe("detectProject", () => {
  test("returns last path segment when no map entry matches", () => {
    expect(detectProject("/home/user/myrepo", {})).toBe("myrepo")
  })

  test("returns mapped name when cwd matches a key", () => {
    expect(detectProject("/home/user/myrepo/feature", { "myrepo": "My Repo" })).toBe("My Repo")
  })

  test("returns repo segment for worktree paths", () => {
    expect(detectProject("/home/user/myrepo/.worktrees/feature-branch", {})).toBe("myrepo")
  })

  test("falls back to 'unknown' when cwd is root", () => {
    expect(detectProject("/", {})).toBe("unknown")
  })
})

describe("decisionsNoteName", () => {
  test("returns monthly note title", () => {
    expect(decisionsNoteName(new Date("2026-05-28"))).toBe("Decisions \u2014 2026-05")
  })

  test("pads single-digit month", () => {
    expect(decisionsNoteName(new Date("2026-01-15"))).toBe("Decisions \u2014 2026-01")
  })
})

describe("memoriesNoteName", () => {
  test("returns monthly note title", () => {
    expect(memoriesNoteName(new Date("2026-05-28"))).toBe("Memories \u2014 2026-05")
  })
})

describe("composeBootstrapMessage", () => {
  const baseData: BootstrapData = {
    projectName: "myrepo",
    recentDecisions: ["2026-05-20 \u2014 Use SQLite \u2014 simpler than Postgres"],
    recentMemories: ["2026-05-21 \u2014 Merged PR \u2014 public release done"],
    projectNotes: ["Design spec \u2014 full spec for v1 plugin"],
    activitySummary: "VS Code, Terminal, Joplin",
  }

  test("includes project name", () => {
    expect(composeBootstrapMessage(baseData)).toContain("myrepo")
  })

  test("includes decisions", () => {
    expect(composeBootstrapMessage(baseData)).toContain("Use SQLite")
  })

  test("includes memories", () => {
    expect(composeBootstrapMessage(baseData)).toContain("Merged PR")
  })

  test("includes activity when present", () => {
    expect(composeBootstrapMessage(baseData)).toContain("VS Code")
  })

  test("omits activity section when activitySummary is null", () => {
    expect(composeBootstrapMessage({ ...baseData, activitySummary: null })).not.toContain("activity")
  })

  test("omits decisions section when empty", () => {
    expect(composeBootstrapMessage({ ...baseData, recentDecisions: [] })).not.toContain("decisions")
  })

  test("includes end marker", () => {
    expect(composeBootstrapMessage(baseData)).toContain("End memory bootstrap")
  })

  test("result is under 2400 chars (~600 tokens)", () => {
    expect(composeBootstrapMessage(baseData).length).toBeLessThan(2400)
  })
})
