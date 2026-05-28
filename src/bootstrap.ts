import type { BootstrapData } from "./types.js"

export function detectProject(cwd: string, projectMap: Record<string, string>): string {
  const parts = cwd.replace(/\/$/, "").split("/").filter(Boolean)
  if (parts.length === 0) return "unknown"
  const candidates: string[] = []
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i]
    if (seg.startsWith(".")) {
      candidates.pop()
      continue
    }
    candidates.push(seg)
  }
  for (const seg of candidates) {
    if (projectMap[seg]) return projectMap[seg]
  }
  return candidates[0] ?? "unknown"
}

export function decisionsNoteName(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  return `Decisions \u2014 ${y}-${m}`
}

export function memoriesNoteName(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  return `Memories \u2014 ${y}-${m}`
}

export function composeBootstrapMessage(data: BootstrapData): string {
  const lines: string[] = ["## Memory bootstrap", ""]
  lines.push(`**Active project (from cwd)**: ${data.projectName}`)
  if (data.activitySummary) {
    lines.push(`**Today's activity**: ${data.activitySummary}`)
  }
  lines.push("")
  if (data.recentDecisions.length > 0) {
    lines.push("### Recent decisions (last 7 days)")
    for (const d of data.recentDecisions) lines.push(`- ${d}`)
    lines.push("")
  }
  if (data.recentMemories.length > 0) {
    lines.push("### Recent memories (last 7 days)")
    for (const m of data.recentMemories) lines.push(`- ${m}`)
    lines.push("")
  }
  if (data.projectNotes.length > 0) {
    lines.push("### Project-tagged notes (last 7 days)")
    for (const n of data.projectNotes) lines.push(`- ${n}`)
    lines.push("")
  }
  lines.push("_End memory bootstrap. Continue normally._")
  return lines.join("\n")
}
