# Joplin Integration Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five gaps in the plugin's Joplin integration: correct `getNote` endpoint, cross-month lookback, tag-based project search, per-project rolling note, and observability log.

**Architecture:** All changes are contained in `src/clients/joplin.ts`, `src/bootstrap.ts`, `src/plugin.ts`, and `src/reflect.ts`. No new files. Implementation order matches dependency chain: fix reads first (Task 1, 2), then write infrastructure (Task 3), then wire both together (Task 4, 5).

**Tech Stack:** TypeScript, Bun, Joplin REST API (`/search`, `/notes/:id`, `/tags`), existing `JoplinClient` class.

**Branch:** `fix-joplin-search` (worktree at `.worktrees/fix-joplin-search`)

**Run tests:** `bun test` from worktree root. All 120 must pass after every task. Run `bun run build` before the dist test will pass.

---

## File Map

| File | Changes |
|---|---|
| `src/clients/joplin.ts` | Fix `getNote`; add `ensureTag`, `applyTag`; update `createNote` + `appendToNote` to accept optional `projectTag` |
| `src/bootstrap.ts` | Add `prevMonth` helper; update `composeBootstrapMessage` (no change needed) |
| `src/plugin.ts` | `gatherBootstrapData`: cross-month fetch, `tag:` search, observability log |
| `src/reflect.ts` | Pass `project_tag` to `appendToNote`/`createNote`; append summary to project note |
| `tests/clients.test.ts` | Tests for `getNote`, `ensureTag`, `applyTag`, updated `createNote`/`appendToNote` |
| `tests/bootstrap.test.ts` | Tests for `prevMonth`, cross-month merge in `gatherBootstrapData` |
| `dist/plugin.js` | Rebuilt after every task via `bun run build` |

---

## Task 1 — Fix `getNote` to use `/search` + direct ID path

**Files:**
- Modify: `src/clients/joplin.ts:16-29`
- Modify: `tests/clients.test.ts:30-43`

### Context

`getNote` currently calls `GET /notes?query=<title>` — the `query` param is silently ignored, returning the 10 most-recently-edited notes. If the target note isn't in the first 10 by recency, it's missed entirely.

**Verified approach (tested live):**
- 32-char hex ID → `GET /notes/:id?fields=id,title,body,updated_time` — instant, exact.
- Title string → `GET /search?query="<title>" notebook:"Second Brain"&fields=id,title,body,updated_time&limit=5` — exact phrase FTS, then filter by exact title in code.

- [ ] **Step 1: Write the failing tests**

Replace the `JoplinClient error handling` describe block in `tests/clients.test.ts` with:

```ts
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
    await client.getNote("Decisions \u2014 2026-05")
    globalThis.fetch = origFetch
    expect(capturedUrl).toContain("/search")
    expect(capturedUrl).toContain("Decisions")
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/clients.test.ts
```

Expected: the 3 new `getNote` tests fail (current `getNote` uses `/notes` not `/search`).

- [ ] **Step 3: Implement the fix in `src/clients/joplin.ts`**

Replace the `getNote` method (lines 16–29):

```ts
async getNote(titleOrId: string): Promise<JoplinNote | null> {
  try {
    if (/^[a-f0-9]{32}$/.test(titleOrId)) {
      const res = await fetch(
        this.url(`/notes/${titleOrId}`, { fields: "id,title,body,updated_time" }),
        { signal: AbortSignal.timeout(5_000) }
      )
      if (!res.ok) return null
      return await res.json() as JoplinNote
    }
    const results = await this.searchNotes(`"${titleOrId}" notebook:"Second Brain"`, 5)
    return results.find(n => n.title === titleOrId) ?? null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/clients.test.ts
```

Expected: all `JoplinClient` tests pass.

- [ ] **Step 5: Build and run full suite**

```bash
bun run build && bun test
```

Expected: 120 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
cd .worktrees/fix-joplin-search
git add src/clients/joplin.ts tests/clients.test.ts dist/plugin.js
git commit -m "fix(joplin): getNote uses /search exact-phrase + direct ID path"
```

---

## Task 2 — Cross-month decisions and memories lookback

**Files:**
- Modify: `src/bootstrap.ts` — add `prevMonth`
- Modify: `src/plugin.ts:282-288` — `gatherBootstrapData` fetches two months, merges
- Modify: `tests/bootstrap.test.ts` — tests for `prevMonth` + merge behaviour

### Context

`gatherBootstrapData` calls `getNote(decisionsNoteName(now))` — only the current month. Decisions from the last days of the previous month are invisible after rollover. Fix: fetch both months in parallel, merge bodies, pass merged body to `parseDecisionLines`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/bootstrap.test.ts` after the existing `composeBootstrapMessage` tests:

```ts
import { prevMonth } from "../src/bootstrap"

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
```

Add the import at the top of `tests/bootstrap.test.ts`:

```ts
import { prevMonth, mergeNoteBodies } from "../src/bootstrap"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/bootstrap.test.ts
```

Expected: `prevMonth` and `mergeNoteBodies` tests fail — functions don't exist yet.

- [ ] **Step 3: Add `prevMonth` and `mergeNoteBodies` to `src/bootstrap.ts`**

Append to the bottom of `src/bootstrap.ts` (before the closing of the file):

```ts
export function prevMonth(date: Date): Date {
  const d = new Date(date)
  d.setMonth(d.getMonth() - 1)
  return d
}

export function mergeNoteBodies(current: string | null, previous: string | null): string {
  if (current && previous) return `${current}\n\n${previous}`
  return current ?? previous ?? ""
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/bootstrap.test.ts
```

Expected: all bootstrap tests pass.

- [ ] **Step 5: Update `gatherBootstrapData` in `src/plugin.ts`**

Replace lines 274–296 (`gatherBootstrapData` function body):

```ts
async function gatherBootstrapData(
  joplin: JoplinClient,
  memory: MemoryClient,
  cwd: string,
): Promise<BootstrapData> {
  const now = new Date()
  const prev = prevMonth(now)
  const projectName = detectProject(cwd, PROJECT_MAP)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp"
  const [
    decisionsNote, prevDecisionsNote,
    memoriesNote, prevMemoriesNote,
    projectNotes, activities, agentLearnings,
  ] = await Promise.all([
    joplin.getNote(decisionsNoteName(now)),
    joplin.getNote(decisionsNoteName(prev)),
    joplin.getNote(memoriesNoteName(now)),
    joplin.getNote(memoriesNoteName(prev)),
    joplin.searchNotes(`tag:${projectName}`, 5),
    memory.getTodayActivities(),
    readAgentLearnings(home),
  ])
  const decisionsBody = mergeNoteBodies(decisionsNote?.body ?? null, prevDecisionsNote?.body ?? null)
  const memoriesBody  = mergeNoteBodies(memoriesNote?.body ?? null,  prevMemoriesNote?.body ?? null)
  return {
    projectName,
    recentDecisions: JoplinClient.parseDecisionLines(decisionsBody, 7, now),
    recentMemories:  JoplinClient.parseDecisionLines(memoriesBody,  7, now),
    projectNotes: projectNotes.slice(0, 5).map(n => `${n.title} \u2014 ${n.body.slice(0, 80).replace(/\n/g, " ")}`),
    activitySummary: activities ? MemoryClient.summarizeActivities(activities) : null,
    agentLearnings,
  }
}
```

Add `prevMonth` and `mergeNoteBodies` to the import from `./bootstrap.js` at `src/plugin.ts:2`:

```ts
import { detectProject, decisionsNoteName, memoriesNoteName, composeBootstrapMessage, readAgentLearnings, prevMonth, mergeNoteBodies } from "./bootstrap.js"
```

- [ ] **Step 6: Build and run full suite**

```bash
bun run build && bun test
```

Expected: 120 pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add src/bootstrap.ts src/plugin.ts tests/bootstrap.test.ts dist/plugin.js
git commit -m "feat(bootstrap): cross-month decisions/memories lookback + tag: project search"
```

---

## Task 3 — Tag infrastructure in `JoplinClient`

**Files:**
- Modify: `src/clients/joplin.ts` — add `ensureTag`, `applyTag`; update `createNote` signature
- Modify: `tests/clients.test.ts` — tests for new methods

### Context

The plugin needs to apply a Joplin tag (e.g. `opencode-personal-agent`) to every note it writes for a project. `ensureTag` looks up the tag by name, creates it if missing, and returns its ID. `applyTag` applies it to a note by ID. Both `createNote` and `appendToNote` get an optional `projectTag` param that wires these together.

`JoplinTag` type needed in `src/types.ts`:

```ts
export interface JoplinTag {
  id: string
  title: string
}
```

- [ ] **Step 1: Add `JoplinTag` to `src/types.ts`**

Append after `JoplinFolder`:

```ts
export interface JoplinTag {
  id: string
  title: string
}
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/clients.test.ts` after the existing describe blocks:

```ts
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
    expect(callCount).toBe(1) // only one GET call, no POST
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
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
bun test tests/clients.test.ts
```

Expected: all 5 new tag tests fail — methods don't exist yet.

- [ ] **Step 4: Add `ensureTag` and `applyTag` to `src/clients/joplin.ts`**

Add the import at the top:

```ts
import type { JoplinNote, JoplinFolder, JoplinTag } from "../types.js"
```

Add these two methods before `getFolderId`:

```ts
async ensureTag(name: string): Promise<string | null> {
  try {
    const res = await fetch(
      this.url("/tags", { fields: "id,title", query: name }),
      { signal: AbortSignal.timeout(5_000) }
    )
    if (!res.ok) return null
    const data = await res.json() as any
    const tags: JoplinTag[] = data?.items ?? (Array.isArray(data) ? data : [])
    const existing = tags.find(t => t.title === name)
    if (existing) return existing.id
    const create = await fetch(this.url("/tags"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: name }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!create.ok) return null
    const created = await create.json() as any
    return created?.id ?? null
  } catch {
    return null
  }
}

async applyTag(tagId: string, noteId: string): Promise<boolean> {
  try {
    const res = await fetch(this.url(`/tags/${tagId}/notes`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: noteId }),
      signal: AbortSignal.timeout(5_000),
    })
    return res.ok
  } catch {
    return false
  }
}
```

- [ ] **Step 5: Update `createNote` to accept and apply `projectTag`**

Replace the `createNote` method:

```ts
async createNote(title: string, body: string, notebook: string, projectTag?: string): Promise<boolean> {
  try {
    const folderId = await this.getFolderId(notebook)
    const res = await fetch(this.url("/notes"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, ...(folderId ? { parent_id: folderId } : {}) }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return false
    if (projectTag) {
      const created = await res.json() as any
      const tagId = await this.ensureTag(projectTag)
      if (tagId && created?.id) await this.applyTag(tagId, created.id)
    }
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 6: Update `appendToNote` to accept and apply `projectTag`**

Replace the `appendToNote` method:

```ts
async appendToNote(titleOrId: string, content: string, notebook: string, projectTag?: string): Promise<boolean> {
  try {
    const note = await this.getNote(titleOrId)
    if (note) {
      const res = await fetch(this.url(`/notes/${note.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: note.body + "\n\n" + content }),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok && projectTag) {
        const tagId = await this.ensureTag(projectTag)
        if (tagId) await this.applyTag(tagId, note.id)
      }
      return res.ok
    }
    return await this.createNote(titleOrId, content, notebook, projectTag)
  } catch {
    return false
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
bun test tests/clients.test.ts
```

Expected: all `JoplinClient` tests pass.

- [ ] **Step 8: Build and run full suite**

```bash
bun run build && bun test
```

Expected: 120 pass, 0 fail.

- [ ] **Step 9: Commit**

```bash
git add src/clients/joplin.ts src/types.ts tests/clients.test.ts dist/plugin.js
git commit -m "feat(joplin): add ensureTag/applyTag; createNote/appendToNote accept projectTag"
```

---

## Task 4 — Per-project rolling note written by `reflect()`

**Files:**
- Modify: `src/reflect.ts:144-157` — append project note summary after writing decision/memory

### Context

After `reflect()` writes a decision or memory with a non-null `project_tag`, it should also append a compact summary entry to `Project Notes — <projectTag>` in Second Brain. This note is what the bootstrap reads under `### Project-tagged notes`. Without this, that section is always empty after a fresh install.

The project note entry format:

```markdown
## 2026-05-31 14:32 — Fixed Joplin search endpoint

**Type**: decision
**Summary**: Switched searchNotes from /notes to /search endpoint.

---
```

- [ ] **Step 1: Add `renderProjectNoteEntry` to `src/reflect.ts`**

Add this function after `renderLearning`:

```ts
export function renderProjectNoteEntry(
  type: "decision" | "memory",
  title: string,
  summary: string,
  now: Date,
  sessionId: string,
): string {
  const ts = now.toISOString().slice(0, 16).replace("T", " ")
  return `## ${ts} \u2014 ${title}\n\n**Type**: ${type}\n**Summary**: ${summary}\n\n**Recorded by**: agent (session ${sessionId})\n\n---`
}

export function projectNoteName(projectTag: string): string {
  return `Project Notes \u2014 ${projectTag}`
}
```

- [ ] **Step 2: Write tests for `renderProjectNoteEntry` and `projectNoteName`**

Add to `tests/reflect.test.ts`:

```ts
import { renderProjectNoteEntry, projectNoteName } from "../src/reflect"

describe("renderProjectNoteEntry", () => {
  test("includes type and summary", () => {
    const entry = renderProjectNoteEntry("decision", "My Title", "My summary", new Date("2026-05-31T14:32:00Z"), "ses123")
    expect(entry).toContain("**Type**: decision")
    expect(entry).toContain("**Summary**: My summary")
    expect(entry).toContain("My Title")
    expect(entry).toContain("ses123")
  })

  test("includes memory type", () => {
    const entry = renderProjectNoteEntry("memory", "T", "S", new Date(), "s")
    expect(entry).toContain("**Type**: memory")
  })
})

describe("projectNoteName", () => {
  test("returns correct note name", () => {
    expect(projectNoteName("opencode-personal-agent")).toBe("Project Notes \u2014 opencode-personal-agent")
  })
})
```

- [ ] **Step 3: Run tests to verify they pass immediately** (pure functions, no fail expected)

```bash
bun test tests/reflect.test.ts
```

Expected: all reflect tests pass including new ones.

- [ ] **Step 4: Wire into `reflect()` — append to project note after each decision/memory**

In `src/reflect.ts`, add the import at top:

```ts
import { decisionsNoteName, memoriesNoteName } from "./bootstrap.js"
```

(already present — no change needed)

Replace the dispatch loop in `reflect()` (lines 144–157):

```ts
for (const d of result.decisions) {
  await joplin.appendToNote(decisionsNoteName(now), renderDecision(d, now, state.sessionId), JOPLIN_NOTEBOOK)
  if (d.project_tag) {
    const entry = renderProjectNoteEntry("decision", d.title, d.decision, now, state.sessionId)
    await joplin.appendToNote(projectNoteName(d.project_tag), entry, JOPLIN_NOTEBOOK, d.project_tag)
  }
}

for (const m of result.memories) {
  await joplin.appendToNote(memoriesNoteName(now), renderMemory(m, now, state.sessionId), JOPLIN_NOTEBOOK)
  if (m.project_tag) {
    const entry = renderProjectNoteEntry("memory", m.title, m.what_happened.slice(0, 120), now, state.sessionId)
    await joplin.appendToNote(projectNoteName(m.project_tag), entry, JOPLIN_NOTEBOOK, m.project_tag)
  }
}
```

- [ ] **Step 5: Build and run full suite**

```bash
bun run build && bun test
```

Expected: 120 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/reflect.ts dist/plugin.js
git commit -m "feat(reflect): append summary to per-project rolling note when project_tag set"
```

---

## Task 5 — Observability log when project has no notes

**Files:**
- Modify: `src/plugin.ts:65-80` — add log after `gatherBootstrapData` resolves

### Context

When `gatherBootstrapData` returns `projectNotes.length === 0`, the `### Project-tagged notes` section is silently omitted. The user has no indication they can populate it. Add a one-time info log on session start.

- [ ] **Step 1: Add the log inside `gatherBootstrapData.then()` in `src/plugin.ts`**

Replace the `.then()` callback (lines 65–80):

```ts
gatherBootstrapData(joplin, memory, directory).then(async (data) => {
  if (!sessions.has(sessionId)) return
  state.bootstrappedContext = composeBootstrapMessage(data)
  await client.app.log({
    body: {
      service: "personal-agent",
      level: "info",
      message: `bootstrapped session ${sessionId} with ${data.recentDecisions.length} decisions, ${data.recentMemories.length} memories`,
      extra: { project: data.projectName },
    },
  })
  if (data.projectNotes.length === 0 && data.projectName !== "unknown") {
    await client.app.log({
      body: {
        service: "personal-agent",
        level: "info",
        message: `no project notes found for "${data.projectName}" — reflect() will create them automatically after your first session, or create a note in Second Brain tagged +${data.projectName}`,
        extra: { project: data.projectName },
      },
    })
  }
}).catch(async (err) => {
  await client.app.log({
    body: { service: "personal-agent", level: "warn", message: "bootstrap failed", extra: { error: String(err) } },
  })
})
```

- [ ] **Step 2: Build and run full suite**

```bash
bun run build && bun test
```

Expected: 120 pass, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add src/plugin.ts dist/plugin.js
git commit -m "feat(bootstrap): log hint when no project notes found on session start"
```

---

## Task 6 — Remove temp debug log

**Files:**
- Modify: `src/plugin.ts:116-154` — remove `TEMP-E2E-DEBUG` block from `experimental.chat.system.transform`

### Context

The `system.transform` hook has a debug log block added during E2E testing (lines 120–138). It logs on every prompt in every session. Remove it now that implementation is complete.

- [ ] **Step 1: Remove the debug block from `src/plugin.ts`**

Replace this block in `experimental.chat.system.transform`:

```ts
// TEMP-E2E-DEBUG: report hook firing + state shape (remove after verification)
try {
  await client.app.log({
    body: {
      service: "personal-agent",
      level: "info",
      message: `system.transform fired`,
      extra: {
        sessionId,
        hasState: !!state,
        hasBootstrap: !!state?.bootstrappedContext,
        bootstrapLen: state?.bootstrappedContext?.length ?? 0,
        outputSystemPreLen: output.system?.length ?? 0,
        pendingProm: state?.pendingPromotions?.size ?? 0,
        pendingEdits: state?.pendingAgentsEdits?.size ?? 0,
      },
    },
  })
} catch {}
```

With nothing (delete it entirely).

- [ ] **Step 2: Build and run full suite**

```bash
bun run build && bun test
```

Expected: 120 pass, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add src/plugin.ts dist/plugin.js
git commit -m "chore: remove temp E2E debug log from system.transform"
```

---

## Task 7 — Update `docs/joplin-integration-improvements.md`

Mark all improvements as done and note the final verified approach for each.

- [ ] **Step 1: Update status fields in the doc**

In `docs/joplin-integration-improvements.md`, change all `⬜ Pending` to `✅ Done`.

- [ ] **Step 2: Commit**

```bash
git add docs/joplin-integration-improvements.md
git commit -m "docs: mark all joplin integration improvements as done"
```

---

## Final Verification

- [ ] `bun test` — 120 pass, 0 fail
- [ ] `git log --oneline main..HEAD` — 7 commits, one per task
- [ ] `git diff main -- src/` — review all source changes are intentional
- [ ] Worktree ready to merge/PR

---

## Self-Review Against Spec

| Requirement | Task |
|---|---|
| `getNote` uses `/search` exact-phrase + direct ID path | Task 1 |
| Second Brain notebook scoping on reads | Task 1 (`notebook:"Second Brain"` in query) |
| Cross-month decisions + memories (current + prev month) | Task 2 |
| `tag:` search in bootstrap | Task 2 (step 5) |
| `ensureTag` auto-creates Joplin tag if missing | Task 3 |
| `applyTag` applies tag to note | Task 3 |
| `createNote` / `appendToNote` accept `projectTag` | Task 3 |
| Per-project rolling note written by `reflect()` | Task 4 |
| Project note tagged with project tag | Task 4 (via `appendToNote(..., projectTag)`) |
| Observability log when no project notes found | Task 5 |
| Remove temp debug log | Task 6 |
| Docs updated | Task 7 |
