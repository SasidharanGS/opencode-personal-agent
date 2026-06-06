#!/usr/bin/env bun
/**
 * Dedupes Joplin notes inside the Personal Agent notebook (or any notebook you
 * point this at). For each title that appears more than once:
 *
 *   1. Sorts duplicates by `created_time` ASC (oldest first).
 *   2. Concatenates every body, oldest -> newest, separated by "\n\n".
 *   3. PUTs the merged body into the OLDEST note (preserves the original id
 *      and the existing inbound link semantics).
 *   4. DELETEs every duplicate after the merge succeeds.
 *
 * Dry-run by default. Pass --execute to actually mutate Joplin.
 *
 *   bun scripts/dedup-notes.ts                 # dry run (default)
 *   bun scripts/dedup-notes.ts --execute       # do it
 *   bun scripts/dedup-notes.ts --notebook X    # scope (default: env or "Personal Agent")
 *
 * Reads JOPLIN_TOKEN and OPENCODE_PA_JOPLIN_NOTEBOOK from env.
 */

const TOKEN = process.env.JOPLIN_TOKEN
const BASE = process.env.JOPLIN_BASE_URL ?? "http://127.0.0.1:41184"
const args = new Set(process.argv.slice(2))
const argMap = new Map<string, string>()
{
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--") && a[i + 1] && !a[i + 1].startsWith("--")) {
      argMap.set(a[i].slice(2), a[i + 1])
      i++
    }
  }
}
const NOTEBOOK = argMap.get("notebook") ?? process.env.OPENCODE_PA_JOPLIN_NOTEBOOK ?? "Personal Agent"
const EXECUTE = args.has("--execute")

if (!TOKEN) {
  console.error("FATAL: JOPLIN_TOKEN env var not set")
  process.exit(1)
}

interface Note {
  id: string
  title: string
  body: string
  created_time: number
  updated_time: number
  parent_id: string
}

function url(path: string, params: Record<string, string | number> = {}) {
  const p = new URLSearchParams({ token: TOKEN!, ...Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  )})
  return `${BASE}${path}?${p}`
}

async function getFolderId(name: string): Promise<string> {
  const res = await fetch(url("/folders", { fields: "id,title" }))
  if (!res.ok) throw new Error(`/folders -> ${res.status}`)
  const data: any = await res.json()
  const folders = data?.items ?? (Array.isArray(data) ? data : [])
  const found = folders.find((f: any) => f.title === name)
  if (!found) throw new Error(`Notebook "${name}" not found`)
  return found.id
}

async function listAllNotesInFolder(folderId: string): Promise<Note[]> {
  const out: Note[] = []
  let page = 1
  while (true) {
    const res = await fetch(url(`/folders/${folderId}/notes`, {
      fields: "id,title,body,created_time,updated_time,parent_id",
      limit: 100,
      page,
    }))
    if (!res.ok) throw new Error(`/folders/${folderId}/notes -> ${res.status}`)
    const data: any = await res.json()
    const items: Note[] = data?.items ?? []
    out.push(...items)
    if (!data?.has_more) break
    page++
  }
  return out
}

async function updateBody(id: string, body: string): Promise<void> {
  const res = await fetch(url(`/notes/${id}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  })
  if (!res.ok) throw new Error(`PUT /notes/${id} -> ${res.status}: ${await res.text()}`)
}

async function deleteNote(id: string): Promise<void> {
  const res = await fetch(url(`/notes/${id}`), { method: "DELETE" })
  if (!res.ok) throw new Error(`DELETE /notes/${id} -> ${res.status}`)
}

function fmt(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ")
}

async function main() {
  console.log(`Joplin dedup`)
  console.log(`  base     : ${BASE}`)
  console.log(`  notebook : ${NOTEBOOK}`)
  console.log(`  mode     : ${EXECUTE ? "EXECUTE (will modify Joplin)" : "DRY RUN"}`)
  console.log("")

  const folderId = await getFolderId(NOTEBOOK)
  const notes = await listAllNotesInFolder(folderId)
  console.log(`Found ${notes.length} notes in "${NOTEBOOK}".`)

  // Group by title
  const groups = new Map<string, Note[]>()
  for (const n of notes) {
    const arr = groups.get(n.title) ?? []
    arr.push(n)
    groups.set(n.title, arr)
  }
  const dupes = [...groups.entries()].filter(([, arr]) => arr.length > 1)
  if (dupes.length === 0) {
    console.log("No duplicates found. Nothing to do.")
    return
  }

  console.log(`Duplicate titles: ${dupes.length}`)
  console.log("")

  let mergedCount = 0
  let deletedCount = 0
  let bytesMerged = 0

  for (const [title, arr] of dupes) {
    arr.sort((a, b) => a.created_time - b.created_time)
    const survivor = arr[0]
    const losers = arr.slice(1)
    const mergedBody = arr.map(n => n.body).join("\n\n").trimEnd()
    const addedBytes = mergedBody.length - survivor.body.length
    bytesMerged += addedBytes

    console.log(`### ${title} (${arr.length} copies)`)
    for (const n of arr) {
      const role = n.id === survivor.id ? "KEEP   " : "DELETE "
      console.log(`  ${role} ${n.id}  created=${fmt(n.created_time)}  updated=${fmt(n.updated_time)}  body=${n.body.length}B`)
    }
    console.log(`  -> merged body: ${mergedBody.length}B (+${addedBytes}B added to survivor)`)

    if (EXECUTE) {
      try {
        await updateBody(survivor.id, mergedBody)
        for (const loser of losers) {
          await deleteNote(loser.id)
          deletedCount++
        }
        mergedCount++
        console.log(`  -> applied`)
      } catch (e) {
        console.error(`  !! FAILED: ${(e as Error).message}`)
      }
    }
    console.log("")
  }

  console.log("---")
  if (EXECUTE) {
    console.log(`Merged ${mergedCount} title groups.`)
    console.log(`Deleted ${deletedCount} duplicate notes.`)
    console.log(`Total bytes consolidated into survivors: +${bytesMerged}`)
  } else {
    console.log(`DRY RUN: would merge ${dupes.length} title groups, deleting ${dupes.reduce((s, [, a]) => s + a.length - 1, 0)} duplicate notes.`)
    console.log(`Total bytes that would be consolidated: +${bytesMerged}`)
    console.log(`Re-run with --execute to apply.`)
  }
}

main().catch(e => {
  console.error("FATAL:", e)
  process.exit(1)
})
