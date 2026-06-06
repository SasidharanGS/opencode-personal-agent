import { expect, test, describe } from "bun:test"
import { detectProject, decisionsNoteName, memoriesNoteName, composeBootstrapMessage, prevMonth, mergeNoteBodies, BOOTSTRAP_ACTIVE_CAP, BOOTSTRAP_OTHER_CAP, BOOTSTRAP_OTHER_SIG_THRESHOLD } from "../src/bootstrap"
import type { BootstrapData, BootstrapEntry } from "../src/types"

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
    recentActive: [
      mkEntry({ title: "Use SQLite", summary: "simpler than Postgres", kind: "d", projectTag: "myrepo", sig: 8 }),
      mkEntry({ title: "Merged PR", summary: "public release done", kind: "m", projectTag: "myrepo", sig: 7 }),
    ],
    recentOther: [],
    activitySummary: "VS Code, Terminal, Joplin",
    agentLearnings: null,
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

  test("omits active section when recentActive is empty", () => {
    expect(composeBootstrapMessage({ ...baseData, recentActive: [] })).not.toContain("Active repo")
  })

  test("includes end marker", () => {
    expect(composeBootstrapMessage(baseData)).toContain("End memory bootstrap")
  })

  test("result is under 2400 chars (~600 tokens)", () => {
    expect(composeBootstrapMessage(baseData).length).toBeLessThan(2400)
  })
})

describe("composeBootstrapMessage — agent learnings", () => {
  test("includes agent learnings section when present", () => {
    const data: BootstrapData = {
      projectName: "myproject",
      recentActive: [],
      recentOther: [],
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
      recentActive: [],
      recentOther: [],
      activitySummary: null,
      agentLearnings: null,
    }
    const msg = composeBootstrapMessage(data)
    expect(msg).not.toContain("Agent Learnings")
  })
})

describe("prevMonth", () => {
  test("returns previous month date", () => {
    const d = prevMonth(new Date("2026-05-15"))
    expect(d.getMonth()).toBe(3) // April = 3
    expect(d.getFullYear()).toBe(2026)
  })

  test("wraps year correctly", () => {
    const d = prevMonth(new Date("2026-01-10"))
    expect(d.getMonth()).toBe(11) // December = 11
    expect(d.getFullYear()).toBe(2025)
  })
})

describe("mergeNoteBodies", () => {
  test("concatenates two note bodies with separator", () => {
    const result = mergeNoteBodies("body A", "body B")
    expect(result).toContain("body A")
    expect(result).toContain("body B")
  })

  test("handles null current note", () => {
    const result = mergeNoteBodies(null, "body B")
    expect(result).toBe("body B")
  })

  test("handles null previous note", () => {
    const result = mergeNoteBodies("body A", null)
    expect(result).toBe("body A")
  })

  test("returns empty string when both null", () => {
    expect(mergeNoteBodies(null, null)).toBe("")
  })
})

const mkEntry = (over: Partial<BootstrapEntry>): BootstrapEntry => ({
  date: "2026-06-06", time: "10:00", kind: "m",
  projectTag: "general", sig: 5,
  title: "t", summary: "s", ...over,
})

describe("composeBootstrapMessage — two-tier", () => {
  test("renders active and other sections with caps", () => {
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

  test("caps are exported as 12 and 7", () => {
    expect(BOOTSTRAP_ACTIVE_CAP).toBe(12)
    expect(BOOTSTRAP_OTHER_CAP).toBe(7)
    expect(BOOTSTRAP_OTHER_SIG_THRESHOLD).toBe(6)
  })

  test("omits Other section when recentOther is empty", () => {
    const data: BootstrapData = {
      projectName: "x", recentActive: [], recentOther: [],
      activitySummary: null, agentLearnings: null,
    }
    const out = composeBootstrapMessage(data)
    expect(out).not.toContain("### Other recent work")
  })
})
