import type { JoplinNote, JoplinFolder, JoplinTag } from "../types.js"

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

  async getNote(titleOrId: string, notebook = "Second Brain"): Promise<JoplinNote | null> {
    try {
      if (/^[a-f0-9]{32}$/.test(titleOrId)) {
        const res = await fetch(
          this.url(`/notes/${titleOrId}`, { fields: "id,title,body,updated_time" }),
          { signal: AbortSignal.timeout(5_000) }
        )
        if (!res.ok) return null
        return await res.json() as JoplinNote
      }
      const results = await this.searchNotes(`"${titleOrId}" notebook:"${notebook}"`, 5)
      return results.find(n => n.title === titleOrId) ?? null
    } catch {
      return null
    }
  }

  async searchNotes(query: string, limit = 5): Promise<JoplinNote[]> {
    try {
      const res = await fetch(
        this.url("/search", { query, fields: "id,title,body,updated_time", limit }),
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

  static parseDecisionLines(body: string, withinDays: number, now: Date): string[] {
    const cutoff = new Date(now.getTime() - withinDays * 24 * 60 * 60 * 1000)
    const sections = body.split(/^---$/m).map(s => s.trim()).filter(Boolean)
    const results: string[] = []
    for (const section of sections) {
      if (results.length >= 10) break
      const m = section.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+[\d:]+\s+\u2014\s+(.+)$/m)
      if (!m) continue
      const entryDate = new Date(m[1])
      if (isNaN(entryDate.getTime()) || entryDate < cutoff) continue
      results.push(`${m[1]} \u2014 ${m[2].trim()}`)
    }
    return results
  }
}
