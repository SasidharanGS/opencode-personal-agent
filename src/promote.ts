import * as fs from "node:fs/promises"
import * as nodePath from "node:path"
import type { PatternCandidate } from "./types.js"
import type { JoplinClient } from "./clients/joplin.js"
import { markPromoted } from "./patterns.js"

const LLM_BASE  = process.env.OPENCODE_PA_LLM_URL   ?? "http://127.0.0.1:8889/v1"
const LLM_KEY   = process.env.OPENCODE_PA_LLM_KEY   ?? "1"
const LLM_MODEL = process.env.OPENCODE_PA_LLM_MODEL ?? "CLAUDE_4_6_SONNET"

export function findCandidate(noteBody: string, name: string): PatternCandidate | null {
  const sections = noteBody.split(/\n(?=## )/)
  const pending = sections.filter(s => s.includes("**Status**: pending"))

  for (const section of pending) {
    const sigMatch = section.match(/^## (.+?) — proposed/)
    if (!sigMatch) continue
    const sig = sigMatch[1]
    if (sig === name) {
      return extractCandidate(section, sig)
    }
  }

  const lowerName = name.toLowerCase()
  for (const section of pending) {
    const sigMatch = section.match(/^## (.+?) — proposed/)
    if (!sigMatch) continue
    const sig = sigMatch[1]
    if (sig.toLowerCase().includes(lowerName)) {
      return extractCandidate(section, sig)
    }
  }

  return null
}

function extractCandidate(section: string, sig: string): PatternCandidate {
  const toolMatch = section.match(/\*\*Tool\*\*: (.+)/)
  const hitsMatch = section.match(/\*\*Hits this session\*\*: (\d+)/)
  return {
    sig,
    tool: toolMatch?.[1]?.trim() ?? sig.split(":")[0] ?? sig,
    hits: hitsMatch ? parseInt(hitsMatch[1], 10) : 0,
  }
}

export function resolveSkillPath(
  name: string,
  scope: "global" | "project",
  cwd: string,
  home: string,
): string {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  if (scope === "global") {
    return nodePath.join(home, ".config", "opencode", "skills", sanitized, "SKILL.md")
  }
  return nodePath.join(cwd, ".opencode", "skills", sanitized, "SKILL.md")
}

export function buildPromotePrompt(candidate: PatternCandidate): string {
  return `You are helping a developer turn a repeated tool pattern into an opencode skill.

Pattern details:
- Signature: ${candidate.sig}
- Tool: ${candidate.tool}
- Times repeated this session: ${candidate.hits}

Write a SKILL.md file for this pattern. The skill should:
1. Have a short title matching the pattern
2. Explain when to use this skill (1-2 sentences)
3. Show the exact command or action to perform
4. Include any important notes or caveats

Format:
# <skill title>

## When to use
<1-2 sentences>

## What it does
<brief description>

## How to use
<exact command or steps>

## Notes
<any caveats>

Output only the SKILL.md content, no prose before or after.`
}

export async function generateSkillMd(candidate: PatternCandidate): Promise<string> {
  const response = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LLM_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "user", content: buildPromotePrompt(candidate) },
      ],
      max_tokens: 600,
    }),
  })
  if (!response.ok) throw new Error(`LLM error: ${response.status}`)
  const data = await response.json() as any
  return data.choices?.[0]?.message?.content?.trim() ?? ""
}

export async function writeSkillFile(path: string, content: string): Promise<void> {
  const dir = nodePath.dirname(path)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path, content, "utf-8")
}

export async function runPromote(
  args: string,
  sessionId: string,
  cwd: string,
  joplin: JoplinClient,
  pendingPromotions: Set<string>,
): Promise<string> {
  const parts = args.trim().split(/\s+/)
  const confirmFlag = parts.includes("--confirm")
  const scopeFlag = parts.find(p => p.startsWith("--scope="))
  const name = parts.filter(p => !p.startsWith("--")).join(" ").trim()

  if (!name) {
    return "Usage: /promote <name>  or  /promote <name> --scope=global --confirm"
  }

  const note = await joplin.getNote("Skills Proposed")
  if (!note?.body) {
    return "No pending skill candidates found. Run a session with repeated tool calls first."
  }

  const candidate = findCandidate(note.body, name)
  if (!candidate) {
    return `No pending skill candidate matching '${name}'. Run /wrap to see candidates.`
  }

  if (confirmFlag && scopeFlag) {
    const scope = scopeFlag.replace("--scope=", "") as "global" | "project"
    if (scope !== "global" && scope !== "project") {
      return `Invalid scope '${scope}'. Use --scope=global or --scope=project.`
    }
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp"
    const skillPath = resolveSkillPath(candidate.sig, scope, cwd, home)

    let draft: string
    try {
      // Re-generates draft — may differ slightly from preview; acceptable for v1
      draft = await generateSkillMd(candidate)
    } catch (err) {
      return `LLM unavailable — can't generate draft. Try again when endpoint is up. (${String(err)})`
    }

    if (!draft) {
      return "LLM returned empty draft. Try again."
    }

    try {
      await writeSkillFile(skillPath, draft)
    } catch (err) {
      return `File write failed at ${skillPath}: ${String(err)}\n\nDraft content:\n\n${draft}`
    }

    try {
      const updatedBody = markPromoted(note.body, candidate.sig)
      const freshNote = await joplin.getNote("Skills Proposed")
      if (freshNote) {
        await joplin.updateNote(freshNote.id, updatedBody)
      }
    } catch {
      // Joplin write failure is non-fatal — skill file already written
    }

    pendingPromotions.delete(candidate.sig)

    return `Written to ${skillPath}. Restart opencode to load the new skill.`
  }

  let draft: string
  try {
    draft = await generateSkillMd(candidate)
  } catch (err) {
    return `LLM unavailable — can't generate draft. Try again when endpoint is up. (${String(err)})`
  }

  if (!draft) {
    return "LLM returned empty draft. Try again."
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp"
  const globalPath = resolveSkillPath(candidate.sig, "global", cwd, home)
  const projectPath = resolveSkillPath(candidate.sig, "project", cwd, home)

  return [
    `PROMOTE_CANDIDATE`,
    `sig: ${candidate.sig}`,
    `tool: ${candidate.tool}`,
    `hits: ${candidate.hits}`,
    `global_path: ${globalPath}`,
    `project_path: ${projectPath}`,
    `---DRAFT---`,
    draft,
  ].join("\n")
}
