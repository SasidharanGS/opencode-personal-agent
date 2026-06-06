import type {
  ReflectionResult, ReflectionDecision, ReflectionMemory,
  ReflectionLearning, SessionState,
} from "./types.js"
import { JoplinClient } from "./clients/joplin.js"
import { formatTranscript, trimTranscript, getTranscript } from "./transcript.js"
import { decisionsNoteName, memoriesNoteName } from "./bootstrap.js"

const LLM_BASE  = process.env.OPENCODE_PA_LLM_URL   ?? "http://127.0.0.1:8889/v1"
const LLM_KEY   = process.env.OPENCODE_PA_LLM_KEY   ?? "1"
const LLM_MODEL = process.env.OPENCODE_PA_LLM_MODEL ?? "CLAUDE_4_6_SONNET"
const JOPLIN_NOTEBOOK     = process.env.OPENCODE_PA_JOPLIN_NOTEBOOK ?? "Second Brain"
const CONFIDENCE_THRESHOLD = 0.6

const REFLECTION_SYSTEM_PROMPT = `You are the reflection module of a personal AI agent. You read a session transcript and emit JSON describing what should be remembered.

Output schema (strict JSON, no prose):
{
  "decisions": [{"title":"<short>","context":"<what was being worked on>","decision":"<chosen path>","rationale":"<why this over alternatives>","rejected":["<alt with one-line why>"],"project_tag":"<tag or null>","confidence":0.0,"significance":5}],
  "memories": [{"title":"<short>","what_happened":"<single paragraph>","significance_text":"<one line qualitative>","files_touched":["<path>"],"loose_ends":["<line>"],"project_tag":"<tag or null>","confidence":0.0,"significance":5}],
  "agent_learnings": [{"type":"behavior_correction","observed":"<what happened>","evidence_message_indices":[0],"proposed_action":"AGENTS.md edit","confidence":0.0,"significance":5}]
}

Rules:
- A decision requires a rejected alternative. Otherwise it is a memory.
- agent_learnings only when user CORRECTED the agent or expressed a preference. Not routine work.
- confidence >= 0.6 means worth writing. Plugin drops items below 0.6.
- significance is an integer 1-10. 1 = trivial, 10 = pivotal. Default 5 if unsure.
   Reserve 8+ for entries that will still matter weeks later (architectural decisions,
   recurring patterns, hard-won bug root causes). Reserve <=3 for routine work.
- Output only NEW items from this session. If nothing notable happened, return empty arrays.`

export function parseReflectionJson(raw: string): ReflectionResult {
  const empty: ReflectionResult = { decisions: [], memories: [], agent_learnings: [] }
  if (!raw.trim()) return empty
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return empty
    try { parsed = JSON.parse(match[0]) } catch { return empty }
  }
  if (!parsed || typeof parsed !== "object") return empty
  const clampSig = (v: any): number => {
    const n = Number(v)
    if (!Number.isFinite(n)) return 5
    return Math.max(1, Math.min(10, Math.round(n)))
  }
  const decisions: ReflectionDecision[] = (Array.isArray(parsed.decisions) ? parsed.decisions : [])
    .filter((d: any) => d && typeof d === "object" && (d.confidence ?? 0) >= CONFIDENCE_THRESHOLD)
    .map((d: any) => ({ ...d, significance: clampSig(d.significance) }))
  // v1 LLM emits significance as a string (e.g. "Notable"); v2 emits a number.
  // clampSig defaults to 5 for non-numeric input, so v1 strings are safe.
  // significance_text falls back to significance (v1 string) until v2 is the only prompt.
  const memories: ReflectionMemory[] = (Array.isArray(parsed.memories) ? parsed.memories : [])
    .filter((m: any) => m && typeof m === "object" && (m.confidence ?? 0) >= CONFIDENCE_THRESHOLD)
    .map((m: any) => ({ ...m, significance_text: m.significance_text ?? m.significance ?? "", significance: clampSig(m.significance) }))
  const agent_learnings: ReflectionLearning[] = (Array.isArray(parsed.agent_learnings) ? parsed.agent_learnings : [])
    .filter((l: any) => l && typeof l === "object")
    .map((l: any) => ({ ...l, significance: clampSig(l.significance) }))
  return { decisions, memories, agent_learnings }
}

export function renderDecision(d: ReflectionDecision, now: Date, _sessionId = "unknown"): string {
  const ts = now.toISOString().slice(0, 16).replace("T", " ")
  const proj = d.project_tag ?? "general"
  const lines = [
    `## ${ts} \u2014 ${d.title}`,
    `proj: ${proj} \u00b7 sig: ${d.significance}`,
    `why: ${d.context}`,
    `chose: ${d.decision}`,
  ]
  if (d.rejected.length > 0) {
    lines.push(`vs: ${d.rejected.join("; ")}`)
  }
  return lines.join("\n")
}

export function renderMemory(m: ReflectionMemory, now: Date, _sessionId = "unknown"): string {
  const ts = now.toISOString().slice(0, 16).replace("T", " ")
  const proj = m.project_tag ?? "general"
  const lines = [
    `## ${ts} \u2014 ${m.title}`,
    `proj: ${proj} \u00b7 sig: ${m.significance}`,
    `why: ${m.what_happened}`,
    `did: ${m.significance_text}`,
  ]
  if (m.files_touched.length > 0) {
    lines.push(`files: ${m.files_touched.join(", ")}`)
  }
  if (m.loose_ends.length > 0) {
    lines.push(`loose: ${m.loose_ends.join(", ")}`)
  }
  return lines.join("\n")
}

export function renderLearning(
  l: ReflectionLearning,
  now: Date,
  crossSessionCount: number,
  _sessionId: string,
): string {
  const ts = now.toISOString().slice(0, 16).replace("T", " ")
  const status = crossSessionCount >= 2 ? "proposed_agents_edit" : "pending_more_evidence"
  return [
    `## ${ts} \u2014 ${l.observed.slice(0, 60)}`,
    `type: ${l.type} \u00b7 sig: ${l.significance} \u00b7 seen: ${crossSessionCount}`,
    `observed: ${l.observed}`,
    `action: ${l.proposed_action} (${status})`,
  ].join("\n")
}

export function agentLearningsNoteName(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  return `Agent Learnings \u2014 ${y}-${m}`
}

async function countCrossSessionLearnings(joplin: JoplinClient, observed: string): Promise<number> {
  // Search for notes whose body contains a learning entry with this observation.
  // Use a short keyword to avoid Joplin query operator issues with special chars.
  const keyword = observed.replace(/[^a-zA-Z0-9\s]/g, " ").trim().split(/\s+/).slice(0, 5).join(" ")
  if (!keyword) return 1
  const notes = await joplin.searchNotes(keyword, 20)
  // Count entries across all Agent Learnings notes that contain this observation
  return notes.filter(n =>
    n.title.startsWith("Agent Learnings") &&
    n.body.includes(observed.slice(0, 30))
  ).length + 1  // +1 for the current session (not yet written)
}

export async function reflect(
  state: SessionState,
  client: any,
  joplin: JoplinClient,
): Promise<void> {
  const now = new Date()

  const rawTurns = await getTranscript(client, state.sessionId)
  const turns = trimTranscript(rawTurns, 30, 8000)
  if (turns.length === 0) return

  const transcript = formatTranscript(turns)

  let raw = ""
  try {
    const res = await fetch(`${LLM_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LLM_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: REFLECTION_SYSTEM_PROMPT },
          { role: "user",   content: transcript },
        ],
        // response_format is OpenAI-specific; ignored by some endpoints.
        // parseReflectionJson's regex fallback handles prose-wrapped JSON.
        response_format: { type: "json_object" },
        max_tokens: 2000,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      await client.app.log({ body: { service: "personal-agent", level: "warn", message: `reflect: LLM ${res.status}`, extra: {} } })
      return
    }
    const json = await res.json() as any
    raw = json?.choices?.[0]?.message?.content ?? ""
  } catch (err) {
    await client.app.log({ body: { service: "personal-agent", level: "warn", message: "reflect: LLM error", extra: { error: String(err) } } })
    return
  }

  const result = parseReflectionJson(raw)

  for (const d of result.decisions) {
    await joplin.appendToNote(decisionsNoteName(now), renderDecision(d, now, state.sessionId), JOPLIN_NOTEBOOK)
  }

  for (const m of result.memories) {
    await joplin.appendToNote(memoriesNoteName(now), renderMemory(m, now, state.sessionId), JOPLIN_NOTEBOOK)
  }

  const learningNoteName = agentLearningsNoteName(now)
  for (const l of result.agent_learnings) {
    // Count prior sessions where this same observation was recorded (best-effort via Joplin search)
    const crossCount = await countCrossSessionLearnings(joplin, l.observed)
    await joplin.appendToNote(learningNoteName, renderLearning(l, now, crossCount, state.sessionId), JOPLIN_NOTEBOOK)
  }

  await client.app.log({
    body: {
      service: "personal-agent",
      level: "info",
      message: `reflect: wrote ${result.decisions.length}d ${result.memories.length}m ${result.agent_learnings.length}l`,
      extra: { sessionId: state.sessionId },
    },
  })

  // Note: state.lastReflectionTs is set optimistically in plugin.ts before this function
  // is called (fire-and-forget pattern) to prevent double-reflection during slow LLM calls.
}
