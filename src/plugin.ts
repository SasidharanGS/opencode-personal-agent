import type { Plugin } from "@opencode-ai/plugin"
import { detectProject, decisionsNoteName, memoriesNoteName, composeBootstrapMessage } from "./bootstrap.js"
import { JoplinClient } from "./clients/joplin.js"
import { MemoryClient } from "./clients/memory.js"
import { normalizeArgs } from "./normalizer.js"
import { detectPatterns, writeNewPatterns } from "./patterns.js"
import { reflect } from "./reflect.js"
import { runPromote } from "./promote.js"
import { runWrap } from "./wrap.js"
import type { SessionState, BootstrapData } from "./types.js"

const JOPLIN_URL      = `http://127.0.0.1:${process.env.JOPLIN_PORT ?? "41184"}`
const JOPLIN_TOKEN    = process.env.OPENCODE_PA_JOPLIN_TOKEN ?? process.env.JOPLIN_TOKEN ?? ""
const MEMORY_BASE     = process.env.OPENCODE_PA_MEMORY_URL ?? null
const JOPLIN_NOTEBOOK = process.env.OPENCODE_PA_JOPLIN_NOTEBOOK ?? "Second Brain"
const PROJECT_MAP: Record<string, string> = (() => {
  try { return JSON.parse(process.env.OPENCODE_PA_PROJECT_MAP ?? "{}") } catch { return {} }
})()
const IDLE_THRESHOLD_MS        = Number(process.env.OPENCODE_PA_IDLE_MS   ?? 180_000)
const REFLECTION_DEDUPE_WINDOW = Number(process.env.OPENCODE_PA_DEDUPE_MS ?? 120_000)
const PATTERN_THRESHOLD = Number(process.env.OPENCODE_PA_PATTERN_THRESHOLD ?? 3)

const sessions = new Map<string, SessionState>()

export const PersonalAgent: Plugin = async ({ client }) => {
  const joplin = new JoplinClient(JOPLIN_URL, JOPLIN_TOKEN)
  const memory = new MemoryClient(MEMORY_BASE)

  return {
    "event": async ({ event }) => {
      if (event.type === "session.created") {
        // event.properties.info follows the Session type from @opencode-ai/sdk
        // Accessed via `any` because the plugin's Event union type doesn't expose
        // the session.created properties shape in the current SDK version.
        const info = (event as any).properties?.info
        const sessionId: string = info?.id ?? "unknown"
        const directory: string = info?.directory ?? ""

        if (sessionId === "unknown") {
          await client.app.log({
            body: { service: "personal-agent", level: "warn", message: "session.created event missing session ID — skipping bootstrap", extra: {} },
          })
          return
        }

        const state: SessionState = {
          sessionId,
          startedAt: new Date(),
          lastActivityTs: new Date(),
          lastReflectionTs: null,
          toolCalls: [],
          patternCandidates: new Map(),
          pendingPromotions: new Set(),
          bootstrappedContext: null,
          idleTimer: null,
        }
        sessions.set(sessionId, state)

        await client.app.log({
          body: { service: "personal-agent", level: "info", message: "session started", extra: { sessionId } },
        })

        gatherBootstrapData(joplin, memory, directory).then(async (data) => {
          if (!sessions.has(sessionId)) return
          state.bootstrappedContext = composeBootstrapMessage(data)
          await client.app.log({
            body: {
              service: "personal-agent",
              level: "info",
              message: `bootstrapped session ${sessionId} with ${data.recentDecisions.length} decisions, ${data.recentMemories.length} memories`,
              extra: { project: data.projectName },
            },
          })
        }).catch(async (err) => {
          await client.app.log({
            body: { service: "personal-agent", level: "warn", message: "bootstrap failed", extra: { error: String(err) } },
          })
        })
      }

      if (event.type === "session.deleted") {
        const sessionId: string = (event as any).properties?.info?.id ?? "unknown"
        if (sessionId === "unknown") return
        const state = sessions.get(sessionId)
        if (state?.idleTimer) clearTimeout(state.idleTimer)
        sessions.delete(sessionId)
      }

      if (event.type === "session.idle") {
        const sessionId: string = (event as any).properties?.info?.id ?? "unknown"
        if (sessionId === "unknown") return
        const state = sessions.get(sessionId)
        if (!state) return

        state.lastActivityTs = new Date()

        if (state.idleTimer) clearTimeout(state.idleTimer)
        state.idleTimer = setTimeout(() => {
          const s = sessions.get(sessionId)
          if (!s) return  // session was deleted (and timer was cancelled) before callback ran
          if (Date.now() - s.lastActivityTs.getTime() < IDLE_THRESHOLD_MS) return
          if (s.lastReflectionTs && Date.now() - s.lastReflectionTs.getTime() < REFLECTION_DEDUPE_WINDOW) return

          s.lastReflectionTs = new Date()
          reflect(s, client, joplin).then(async () => {
            const skillsNote = await joplin.getNote("Skills Proposed")
            const alreadyProposed = new Set(
              [...(skillsNote?.body ?? "").matchAll(/^## (.+?) — proposed/gm)].map((m: RegExpMatchArray) => m[1])
            )
            const candidates = detectPatterns(s.patternCandidates, alreadyProposed)
            await writeNewPatterns(candidates, joplin, JOPLIN_NOTEBOOK)
          }).catch(async (err) => {
            await client.app.log({ body: { service: "personal-agent", level: "warn", message: "reflect/pattern error", extra: { error: String(err) } } })
          })
        }, IDLE_THRESHOLD_MS)
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionId = input.sessionID
      if (!sessionId) return
      const state = sessions.get(sessionId)
      if (state?.bootstrappedContext) {
        output.system.push(state.bootstrappedContext)
      }
      if (state && state.pendingPromotions.size > 0) {
        const sigs = [...state.pendingPromotions].join(", ")
        output.system.push(
          `[personal-agent] Pattern nudge: the following tool patterns have repeated 3+ times this session and are ready to promote into skills: ${sigs}. Proactively mention this to the user and offer to run /promote.`
        )
      }
    },

    "experimental.session.compacting": async (input, output) => {
      const state = sessions.get(input.sessionID)
      if (state?.bootstrappedContext) {
        output.context.push(state.bootstrappedContext)
      }
    },

    "tool.execute.before": async (input, output) => {
      const state = sessions.get(input.sessionID)
      if (!state) return
      state.lastActivityTs = new Date()
      const sig = normalizeArgs(input.tool, output.args)
      state.toolCalls.push({ ts: new Date(), tool: input.tool, argsSignature: sig })
      if (state.toolCalls.length > 200) state.toolCalls.shift()
      const newCount = (state.patternCandidates.get(sig) ?? 0) + 1
      state.patternCandidates.set(sig, newCount)
      if (newCount === PATTERN_THRESHOLD && !state.pendingPromotions.has(sig)) {
        state.pendingPromotions.add(sig)
        await client.app.log({
          body: { service: "personal-agent", level: "info", message: `pattern flagged: ${sig}`, extra: { hits: newCount } },
        })
      }
    },

    "tool.execute.after": async (input, _output) => {
      const state = sessions.get(input.sessionID)
      if (state) state.lastActivityTs = new Date()
    },

    "command.execute.before": async (input, output) => {
      if (input.command === "wrap") {
        const state = sessions.get(input.sessionID)
        if (!state) {
          output.parts.push({ type: "text", text: "personal-agent: no session state found for /wrap" } as any)
          return
        }
        try {
          const summary = await runWrap(state, client, joplin)
          output.parts.push({ type: "text", text: summary } as any)
        } catch (err) {
          output.parts.push({ type: "text", text: `personal-agent: /wrap failed — ${String(err)}` } as any)
        }
        return
      }

      if (input.command === "promote") {
        const state = sessions.get(input.sessionID)
        const args = (input as any).args ?? ""
        const cwd = (state as any)?.cwd ?? process.cwd()
        try {
          const result = await runPromote(
            args,
            input.sessionID,
            cwd,
            joplin,
            state?.pendingPromotions ?? new Set(),
          )
          output.parts.push({ type: "text", text: result } as any)
        } catch (err) {
          output.parts.push({ type: "text", text: `personal-agent: /promote failed — ${String(err)}` } as any)
        }
        return
      }
    },
  }
}

async function gatherBootstrapData(
  joplin: JoplinClient,
  memory: MemoryClient,
  cwd: string,
): Promise<BootstrapData> {
  const now = new Date()
  const projectName = detectProject(cwd, PROJECT_MAP)
  const [decisionsNote, memoriesNote, projectNotes, activities] = await Promise.all([
    joplin.getNote(decisionsNoteName(now)),
    joplin.getNote(memoriesNoteName(now)),
    joplin.searchNotes(`+${projectName}`, 5),
    memory.getTodayActivities(),
  ])
  return {
    projectName,
    recentDecisions: decisionsNote ? JoplinClient.parseDecisionLines(decisionsNote.body, 7, now) : [],
    recentMemories: memoriesNote ? JoplinClient.parseDecisionLines(memoriesNote.body, 7, now) : [],
    projectNotes: projectNotes.slice(0, 5).map(n => `${n.title} \u2014 ${n.body.slice(0, 80).replace(/\n/g, " ")}`),
    activitySummary: activities ? MemoryClient.summarizeActivities(activities) : null,
  }
}
