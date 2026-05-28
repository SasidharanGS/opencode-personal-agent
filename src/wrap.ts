import type { SessionState } from "./types.js"
import type { JoplinClient } from "./clients/joplin.js"
import { reflect, agentLearningsNoteName } from "./reflect.js"
import { decisionsNoteName, memoriesNoteName } from "./bootstrap.js"

const AGENTS_MD_THRESHOLD = 2

export interface WrapData {
  savedDecisions: string[]
  savedMemories: string[]
  skillCandidates: Array<{ name: string; hits: number }>
  agentsMdProposals: Array<{ observed: string; crossSessionCount: number }>
  reflectError: string | null
}

export function formatWrapSummary(data: WrapData, monthKey: string, now: Date): string {
  const ts = now.toISOString().slice(0, 10)
  const lines: string[] = [`\u2550\u2550\u2550\u2550\u2550 Session wrap-up \u2014 ${ts} \u2550\u2550\u2550\u2550\u2550`, ""]

  if (data.reflectError) {
    lines.push(`\u26a0 Reflection failed: ${data.reflectError}`)
    lines.push("  (pending lists below are from prior saves only)")
    lines.push("")
  }

  if (data.savedDecisions.length > 0) {
    const n = data.savedDecisions.length
    lines.push(`\u2713 Saved to Joplin "Decisions \u2014 ${monthKey}" (${n} ${n === 1 ? "entry" : "entries"}):`)
    for (const d of data.savedDecisions) lines.push(`  \u2022 ${d}`)
    lines.push("")
  }

  if (data.savedMemories.length > 0) {
    const n = data.savedMemories.length
    lines.push(`\u2713 Saved to Joplin "Memories \u2014 ${monthKey}" (${n} ${n === 1 ? "entry" : "entries"}):`)
    for (const m of data.savedMemories) lines.push(`  \u2022 ${m}`)
    lines.push("")
  }

  if (data.skillCandidates.length > 0) {
    const n = data.skillCandidates.length
    lines.push(`\u26a0 ${n} skill candidate${n > 1 ? "s" : ""} awaiting your decision:`)
    for (const c of data.skillCandidates) {
      lines.push(`  \u2022 ${c.name}   (${c.hits} hits this session)`)
      lines.push(`    \u2192 Run /promote ${c.name} to convert, or ignore.`)
    }
    lines.push("")
  }

  if (data.agentsMdProposals.length > 0) {
    const n = data.agentsMdProposals.length
    lines.push(`\u26a0 ${n} AGENTS.md proposal${n > 1 ? "s" : ""} (cross-session evidence):`)
    for (const p of data.agentsMdProposals) {
      lines.push(`  \u2022 "${p.observed.slice(0, 60)}"  (${p.crossSessionCount} sessions)`)
      lines.push(`    \u2192 Run /agents-edit to review the diff, or ignore.`)
    }
    lines.push("")
  }

  const hasSomething = data.savedDecisions.length > 0 || data.savedMemories.length > 0 ||
    data.skillCandidates.length > 0 || data.agentsMdProposals.length > 0 || data.reflectError
  if (!hasSomething) lines.push("Nothing else flagged.")

  return lines.join("\n")
}

function extractNewHeadings(before: string, after: string): string[] {
  const re = /^## .+ \u2014 (.+)$/gm
  const beforeSet = new Set([...before.matchAll(re)].map(m => m[1]))
  return [...after.matchAll(re)].map(m => m[1]).filter(h => !beforeSet.has(h))
}

export async function runWrap(
  state: SessionState,
  client: any,
  joplin: JoplinClient,
): Promise<string> {
  const now = new Date()
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`

  let reflectError: string | null = null
  const savedDecisions: string[] = []
  const savedMemories: string[] = []

  try {
    const [decisionsBefore, memoriesBefore] = await Promise.all([
      joplin.getNote(decisionsNoteName(now)),
      joplin.getNote(memoriesNoteName(now)),
    ])
    await reflect(state, client, joplin)
    const [decisionsAfter, memoriesAfter] = await Promise.all([
      joplin.getNote(decisionsNoteName(now)),
      joplin.getNote(memoriesNoteName(now)),
    ])
    savedDecisions.push(...extractNewHeadings(decisionsBefore?.body ?? "", decisionsAfter?.body ?? ""))
    savedMemories.push(...extractNewHeadings(memoriesBefore?.body ?? "", memoriesAfter?.body ?? ""))
  } catch (err) {
    reflectError = String(err)
  }

  const skillCandidates: WrapData["skillCandidates"] = []
  const skillsNote = await joplin.getNote("Skills Proposed")
  if (skillsNote?.body) {
    for (const m of skillsNote.body.matchAll(/^## ([^\s\u2014]+) \u2014 proposed/gm)) {
      const name = m[1]
      const hitsMatch = skillsNote.body.match(new RegExp(`## ${name}[\\s\\S]*?\\*\\*Hits this session\\*\\*: (\\d+)`))
      const promoted = /Status: promoted/.test(skillsNote.body.split(`## ${name}`)[1] ?? "")
      if (!promoted) skillCandidates.push({ name, hits: hitsMatch ? parseInt(hitsMatch[1], 10) : 0 })
    }
  }

  const agentsMdProposals: WrapData["agentsMdProposals"] = []
  const learningsNote = await joplin.getNote(agentLearningsNoteName(now))
  if (learningsNote?.body) {
    for (const section of learningsNote.body.split(/^---$/m)) {
      if (!section.includes("AGENTS.md edit") && !section.includes("proposed_agents_edit")) continue
      const obs = section.match(/\*\*Observed\*\*: (.+)/)
      const cnt = section.match(/\*\*Cross-session count\*\*: (\d+)/)
      if (!obs || !cnt) continue
      const count = parseInt(cnt[1], 10)
      if (count >= AGENTS_MD_THRESHOLD) agentsMdProposals.push({ observed: obs[1].trim(), crossSessionCount: count })
    }
  }

  return formatWrapSummary({ savedDecisions, savedMemories, skillCandidates, agentsMdProposals, reflectError }, monthKey, now)
}
