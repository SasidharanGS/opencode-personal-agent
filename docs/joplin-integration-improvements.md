# Joplin Integration Improvements

**Status**: Done  
**Branch**: merged to `main`  
**Last updated**: 2026-05-31

---

## Background

During E2E testing, five gaps were found in how the plugin reads from and writes to Joplin. This document captures the plan for each, the verified Joplin API behaviour (tested live), and implementation status.

---

## Verified Joplin API Behaviour (tested 2026-05-31)

| Approach | Endpoint | Result |
|---|---|---|
| `GET /notes?query=<term>` | `/notes` | ❌ `query` param silently ignored — returns 5 most-recently-edited notes |
| `GET /search?query=+<project>` | `/search` | ✅ FTS5 — returns notes whose body contains those tokens |
| `GET /search?query="Decisions — 2026-05"` | `/search` | ✅ Exact phrase match — finds note by title text in body index |
| `GET /search?query=title:<name>` | `/search` | ❌ Title qualifier not supported in this Joplin version |
| `GET /search?query=title:"opencode personal agent"` | `/search` | ✅ Works only when hyphens replaced by spaces — fragile |
| `GET /search?query=<term> notebook:"Second Brain"` | `/search` | ✅ Notebook scoping works |
| `GET /search?query=tag:<tagname>` | `/search` | ✅ Tag-based search works once tag is applied |
| `GET /notes/:id` | `/notes/:id` | ✅ Direct by-ID lookup — instant and exact |
| `POST /tags` | `/tags` | ✅ Tag creation works |
| `POST /tags/:id/notes` | `/tags/:id/notes` | ✅ Applying tag to note works |
| `GET /tags/:id/notes` | `/tags/:id/notes` | ✅ Fetching all notes with a tag works |

**Conclusion for `getNote` (looking up by title):**
- `title:` qualifier is unreliable with hyphens and em-dashes in note names.
- Safest approach: use `/search?query="<title>" notebook:"Second Brain"` (exact phrase), then filter results by exact title match in code. Falls back to note creation if nothing matches.

---

## Improvement 1 — Per-project rolling note in Second Brain

**Problem:** `reflect()` writes decisions and memories but never creates a project-specific note. The `### Project-tagged notes` bootstrap section is always empty until the user creates notes manually.

**Design doc reference:** §5.1.2 step 2a, §6.1 cold-start walkthrough.

**Solution:**
- When `reflect()` emits a decision or memory with a non-null `project_tag`, also append a summary entry to `Project Notes — <projectTag>` in Second Brain.
- Create the note automatically if it doesn't exist (same pattern as Decisions/Memories notes).
- Bootstrap reads from this note under `### Project-tagged notes`.

**Note format** (`Project Notes — opencode-personal-agent`):
```markdown
## 2026-05-31 14:32 — Fixed Joplin search endpoint

**Type**: decision
**Summary**: Switched searchNotes from /notes to /search endpoint.

---

## 2026-05-31 18:00 — E2E test session completed

**Type**: memory
**Summary**: Verified bootstrap, pattern detection, and reflect() all working.

---
```

**Files to change:**
- `src/reflect.ts` — after writing decision/memory, append summary to project note
- `src/clients/joplin.ts` — no changes needed (reuses `appendToNote`)
- `src/plugin.ts` — bootstrap already reads project notes; no change needed once notes exist

**Status:** ✅ Done

---

## Improvement 2 — Tag-based project note search

**Problem:** `searchNotes("+opencode-personal-agent", 5)` is too broad — FTS5 tokenizes on `-`, so it matches any note containing `opencode`, `personal`, or `agent`.

**Solution:**
- Plugin auto-creates a Joplin tag named after the project (e.g. `opencode-personal-agent`) if it doesn't exist.
- Every note the plugin writes for a project gets that tag applied via `POST /tags/:id/notes`.
- Bootstrap searches using `tag:<projectName>` on `/search` instead of `+<projectName>`.

**Tag management in `JoplinClient`:**
- New method: `ensureTag(name): Promise<string>` — looks up tag by name, creates if missing, returns tag ID.
- New method: `applyTag(tagId, noteId): Promise<void>` — applies tag to note.
- `appendToNote` / `createNote` — call `ensureTag` + `applyTag` when a `projectTag` is passed.
- `searchNotes` — when query starts with `tag:`, use `/search` directly (already works). No change needed there.

**Bootstrap change in `plugin.ts`:**
```ts
// Before (too broad):
joplin.searchNotes(`+${projectName}`, 5)

// After (precise):
joplin.searchNotes(`tag:${projectName}`, 5)
```

**Files to change:**
- `src/clients/joplin.ts` — add `ensureTag`, `applyTag`; update `createNote` to accept optional `projectTag`
- `src/plugin.ts` — update `gatherBootstrapData` to use `tag:` query
- `src/reflect.ts` — pass `project_tag` through to `appendToNote`/`createNote` calls

**Status:** ✅ Done

---

## Improvement 3 — Cross-month decisions and memories lookup

**Problem:** `getNote(decisionsNoteName(now))` only fetches the current month's note. Decisions made in the last 7 days of the previous month are invisible after month rollover.

**Solution:**
- Fetch current month note AND previous month note in parallel.
- Merge their entries.
- Apply the existing 7-day cutoff filter (`parseDecisionLines`) to the merged set.
- At most 2 fetches; the previous month note may not exist (gracefully returns null).

**Bootstrap change in `plugin.ts`:**
```ts
// Before:
joplin.getNote(decisionsNoteName(now))

// After:
Promise.all([
  joplin.getNote(decisionsNoteName(now)),
  joplin.getNote(decisionsNoteName(prevMonth(now))),
])
// then merge bodies before passing to parseDecisionLines
```

**Helper needed:**
```ts
function prevMonth(date: Date): Date {
  const d = new Date(date)
  d.setMonth(d.getMonth() - 1)
  return d
}
```

**Files to change:**
- `src/plugin.ts` — `gatherBootstrapData`: fetch both months, merge before parsing
- `src/bootstrap.ts` — add `prevMonth` helper; no change to `parseDecisionLines` (already date-aware)

**Status:** ✅ Done

---

## Improvement 4 — Fix `getNote` to use the correct endpoint

**Problem:** `getNote(titleOrId)` calls `GET /notes?query=<title>` — the `query` param is silently ignored, so it returns the 10 most-recently-edited notes and scans them for a title match. Fragile: if the target note isn't in the first 10 by recency, it's missed.

**Verified approach:** `/search?query="<title>" notebook:"Second Brain"` returns the note reliably. Filter by exact title in code as a safety check.

**Implementation:**
```ts
async getNote(titleOrId: string): Promise<JoplinNote | null> {
  // If it looks like a 32-char hex ID, fetch directly
  if (/^[a-f0-9]{32}$/.test(titleOrId)) {
    try {
      const res = await fetch(this.url(`/notes/${titleOrId}`, { fields: "id,title,body,updated_time" }), ...)
      if (!res.ok) return null
      return await res.json()
    } catch { return null }
  }
  // Otherwise search by exact phrase in Second Brain
  const results = await this.searchNotes(`"${titleOrId}" notebook:"Second Brain"`, 5)
  return results.find(n => n.title === titleOrId) ?? null
}
```

**Note:** The exact-phrase `/search` query matches notes whose body or title text contains the phrase. For monthly notes like `Decisions — 2026-05`, their title text appears in their own body via the `##` headings, so phrase search finds them reliably.

**Files to change:**
- `src/clients/joplin.ts` — rewrite `getNote`

**Status:** ✅ Done

---

## Improvement 5 — Log when a project has no notes on first session

**Problem:** When bootstrap finds zero project notes, the section is silently omitted. No indication to the user that they can populate it.

**Solution:**
- After `gatherBootstrapData` resolves, if `projectNotes.length === 0`, log a one-time info message:
  ```
  personal-agent: no project notes found for "opencode-personal-agent" —
  create a note in Second Brain tagged +opencode-personal-agent to populate bootstrap
  ```
- "One-time" means: only log on `session.created`, not on every `system.transform` tick.
- Already happens in `session.created` via `gatherBootstrapData` — just add the log after the call.

**Files to change:**
- `src/plugin.ts` — add log after `gatherBootstrapData` resolves, inside `session.created` handler

**Status:** ✅ Done

---

## Implementation Order

1. **Improvement 4** first — fixes `getNote` correctness. All other improvements depend on reliable note lookup.
2. **Improvement 3** — cross-month. Straightforward; no new API surface.
3. **Improvement 2** — tag infrastructure. Adds `ensureTag` + `applyTag` to `JoplinClient`.
4. **Improvement 1** — project note creation in `reflect()`. Depends on tag infrastructure from #2.
5. **Improvement 5** — observability log. Trivial; last because it depends on knowing what project notes look like after #1 and #2.

---

## Open Questions

- None currently.

---

## Test Plan

Each improvement has a corresponding test in `tests/clients.test.ts` or `tests/bootstrap.test.ts`:

| Improvement | Test coverage needed |
|---|---|
| 1 — project note | `reflect()` integration: assert `appendToNote("Project Notes — <tag>", ...)` called when project_tag present |
| 2 — tags | `ensureTag` idempotency; `applyTag` called on create/append; bootstrap uses `tag:` query |
| 3 — cross-month | `gatherBootstrapData` fetches two months; merges entries; 7-day filter applied to merged set |
| 4 — getNote | ID path; exact-phrase path; returns null when not found; exact-title filter works |
| 5 — log | Log emitted when projectNotes is empty; not emitted when notes exist |
