import type { JoplinNote, JoplinFolder, JoplinTag, BootstrapEntry } from "../types.js"

const EM_DASH = "\u2014"
const MIDDLE_DOT = "\u00b7"

export class JoplinClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private url(path: string, params: Record<string, string | number> = {}): string {
    const p = new URLSearchParams({ token: this.token, ...Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    )})
    return `${this.baseUrl}${path}?${p}`
  }

  async getNote(
    titleOrId: string,
    notebook: string = process.env.OPENCODE_PA_JOPLIN_NOTEBOOK ?? "Second Brain",
  ): Promise<JoplinNote | null> {
    try {
      if (/^[a-f0-9]{32}$/.test(titleOrId)) {
        const res = await fetch(
          this.url(`/notes/${titleOrId}`, { fields: "id,title,body,updated_time" }),
          { signal: AbortSignal.timeout(5_000) }
        )
        if (!res.ok) return null
        return await res.json() as JoplinNote
      }
      // Strip non-alphanumeric chars so FTS5 tokenizes correctly (em-dashes etc. break phrases)
      const tokens = titleOrId.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim()
      const results = await this.searchNotes(
        `${tokens} notebook:"${notebook}"`,
        20,
        "id,title,body,updated_time,created_time",
      )
      const matches = results.filter(n => n.title === titleOrId)
      if (matches.length === 0) return null
      // Oldest-wins: if duplicates ever sneak in, always converge to the original note.
      matches.sort((a, b) => (a.created_time ?? 0) - (b.created_time ?? 0))
      return matches[0]
    } catch {
      return null
    }
  }

  async searchNotes(
    query: string,
    limit = 5,
    fields = "id,title,body,updated_time",
  ): Promise<JoplinNote[]> {
    try {
      const res = await fetch(
        this.url("/search", { query, fields, limit }),
        { signal: AbortSignal.timeout(5_000) }
      )
      if (!res.ok) return []
      const data = await res.json() as any
      return data?.items ?? (Array.isArray(data) ? data : [])
    } catch {
      return []
    }
  }

  /**
   * Reads the note, appends content, and writes back via PUT.
   * Not atomic — concurrent calls can overwrite each other.
   * Acceptable in v1 (single-session use); revisit in Phase 2 if needed.
   */
  async appendToNote(titleOrId: string, content: string, notebook: string, projectTag?: string): Promise<boolean> {
    try {
      const note = await this.getNote(titleOrId, notebook)
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

  async updateNote(id: string, body: string): Promise<boolean> {
    try {
      const res = await fetch(this.url(`/notes/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(10_000),
      })
      return res.ok
    } catch {
      return false
    }
  }

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

  private async getFolderId(title: string): Promise<string | null> {
    try {
      const res = await fetch(this.url("/folders", { fields: "id,title" }), { signal: AbortSignal.timeout(5_000) })
      if (!res.ok) return null
      const data = await res.json() as any
      const folders: JoplinFolder[] = data?.items ?? (Array.isArray(data) ? data : [])
      return folders.find(f => f.title === title)?.id ?? null
    } catch {
      return null
    }
  }

  static parseEntries(
    body: string,
    opts: { withinDays: number; now: Date },
  ): BootstrapEntry[] {
    if (!body) return []
    const cutoff = new Date(opts.now.getTime() - opts.withinDays * 24 * 60 * 60 * 1000)
    const out: BootstrapEntry[] = []

    // Split on `## YYYY-MM-DD HH:MM — title` headers. Use a positive lookahead so
    // the header line stays at the start of each chunk.
    const HEADER_RE = /(?=^##\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\u2014)/m
    const sections = body.split(HEADER_RE).map(s => s.trim()).filter(Boolean)

    for (const section of sections) {
      const headerMatch = section.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+\u2014\s+(.+)$/m)
      if (!headerMatch) continue
      const [, date, time, title] = headerMatch
      const entryDate = new Date(date)
      if (isNaN(entryDate.getTime()) || entryDate < cutoff) continue

      // Try v2 first: `proj: <tag> · sig: <n>`
      const v2Meta = section.match(/^proj:\s+(\S+)\s+\u00b7\s+sig:\s+(\d+)/m)
      let projectTag = "general"
      let sig = 5
      let isV2 = false

      if (v2Meta) {
        isV2 = true
        projectTag = v2Meta[1]
        sig = Math.max(1, Math.min(10, parseInt(v2Meta[2], 10) || 5))
      } else {
        // v1: `**Project**: <tag>` (drop the trailing `+tag` if present)
        const v1Proj = section.match(/^\*\*Project\*\*:\s+([^\s+]+)/m)
        if (v1Proj) projectTag = v1Proj[1]
      }

      // Kind: decision if `chose:` (v2) or `**Decision**:` (v1) present
      const kind: "m" | "d" =
        /^(chose:|\*\*Decision\*\*:)/m.test(section) ? "d" : "m"

      // Summary: first content line after metadata
      let summary = title.trim()
      if (isV2) {
        // For decisions, prefer `chose:` summary; for memories prefer `did:` then `why:`
        const choseMatch = section.match(/^chose:\s+(.+)$/m)
        const didMatch = section.match(/^did:\s+(.+)$/m)
        const whyMatch = section.match(/^why:\s+(.+)$/m)
        const sumMatch = kind === "d"
          ? (choseMatch ?? whyMatch)
          : (didMatch ?? whyMatch)
        if (sumMatch) summary = sumMatch[1].trim().slice(0, 100)
      } else {
        const sumMatch = section.match(/^\*\*(?:Decision|What happened)\*\*:\s+(.+)$/m)
        if (sumMatch) summary = sumMatch[1].trim().slice(0, 100)
      }

      out.push({
        date,
        time,
        kind,
        projectTag: projectTag.trim(),
        sig,
        title: title.trim(),
        summary,
      })
    }

    return out
  }
}
