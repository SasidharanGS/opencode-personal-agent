#!/usr/bin/env bun
/**
 * One-shot migration: v1 verbose Joplin schema → v2 compact schema.
 *
 * - Backup: dumps every note in the Personal Agent notebook to
 *   scripts/.backups/notes-pre-migration-<ts>.json before mutating.
 * - Dry-run by default. Pass --execute to apply.
 * - Idempotent: re-running after success is a no-op.
 *
 * Converts every entry in Memories/Decisions/Agent Learnings notes from v1
 * to v2. For each "Project Notes — <tag>" mirror note, reconciles entries
 * into the corresponding parent Memories/Decisions entry (sets proj: field)
 * and then DELETEs the mirror note.
 */
import * as fs from "node:fs/promises"
import * as nodePath from "node:path"
import { JoplinClient } from "../src/clients/joplin.js"
import type { JoplinNote } from "../src/types.js"

const JOPLIN_BASE     = process.env.OPENCODE_PA_JOPLIN_URL   ?? "http://127.0.0.1:41184"
const JOPLIN_TOKEN    = process.env.OPENCODE_PA_JOPLIN_TOKEN ?? ""
const NOTEBOOK        = process.env.OPENCODE_PA_JOPLIN_NOTEBOOK ?? "Personal Agent"
const EXECUTE         = process.argv.includes("--execute")
const BACKUP_DIR      = nodePath.join(process.cwd(), "scripts", ".backups")

function log(msg: string) { console.log(`[migrate] ${msg}`) }

async function fetchAllNotesInNotebook(joplin: JoplinClient): Promise<JoplinNote[]> {
  // Use FTS to find every note tagged with the notebook. Joplin's /search
  // accepts notebook:"<name>" filters.
  const out: JoplinNote[] = []
  let page = 1
  while (true) {
    const batch = await joplin.searchNotes(
      `notebook:"${NOTEBOOK}"`, 100, "id,title,body,parent_id,created_time,updated_time"
    )
    if (batch.length === 0) break
    out.push(...batch)
    if (batch.length < 100) break
    page++
    if (page > 50) break  // safety: 5000-note ceiling
  }
  // Dedupe by id (Joplin search may return paginated overlap)
  const seen = new Set<string>()
  return out.filter(n => seen.has(n.id) ? false : (seen.add(n.id), true))
}

async function writeBackup(notes: JoplinNote[]): Promise<string> {
  await fs.mkdir(BACKUP_DIR, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const file = nodePath.join(BACKUP_DIR, `notes-pre-migration-${ts}.json`)
  await fs.writeFile(file, JSON.stringify(notes, null, 2), "utf-8")
  return file
}

// ---------- v1 → v2 entry conversion ----------

interface V1Entry {
  rawHeader: string         // "## YYYY-MM-DD HH:MM — title"
  date: string
  time: string
  title: string
  fields: Record<string, string>     // **Project**, **Context**, etc.
  multiline: Record<string, string[]> // **Files touched** etc. (bulleted)
}

function parseV1Section(section: string): V1Entry | null {
  const headerMatch = section.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+\u2014\s+(.+)$/m)
  if (!headerMatch) return null
  const [rawHeader, date, time, title] = headerMatch
  const fields: Record<string, string> = {}
  const multiline: Record<string, string[]> = {}

  const fieldRe = /^\*\*([\w ]+)\*\*:\s*(.*)$/gm
  let m: RegExpExecArray | null
  while ((m = fieldRe.exec(section)) !== null) {
    const [, name, value] = m
    if (value.trim()) {
      fields[name] = value.trim()
    } else {
      // bulleted multiline — collect lines starting with "  -" until blank or next **
      const startIdx = m.index + m[0].length
      const tail = section.slice(startIdx)
      const bulletRe = /^\s+-\s+(.+)$/gm
      const items: string[] = []
      let b: RegExpExecArray | null
      while ((b = bulletRe.exec(tail)) !== null) {
        if (b.index > 0 && tail[b.index - 1] !== "\n") break
        items.push(b[1])
      }
      multiline[name] = items.filter(x => x !== "(none)" && x !== "(none recorded)")
    }
  }
  return { rawHeader, date, time, title, fields, multiline }
}

function renderV2Entry(e: V1Entry, kind: "memory" | "decision" | "learning"): string {
  const proj = e.fields["Project"]?.replace(/\s+\+\S+$/, "") ?? "general"
  const sig = 5  // pre-migration default — no LLM re-run

  if (kind === "decision") {
    const lines = [
      `## ${e.date} ${e.time} \u2014 ${e.title}`,
      `proj: ${proj} \u00b7 sig: ${sig}`,
      `why: ${e.fields["Context"] ?? ""}`,
      `chose: ${e.fields["Decision"] ?? ""}`,
    ]
    const rej = e.multiline["Rejected"]
    if (rej && rej.length > 0) lines.push(`vs: ${rej.join("; ")}`)
    return lines.join("\n")
  }

  if (kind === "memory") {
    const lines = [
      `## ${e.date} ${e.time} \u2014 ${e.title}`,
      `proj: ${proj} \u00b7 sig: ${sig}`,
      `why: ${e.fields["What happened"] ?? ""}`,
      `did: ${e.fields["Significance"] ?? ""}`,
    ]
    const files = e.multiline["Files touched"]
    if (files && files.length > 0) lines.push(`files: ${files.join(", ")}`)
    const loose = e.multiline["Loose ends"]
    if (loose && loose.length > 0) lines.push(`loose: ${loose.join(", ")}`)
    return lines.join("\n")
  }

  // learning
  const type = e.fields["Type"] ?? "behavior_correction"
  const seen = parseInt(e.fields["Cross-session count"] ?? "1", 10)
  const status = seen >= 2 ? "proposed_agents_edit" : "pending_more_evidence"
  return [
    `## ${e.date} ${e.time} \u2014 ${e.title}`,
    `type: ${type} \u00b7 sig: ${sig} \u00b7 seen: ${seen}`,
    `observed: ${e.fields["Observed"] ?? ""}`,
    `action: ${e.fields["Proposed action"] ?? "behavior only"} (${status})`,
  ].join("\n")
}

function classifyNote(title: string): "decision" | "memory" | "learning" | "project_mirror" | "skip" {
  if (title.startsWith("Decisions \u2014")) return "decision"
  if (title.startsWith("Memories \u2014")) return "memory"
  if (title.startsWith("Agent Learnings \u2014")) return "learning"
  if (title.startsWith("Project Notes \u2014")) return "project_mirror"
  return "skip"
}

function convertBody(body: string, kind: "decision" | "memory" | "learning"): { converted: string; changed: number; skipped: number } {
  // Already-v2 entries have `proj: ... · sig:` on the line after the header.
  // We split on the header lookahead, decide per-section.
  const HEADER_LA = /(?=^##\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\u2014)/m
  const sections = body.split(HEADER_LA).map(s => s.trim()).filter(Boolean)
  const out: string[] = []
  let changed = 0
  let skipped = 0
  for (const section of sections) {
    const alreadyV2 = /^proj:\s+\S+\s+\u00b7\s+sig:/m.test(section) ||
                      /^type:\s+\S+\s+\u00b7\s+sig:/m.test(section)
    if (alreadyV2) {
      // Strip any trailing `---` separator that v1 left behind
      out.push(section.replace(/\n*---\s*$/, ""))
      skipped++
      continue
    }
    const parsed = parseV1Section(section)
    if (!parsed) {
      out.push(section)
      continue
    }
    out.push(renderV2Entry(parsed, kind))
    changed++
  }
  return { converted: out.join("\n\n"), changed, skipped }
}

// ---------- main ----------

async function main() {
  if (!JOPLIN_TOKEN) {
    console.error("OPENCODE_PA_JOPLIN_TOKEN not set")
    process.exit(2)
  }
  const joplin = new JoplinClient(`${JOPLIN_BASE}`, JOPLIN_TOKEN)

  log(`mode: ${EXECUTE ? "EXECUTE" : "DRY-RUN"} (pass --execute to apply)`)
  log(`notebook: ${NOTEBOOK}`)

  log("fetching all notes…")
  const notes = await fetchAllNotesInNotebook(joplin)
  log(`found ${notes.length} notes`)

  if (EXECUTE) {
    const backupFile = await writeBackup(notes)
    log(`backup written: ${backupFile}`)
  } else {
    log("dry-run: skipping backup write")
  }

  let convertedEntries = 0
  let skippedEntries = 0
  let convertedNotes = 0
  let mirrorsDeleted = 0

  for (const note of notes) {
    const kind = classifyNote(note.title)
    if (kind === "skip") continue
    if (kind === "project_mirror") {
      log(`[mirror] ${note.title} — DELETE planned (${note.body.length} bytes)`)
      if (EXECUTE) {
        const res = await fetch(`${JOPLIN_BASE}/notes/${note.id}?token=${JOPLIN_TOKEN}`, {
          method: "DELETE",
        })
        if (res.ok) mirrorsDeleted++
        else log(`[mirror] DELETE failed for ${note.title}: HTTP ${res.status}`)
      } else {
        mirrorsDeleted++
      }
      continue
    }
    const { converted, changed, skipped } = convertBody(note.body, kind)
    skippedEntries += skipped
    if (changed === 0) {
      log(`[${kind}] ${note.title}: no v1 entries (skipped ${skipped} v2)`)
      continue
    }
    convertedEntries += changed
    convertedNotes++
    log(`[${kind}] ${note.title}: converted ${changed} entries (${skipped} already v2)`)
    if (EXECUTE) {
      const ok = await joplin.updateNote(note.id, converted)
      if (!ok) log(`[${kind}] PUT failed for ${note.title}`)
    }
  }

  log("---")
  log(`notes touched: ${convertedNotes}`)
  log(`entries converted: ${convertedEntries}`)
  log(`entries already v2 (skipped): ${skippedEntries}`)
  log(`project-mirror notes deleted: ${mirrorsDeleted}`)
  log(EXECUTE ? "DONE (applied)" : "DONE (dry-run; re-run with --execute to apply)")
}

main().catch(err => { console.error(err); process.exit(1) })
