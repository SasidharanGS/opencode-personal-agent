import * as fs from "node:fs/promises"
import * as nodePath from "node:path"
import type { BootstrapData, BootstrapEntry } from "./types.js"

export const BOOTSTRAP_ACTIVE_CAP = 12
export const BOOTSTRAP_OTHER_CAP = 7
export const BOOTSTRAP_OTHER_SIG_THRESHOLD = 6

export function detectProject(cwd: string, projectMap: Record<string, string>): string {
  const parts = cwd.replace(/\/$/, "").split("/").filter(Boolean)
  if (parts.length === 0) return "unknown"
  const candidates: string[] = []
  // Walk from the deepest path segment upward; skip dot-prefixed segments (hidden dirs
  // like .git, .worktrees) and remove any segment that immediately follows one — the
  // segment before a dot-dir is typically a tool artifact, not a meaningful project name.
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

export async function readAgentLearnings(home: string): Promise<string | null> {
  try {
    const path = nodePath.join(home, ".config", "opencode", "agent-learnings.md")
    return await fs.readFile(path, "utf-8")
  } catch {
    return null
  }
}

function renderActiveLine(e: BootstrapEntry): string {
  const md = e.date.slice(5)
  return `- ${md} ${e.time} [${e.kind} sig:${e.sig}] ${e.title} \u2014 ${e.summary}`
}

function renderOtherLine(e: BootstrapEntry): string {
  const md = e.date.slice(5)
  return `- ${md} ${e.time} [${e.projectTag}] ${e.title}`
}

export function composeBootstrapMessage(data: BootstrapData): string {
  const lines: string[] = ["## Memory bootstrap", ""]
  lines.push(`proj: ${data.projectName}`)
  if (data.activitySummary) {
    lines.push(`today: ${data.activitySummary}`)
  }
  lines.push("")

  if (data.recentActive.length > 0) {
    lines.push("### Active repo (last 7d, ranked by sig)")
    for (const e of data.recentActive) lines.push(renderActiveLine(e))
    lines.push("")
  }

  if (data.recentOther.length > 0) {
    lines.push(`### Other recent work (last 3d, top ${BOOTSTRAP_OTHER_CAP} by sig \u2265${BOOTSTRAP_OTHER_SIG_THRESHOLD})`)
    for (const e of data.recentOther) lines.push(renderOtherLine(e))
    lines.push("")
  }

  if (data.agentLearnings) {
    lines.push("### Agent Learnings")
    lines.push(data.agentLearnings)
    lines.push("")
  }
  lines.push("_End memory bootstrap. Continue normally._")
  return lines.join("\n")
}

export function prevMonth(date: Date): Date {
  const d = new Date(date)
  d.setMonth(d.getMonth() - 1)
  return d
}

export function mergeNoteBodies(current: string | null, previous: string | null): string {
  if (current && previous) return `${current}\n\n${previous}`
  return current ?? previous ?? ""
}
