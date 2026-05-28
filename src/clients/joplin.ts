import type { JoplinNote, JoplinFolder } from "../types.js"

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

  async getNote(titleOrId: string): Promise<JoplinNote | null> {
    try {
      const res = await fetch(
        this.url("/notes", { query: titleOrId, fields: "id,title,body,updated_time", limit: 1 }),
        { signal: AbortSignal.timeout(5_000) }
      )
      if (!res.ok) return null
      const data = await res.json() as any
      const items: JoplinNote[] = data?.items ?? (Array.isArray(data) ? data : [])
      return items[0] ?? null
    } catch {
      return null
    }
  }

  async searchNotes(query: string, limit = 5): Promise<JoplinNote[]> {
    try {
      const res = await fetch(
        this.url("/notes", { query, fields: "id,title,body,updated_time", limit, order_by: "updated_time", order_dir: "DESC" }),
        { signal: AbortSignal.timeout(5_000) }
      )
      if (!res.ok) return []
      const data = await res.json() as any
      return data?.items ?? (Array.isArray(data) ? data : [])
    } catch {
      return []
    }
  }

  async appendToNote(titleOrId: string, content: string, notebook: string): Promise<boolean> {
    try {
      const note = await this.getNote(titleOrId)
      if (note) {
        const res = await fetch(this.url(`/notes/${note.id}`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: note.body + "\n\n" + content }),
          signal: AbortSignal.timeout(10_000),
        })
        return res.ok
      }
      return await this.createNote(titleOrId, content, notebook)
    } catch {
      return false
    }
  }

  async createNote(title: string, body: string, notebook: string): Promise<boolean> {
    try {
      const folderId = await this.getFolderId(notebook)
      const res = await fetch(this.url("/notes"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, ...(folderId ? { parent_id: folderId } : {}) }),
        signal: AbortSignal.timeout(10_000),
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
