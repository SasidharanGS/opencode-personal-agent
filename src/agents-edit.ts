import * as fs from "node:fs/promises"
import * as nodePath from "node:path"
import type { AgentLearningEntry } from "./types.js"
import type { JoplinClient } from "./clients/joplin.js"
import { agentLearningsNoteName } from "./reflect.js"

const LLM_BASE  = process.env.OPENCODE_PA_LLM_URL   ?? "http://127.0.0.1:8889/v1"
const LLM_KEY   = process.env.OPENCODE_PA_LLM_KEY   ?? "1"
const LLM_MODEL = process.env.OPENCODE_PA_LLM_MODEL ?? "CLAUDE_4_6_SONNET"

const AGENT_LEARNINGS_SKELETON = `# Agent Learnings

> Auto-maintained by opencode personal-agent. Do not edit manually.
> Last updated: {DATE}

## Table of Contents

- [Behavioral Rules](#behavioral-rules)
- [Preferences](#preferences)
- [Project-Specific](#project-specific)

---

## Behavioral Rules

Rules the agent must follow, learned from corrections across sessions.

---

## Preferences

User preferences that shape how the agent works.

---

## Project-Specific

Rules that apply only within specific projects.
`

export function findAgentLearnings(noteBody: string): AgentLearningEntry[] {
  if (!noteBody.trim()) return []
  const sections = noteBody.split(/\n(?=## )/)
  const results: AgentLearningEntry[] = []
  for (const section of sections) {
    const statusMatch = section.match(/\*\*Status\*\*: (\S+)/)
    if (!statusMatch || statusMatch[1] !== "proposed_agents_edit") continue
    const observedMatch = section.match(/\*\*Observed\*\*: (.+)/)
    const typeMatch = section.match(/\*\*Type\*\*: (\S+)/)
    const countMatch = section.match(/\*\*Cross-session count\*\*: (\d+)/)
    const projectMatch = section.match(/\*\*Project\*\*: (.+)/)
    if (!observedMatch) continue
    results.push({
      observed: observedMatch[1].trim(),
      type: typeMatch?.[1]?.trim() ?? "behavior_correction",
      crossSessionCount: countMatch ? parseInt(countMatch[1], 10) : 1,
      projectTag: projectMatch ? projectMatch[1].trim() : null,
      status: "proposed_agents_edit",
    })
  }
  return results
}

export function markLearningStatus(
  body: string,
  observed: string,
  status: "applied" | "skipped",
): string {
  const sectionStart = body.indexOf(`**Observed**: ${observed}`)
  if (sectionStart === -1) return body
  const prevHeading = body.lastIndexOf("\n## ", sectionStart)
  const start = prevHeading === -1 ? 0 : prevHeading
  const nextSection = body.indexOf("\n## ", sectionStart)
  const end = nextSection === -1 ? body.length : nextSection
  const section = body.slice(start, end)
  const updated = section.replace("**Status**: proposed_agents_edit", `**Status**: ${status}`)
  return body.slice(0, start) + updated + body.slice(end)
}

export function buildAgentsMdPrompt(
  entry: AgentLearningEntry,
  existingContent: string,
  editInstruction?: string,
): string {
  const editNote = editInstruction
    ? `\n\nUser edit instruction: "${editInstruction}". Incorporate this into your output.`
    : ""

  const existingNote = existingContent
    ? `\n\nCurrent file content:\n${existingContent}`
    : "\n\nThe file does not exist yet — produce a full file using the skeleton structure."

  return `You are maintaining agent-learnings.md, a structured markdown file that records behavioral rules and preferences for an AI coding agent.

New learning to incorporate:
- Observed: ${entry.observed}
- Type: ${entry.type}
- Cross-session count: ${entry.crossSessionCount}
- Project tag: ${entry.projectTag ?? "none (global)"}${editNote}${existingNote}

Instructions:
1. If the existing file is empty or missing, output the full file using this skeleton:
   - # Agent Learnings header with "Auto-maintained" note and today's date
   - ## Behavioral Rules section (for behavior_correction type)
   - ## Preferences section (for preference_expressed type)
   - ## Project-Specific section (for entries with a project tag)
   - Table of Contents linking to each section

2. If the file already exists:
   - Add the new learning to the correct section based on type
   - If a similar entry already exists, update it instead of duplicating
   - Update the "Last updated" date
   - Keep all existing entries intact

3. Format each entry as:
   ### <short title from observed>
   - **Learned**: <date>
   - **Evidence**: Corrected/expressed <N> times across sessions
   - **Rule** or **Preference**: <concise actionable rule>

4. Output ONLY the complete file content, no prose before or after.`
}

export function patchAgentLearningsFile(
  existingContent: string,
  llmPatch: string,
): string {
  if (!existingContent.trim()) {
    const skeleton = AGENT_LEARNINGS_SKELETON.replace("{DATE}", new Date().toISOString().slice(0, 10))
    return skeleton + "\n" + llmPatch
  }
  return llmPatch
}

export function resolveAgentLearningsPath(
  scope: "global" | "project",
  cwd: string,
  home: string,
): string {
  if (scope === "global") {
    return nodePath.join(home, ".config", "opencode", "agent-learnings.md")
  }
  return nodePath.join(cwd, "agent-learnings.md")
}

async function generatePatch(
  entry: AgentLearningEntry,
  existingContent: string,
  editInstruction?: string,
): Promise<string> {
  const response = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LLM_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: "user", content: buildAgentsMdPrompt(entry, existingContent, editInstruction) }],
      max_tokens: 1200,
    }),
  })
  if (!response.ok) throw new Error(`LLM error: ${response.status}`)
  const data = await response.json() as any
  return data.choices?.[0]?.message?.content?.trim() ?? ""
}

export async function runAgentsEdit(
  args: string,
  sessionId: string,
  cwd: string,
  joplin: JoplinClient,
  pendingAgentsEdits: Set<string>,
): Promise<string> {
  const parts = args.trim().split(/\s+/)
  const confirmFlag = parts.includes("--confirm")
  const skipFlag = parts.includes("--skip")
  const scopeFlag = parts.find(p => p.startsWith("--scope="))
  const editFlag = args.match(/--edit="([^"]*)"/)
  const editInstruction = editFlag?.[1]
  const name = parts.filter(p => !p.startsWith("--") && !p.startsWith('"')).join(" ").trim()

  if (!name) {
    return "Usage: /agents-edit <name>  or  /agents-edit <name> --scope=global --confirm"
  }

  const now = new Date()
  const learningsNote = await joplin.getNote(agentLearningsNoteName(now))
  if (!learningsNote?.body) {
    return "Can't read Agent Learnings from Joplin. Is Joplin running?"
  }

  const entries = findAgentLearnings(learningsNote.body)
  const lowerName = name.toLowerCase()
  const entry = entries.find(e => e.observed === name) ??
    entries.find(e => e.observed.toLowerCase().includes(lowerName)) ??
    null

  if (!entry) {
    return `No proposed agent learning matching '${name}'. Run /wrap to see candidates.`
  }

  if (skipFlag) {
    try {
      const updatedBody = markLearningStatus(learningsNote.body, entry.observed, "skipped")
      await joplin.updateNote(learningsNote.id, updatedBody)
    } catch {
      // non-fatal
    }
    pendingAgentsEdits.delete(entry.observed)
    return "Skipped. Won't propose again."
  }

  if (confirmFlag && scopeFlag) {
    const scope = scopeFlag.replace("--scope=", "") as "global" | "project"
    if (scope !== "global" && scope !== "project") {
      return `Invalid scope '${scope}'. Use --scope=global or --scope=project.`
    }
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp"
    const filePath = resolveAgentLearningsPath(scope, cwd, home)

    let existingContent = ""
    try {
      existingContent = await fs.readFile(filePath, "utf-8")
    } catch {
      // file doesn't exist yet — start fresh
    }

    let patch: string
    try {
      patch = await generatePatch(entry, existingContent, editInstruction)
    } catch (err) {
      return `LLM unavailable — can't generate patch. Try again when endpoint is up. (${String(err)})`
    }

    if (!patch) return "LLM returned empty patch. Try again."

    const finalContent = patchAgentLearningsFile(existingContent, patch)

    try {
      const dir = nodePath.dirname(filePath)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(filePath, finalContent, "utf-8")
    } catch (err) {
      return `File write failed at ${filePath}: ${String(err)}\n\nPatch content:\n\n${finalContent}`
    }

    try {
      const updatedBody = markLearningStatus(learningsNote.body, entry.observed, "applied")
      await joplin.updateNote(learningsNote.id, updatedBody)
    } catch {
      // Joplin write failure is non-fatal — file already written
    }

    pendingAgentsEdits.delete(entry.observed)
    return `Written to ${filePath}. Agent learnings updated.`
  }

  // Preview mode — generate patch and return AGENTS_EDIT_CANDIDATE block
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp"
  const globalPath = resolveAgentLearningsPath("global", cwd, home)
  const projectPath = resolveAgentLearningsPath("project", cwd, home)

  let existingContent = ""
  try {
    existingContent = await fs.readFile(globalPath, "utf-8")
  } catch {
    // file doesn't exist yet
  }

  let patch: string
  try {
    patch = await generatePatch(entry, existingContent)
  } catch (err) {
    return `LLM unavailable — can't generate patch. Try again when endpoint is up. (${String(err)})`
  }

  if (!patch) return "LLM returned empty patch. Try again."

  return [
    "AGENTS_EDIT_CANDIDATE",
    `observed: ${entry.observed}`,
    `type: ${entry.type}`,
    `cross_session_count: ${entry.crossSessionCount}`,
    `global_path: ${globalPath}`,
    `project_path: ${projectPath}`,
    "---PATCH---",
    patch,
  ].join("\n")
}
