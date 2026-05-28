import { expect, test, describe } from "bun:test"
import { JoplinClient } from "../src/clients/joplin"

describe("JoplinClient.parseDecisionLines", () => {
  test("extracts headings within cutoff window", () => {
    const body = `## 2026-05-20 14:32 \u2014 Use SQLite\n\n**Decision**: Use SQLite.\n\n---\n\n## 2026-05-19 09:00 \u2014 Use Bun\n\n**Decision**: Use Bun.\n\n---\n`
    const result = JoplinClient.parseDecisionLines(body, 7, new Date("2026-05-26"))
    expect(result).toHaveLength(2)
    expect(result[0]).toContain("Use SQLite")
  })

  test("filters entries older than cutoff", () => {
    const body = `## 2026-04-01 10:00 \u2014 Old decision\n\n**Decision**: Old.\n\n---\n`
    const result = JoplinClient.parseDecisionLines(body, 7, new Date("2026-05-26"))
    expect(result).toHaveLength(0)
  })

  test("returns empty array for empty body", () => {
    expect(JoplinClient.parseDecisionLines("", 7, new Date())).toHaveLength(0)
  })

  test("caps at 10 entries", () => {
    const sections = Array.from({ length: 15 }, (_, i) =>
      `## 2026-05-${String(i + 1).padStart(2, "0")} 10:00 \u2014 Entry ${i}\n\n---\n`
    ).join("\n")
    expect(JoplinClient.parseDecisionLines(sections, 30, new Date("2026-05-28")).length).toBeLessThanOrEqual(10)
  })
})

describe("JoplinClient error handling", () => {
  test("getNote returns null on fetch error", async () => {
    const client = new JoplinClient("http://127.0.0.1:1", "bad-token")
    expect(await client.getNote("Decisions \u2014 2026-05")).toBeNull()
  })

  // getNote uses limit:10 + exact title filter (n.title === titleOrId) to guard against
  // Joplin's fuzzy full-text search returning a note with a different title.
  // Full integration verification is deferred to Task 8 (integration tests).
  test("searchNotes returns empty array on fetch error", async () => {
    const client = new JoplinClient("http://127.0.0.1:1", "bad-token")
    expect(await client.searchNotes("+myrepo", 5)).toHaveLength(0)
  })
})

import { MemoryClient } from "../src/clients/memory"

describe("MemoryClient", () => {
  test("getTodayActivities returns null when baseUrl is null", async () => {
    expect(await new MemoryClient(null).getTodayActivities()).toBeNull()
  })

  test("getTodayActivities returns null on fetch error", async () => {
    expect(await new MemoryClient("http://127.0.0.1:1").getTodayActivities()).toBeNull()
  })

  test("summarizeActivities returns top-3 apps", () => {
    const activities = [
      { app: "VS Code", duration: 3600 },
      { app: "Terminal", duration: 1800 },
      { app: "Joplin", duration: 900 },
      { app: "Browser", duration: 600 },
    ]
    const s = MemoryClient.summarizeActivities(activities)
    expect(s).toContain("VS Code")
    expect(s).toContain("Terminal")
    expect(s).toContain("Joplin")
    expect(s).not.toContain("Browser")
  })

  test("summarizeActivities returns null for empty array", () => {
    expect(MemoryClient.summarizeActivities([])).toBeNull()
  })
})
