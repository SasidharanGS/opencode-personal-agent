import type { MemoryActivity } from "../types.js"

export class MemoryClient {
  constructor(private baseUrl: string | null) {}

  async getTodayActivities(): Promise<MemoryActivity[] | null> {
    if (!this.baseUrl) return null
    try {
      const today = new Date().toISOString().slice(0, 10)
      const res = await fetch(`${this.baseUrl}/activities?date=${today}`, {
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) return null
      const data = await res.json() as any
      if (!Array.isArray(data)) return null
      return data as MemoryActivity[]
    } catch {
      return null
    }
  }

  static summarizeActivities(activities: MemoryActivity[]): string | null {
    if (activities.length === 0) return null
    return [...activities]
      .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
      .slice(0, 3)
      .map(a => a.app)
      .join(", ")
  }
}
