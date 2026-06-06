import { expect, test, it, describe } from "bun:test"
import { JoplinClient } from "../src/clients/joplin"

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

  test("getNote with title string hits /search with tokenized terms", async () => {
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
    // em-dash is stripped; query uses tokenizable words + notebook scope
    expect(decoded).toContain("Decisions")
    expect(decoded).toContain("2026")
    expect(decoded).toContain('notebook:"Second Brain"')
    // exact phrase with em-dash is NOT used (it breaks FTS5 tokenization)
    expect(decoded).not.toContain('"Decisions \u2014 2026-05"')
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

  test("getNote returns OLDEST note when duplicates exist (created_time tiebreak)", async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        items: [
          { id: "newest",   title: "Memories \u2014 2026-06", body: "B", updated_time: 30, created_time: 30 },
          { id: "oldest",   title: "Memories \u2014 2026-06", body: "A", updated_time: 10, created_time: 10 },
          { id: "middle",   title: "Memories \u2014 2026-06", body: "M", updated_time: 20, created_time: 20 },
          { id: "unrelated", title: "Other Note",            body: "X", updated_time: 5,  created_time: 5  },
        ],
      }),
    } as any)
    const client = new JoplinClient("http://example.com", "tok")
    const result = await client.getNote("Memories \u2014 2026-06", "Personal Agent")
    globalThis.fetch = origFetch
    expect(result?.id).toBe("oldest")
  })

  test("getNote uses OPENCODE_PA_JOPLIN_NOTEBOOK env var by default", async () => {
    const prev = process.env.OPENCODE_PA_JOPLIN_NOTEBOOK
    process.env.OPENCODE_PA_JOPLIN_NOTEBOOK = "Personal Agent"
    let capturedUrl = ""
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url: any) => {
      capturedUrl = String(url)
      return { ok: true, json: async () => ({ items: [] }) } as any
    }
    const client = new JoplinClient("http://example.com", "tok")
    await client.getNote("Memories \u2014 2026-06") // <-- no notebook arg
    globalThis.fetch = origFetch
    if (prev === undefined) delete process.env.OPENCODE_PA_JOPLIN_NOTEBOOK
    else process.env.OPENCODE_PA_JOPLIN_NOTEBOOK = prev
    const decoded = decodeURIComponent(capturedUrl).replace(/\+/g, " ")
    expect(decoded).toContain('notebook:"Personal Agent"')
  })

  test("getNote explicit notebook overrides env default", async () => {
    const prev = process.env.OPENCODE_PA_JOPLIN_NOTEBOOK
    process.env.OPENCODE_PA_JOPLIN_NOTEBOOK = "Personal Agent"
    let capturedUrl = ""
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url: any) => {
      capturedUrl = String(url)
      return { ok: true, json: async () => ({ items: [] }) } as any
    }
    const client = new JoplinClient("http://example.com", "tok")
    await client.getNote("Decisions \u2014 2026-05", "Second Brain")
    globalThis.fetch = origFetch
    if (prev === undefined) delete process.env.OPENCODE_PA_JOPLIN_NOTEBOOK
    else process.env.OPENCODE_PA_JOPLIN_NOTEBOOK = prev
    const decoded = decodeURIComponent(capturedUrl).replace(/\+/g, " ")
    expect(decoded).toContain('notebook:"Second Brain"')
    expect(decoded).not.toContain('notebook:"Personal Agent"')
  })

  test("appendToNote searches in the SAME notebook it was called with (regression for duplicate-notes bug)", async () => {
    const searchUrls: string[] = []
    const putCalls: { url: string; body: string }[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url: any, opts?: any) => {
      const u = String(url)
      if (u.includes("/search")) {
        searchUrls.push(u)
        return {
          ok: true,
          json: async () => ({
            items: [{ id: "found123", title: "Memories \u2014 2026-06", body: "prior", updated_time: 1, created_time: 1 }],
          }),
        } as any
      }
      if (opts?.method === "PUT") {
        putCalls.push({ url: u, body: String(opts.body) })
        return { ok: true } as any
      }
      return { ok: true, json: async () => ({}) } as any
    }
    const client = new JoplinClient("http://example.com", "tok")
    const result = await client.appendToNote(
      "Memories \u2014 2026-06",
      "new entry",
      "Personal Agent",
    )
    globalThis.fetch = origFetch
    expect(result).toBe(true)
    // search must scope to the notebook appendToNote was given
    expect(decodeURIComponent(searchUrls[0]).replace(/\+/g, " "))
      .toContain('notebook:"Personal Agent"')
    // PUT against the found note, not POST /notes (no new note created)
    expect(putCalls.length).toBe(1)
    expect(putCalls[0].url).toContain("/notes/found123")
    expect(putCalls[0].body).toContain("prior")
    expect(putCalls[0].body).toContain("new entry")
  })

  test("appendToNote falls through to createNote only when note truly missing", async () => {
    let postedNote: any = null
    let folderQueried = false
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url: any, opts?: any) => {
      const u = String(url)
      if (u.includes("/search")) return { ok: true, json: async () => ({ items: [] }) } as any
      if (u.includes("/folders") && (!opts || opts.method !== "POST")) {
        folderQueried = true
        return { ok: true, json: async () => ({ items: [{ id: "folder1", title: "Personal Agent" }] }) } as any
      }
      if (u.includes("/notes") && opts?.method === "POST") {
        postedNote = JSON.parse(String(opts.body))
        return { ok: true, json: async () => ({ id: "new1" }) } as any
      }
      return { ok: true, json: async () => ({}) } as any
    }
    const client = new JoplinClient("http://example.com", "tok")
    const ok = await client.appendToNote("Brand New Title", "body", "Personal Agent")
    globalThis.fetch = origFetch
    expect(ok).toBe(true)
    expect(folderQueried).toBe(true)
    expect(postedNote?.title).toBe("Brand New Title")
    expect(postedNote?.parent_id).toBe("folder1")
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

describe("parseEntries — v1 (legacy) format", () => {
  const v1Body = `## 2026-06-06 14:32 \u2014 Fix /compact

**Project**: jll-schema-proxy  +jll-schema-proxy
**Context**: Bedrock rejected /compact payloads
**Decision**: Inject stub tools at proxy
**Rationale**: Preserves history; Falcon not owned
**Rejected**:
  - strip blocks — loses context

**Recorded by**: agent (session ses_x)

---

## 2026-06-01 09:10 \u2014 Old entry

**Project**: general
**What happened**: Something happened
**Significance**: Notable
**Files touched**:
  - (none)
**Loose ends**:
  - (none)

**Recorded by**: agent (session ses_y)

---`

  it("extracts entries from v1 body with default sig=5", () => {
    const entries = JoplinClient.parseEntries(v1Body, { withinDays: 30, now: new Date("2026-06-07") })
    expect(entries).toHaveLength(2)
    expect(entries[0].date).toBe("2026-06-06")
    expect(entries[0].time).toBe("14:32")
    expect(entries[0].title).toBe("Fix /compact")
    expect(entries[0].projectTag).toBe("jll-schema-proxy")
    expect(entries[0].sig).toBe(5)
    expect(entries[0].kind).toBe("d") // has Decision field
  })

  it("filters by withinDays", () => {
    const entries = JoplinClient.parseEntries(v1Body, { withinDays: 3, now: new Date("2026-06-07") })
    expect(entries).toHaveLength(1)
    expect(entries[0].date).toBe("2026-06-06")
  })

  it("returns empty array on empty body", () => {
    const entries = JoplinClient.parseEntries("", { withinDays: 7, now: new Date() })
    expect(entries).toEqual([])
  })
})

describe("parseEntries — v2 (compact) format", () => {
  const v2Body = `## 2026-06-06 14:32 \u2014 Inject stub tools at schema-proxy
proj: jll-schema-proxy \u00b7 sig: 9
why: Bedrock rejects /compact when tools missing but tool blocks present
chose: Reconstruct tools at proxy; tool_choice:none; preserves message history
vs: strip blocks (loses context); fix Falcon Java (not owned)

## 2026-06-06 13:18 \u2014 Joplin dedup script merged 85 notes
proj: opencode-personal-agent \u00b7 sig: 8
why: Duplicate-notes bug created 11 title groups in Personal Agent
did: Wrote dedup script; oldest-wins; PUT merged bodies; DELETE survivors
files: scripts/dedup-notes.ts
`

  it("extracts entries with explicit sig from v2 body", () => {
    const entries = JoplinClient.parseEntries(v2Body, { withinDays: 30, now: new Date("2026-06-07") })
    expect(entries).toHaveLength(2)
    expect(entries[0].sig).toBe(9)
    expect(entries[0].kind).toBe("d") // has `chose:` field
    expect(entries[0].projectTag).toBe("jll-schema-proxy")
    expect(entries[0].summary).toContain("Reconstruct tools")
    expect(entries[1].sig).toBe(8)
    expect(entries[1].kind).toBe("m") // has `did:` field, no `chose:`
  })

  it("clamps out-of-range sig", () => {
    const body = `## 2026-06-06 10:00 \u2014 t1\nproj: x \u00b7 sig: 99\nwhy: y\ndid: z\n`
    const entries = JoplinClient.parseEntries(body, { withinDays: 30, now: new Date("2026-06-07") })
    expect(entries[0].sig).toBe(10)
  })

  it("handles mixed v1 and v2 sections in one body", () => {
    const mixed = `## 2026-06-06 14:00 \u2014 v2 decision
proj: x \u00b7 sig: 7
why: testing mixed body
chose: keep both formats parseable

## 2026-06-05 10:00 \u2014 v1 memory

**Project**: y
**What happened**: legacy entry
**Significance**: still readable
**Files touched**:
  - (none)
**Loose ends**:
  - (none)

**Recorded by**: agent (session ses_x)

---`
    const entries = JoplinClient.parseEntries(mixed, { withinDays: 30, now: new Date("2026-06-07") })
    expect(entries).toHaveLength(2)
    expect(entries[0].sig).toBe(7)
    expect(entries[0].kind).toBe("d")
    expect(entries[1].sig).toBe(5)
    expect(entries[1].kind).toBe("m")
    expect(entries[1].projectTag).toBe("y")
  })
})
