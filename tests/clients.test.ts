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

  test("getNote with 32-char hex id hits /notes/:id directly", async () => {
    let capturedUrl = ""
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url: any) => {
      capturedUrl = String(url)
      return { ok: false, json: async () => ({}) } as any
    }
    const client = new JoplinClient("http://example.com", "tok")
    await client.getNote("a".repeat(32))
    globalThis.fetch = origFetch
    expect(capturedUrl).toContain("/notes/" + "a".repeat(32))
    expect(capturedUrl).not.toContain("/search")
  })

  test("getNote with title string hits /search with exact phrase", async () => {
    let capturedUrl = ""
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url: any) => {
      capturedUrl = String(url)
      return { ok: true, json: async () => ({ items: [] }) } as any
    }
    const client = new JoplinClient("http://example.com", "tok")
    await client.getNote("Decisions \u2014 2026-05", "Second Brain")
    globalThis.fetch = origFetch
    const decoded = decodeURIComponent(capturedUrl).replace(/\+/g, " ")
    expect(capturedUrl).toContain("/search")
    expect(decoded).toContain('"Decisions \u2014 2026-05"')
    expect(decoded).toContain('notebook:"Second Brain"')
  })

  test("getNote returns the correct note when multiple FTS results exist", async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        items: [
          { id: "wrong", title: "Other Note", body: "", updated_time: 0 },
          { id: "correct", title: "Decisions \u2014 2026-05", body: "body", updated_time: 1 },
        ],
      }),
    } as any)
    const client = new JoplinClient("http://example.com", "tok")
    const result = await client.getNote("Decisions \u2014 2026-05")
    globalThis.fetch = origFetch
    expect(result?.id).toBe("correct")
  })

  test("getNote returns null when title does not match any result", async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ items: [{ id: "abc", title: "Other Note", body: "", updated_time: 0 }] }),
    } as any)
    const client = new JoplinClient("http://example.com", "tok")
    const result = await client.getNote("Decisions \u2014 2026-05")
    globalThis.fetch = origFetch
    expect(result).toBeNull()
  })

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

describe("JoplinClient tag methods", () => {
  test("ensureTag returns null on fetch error", async () => {
    const client = new JoplinClient("http://127.0.0.1:1", "bad-token")
    expect(await client.ensureTag("my-project")).toBeNull()
  })

  test("ensureTag returns existing tag id when found", async () => {
    const origFetch = globalThis.fetch
    let callCount = 0
    globalThis.fetch = async (url: any) => {
      callCount++
      return {
        ok: true,
        json: async () => ({ items: [{ id: "tag123", title: "my-project" }] }),
      } as any
    }
    const client = new JoplinClient("http://example.com", "tok")
    const id = await client.ensureTag("my-project")
    globalThis.fetch = origFetch
    expect(id).toBe("tag123")
    expect(callCount).toBe(1)
  })

  test("ensureTag creates tag when not found and returns new id", async () => {
    const origFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = async (url: any, opts?: any) => {
      calls.push(opts?.method ?? "GET")
      if (calls.length === 1) return { ok: true, json: async () => ({ items: [] }) } as any
      return { ok: true, json: async () => ({ id: "newtag", title: "my-project" }) } as any
    }
    const client = new JoplinClient("http://example.com", "tok")
    const id = await client.ensureTag("my-project")
    globalThis.fetch = origFetch
    expect(id).toBe("newtag")
    expect(calls).toEqual(["GET", "POST"])
  })

  test("applyTag returns false on fetch error", async () => {
    const client = new JoplinClient("http://127.0.0.1:1", "bad-token")
    expect(await client.applyTag("tagid", "noteid")).toBe(false)
  })

  test("applyTag calls POST /tags/:id/notes", async () => {
    let capturedUrl = ""
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url: any) => {
      capturedUrl = String(url)
      return { ok: true, json: async () => ({}) } as any
    }
    const client = new JoplinClient("http://example.com", "tok")
    const result = await client.applyTag("tag123", "note456")
    globalThis.fetch = origFetch
    expect(result).toBe(true)
    expect(capturedUrl).toContain("/tags/tag123/notes")
  })
})
