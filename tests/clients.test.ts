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

  test("searchNotes returns empty array on fetch error", async () => {
    const client = new JoplinClient("http://127.0.0.1:1", "bad-token")
    expect(await client.searchNotes("+myrepo", 5)).toHaveLength(0)
  })
})
