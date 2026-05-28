import type { PatternCandidate } from "./types.js"
import type { JoplinClient } from "./clients/joplin.js"

const PATTERN_THRESHOLD = 3

export function detectPatterns(
  candidates: Map<string, number>,
  alreadyProposed: Set<string>,
  threshold = PATTERN_THRESHOLD,
): PatternCandidate[] {
  const result: PatternCandidate[] = []
  for (const [sig, hits] of candidates) {
    if (hits < threshold) continue
    if (alreadyProposed.has(sig)) continue
    const tool = sig.split(":")[0] ?? sig
    result.push({ sig, tool, hits })
  }
  return result
}

export function skillsProposedEntry(candidate: PatternCandidate, now: Date): string {
  const ts = now.toISOString().slice(0, 10)
  return [
    `## ${candidate.sig} — proposed`,
    "",
    `**Tool**: ${candidate.tool}`,
    `**Hits this session**: ${candidate.hits}`,
    `**Status**: pending`,
    `**Proposed**: ${ts}`,
    "",
    "---",
  ].join("\n")
}

export function markPromoted(body: string, sig: string): string {
  const sectionStart = body.indexOf(`## ${sig} — proposed`)
  if (sectionStart === -1) return body
  const nextSection = body.indexOf("\n## ", sectionStart + 1)
  const sectionEnd = nextSection === -1 ? body.length : nextSection
  const section = body.slice(sectionStart, sectionEnd)
  const updated = section.replace("**Status**: pending", "**Status**: promoted")
  return body.slice(0, sectionStart) + updated + body.slice(sectionEnd)
}

export async function writeNewPatterns(
  candidates: PatternCandidate[],
  joplin: JoplinClient,
): Promise<void> {
  if (candidates.length === 0) return
  const existing = await joplin.getNote("Skills Proposed")
  const existingBody = existing?.body ?? ""
  const alreadyInNote = new Set(
    [...existingBody.matchAll(/^## (.+?) — proposed/gm)].map(m => m[1])
  )
  const newEntries = candidates
    .filter(c => !alreadyInNote.has(c.sig))
    .map(c => skillsProposedEntry(c, new Date()))
    .join("\n")
  if (!newEntries) return
  await joplin.appendToNote("Skills Proposed", "\n" + newEntries)
}
