import type { Plugin } from "@opencode-ai/plugin"
import { detectProject, decisionsNoteName, memoriesNoteName, composeBootstrapMessage } from "./bootstrap.js"
import { JoplinClient } from "./clients/joplin.js"
import { MemoryClient } from "./clients/memory.js"
import type { SessionState, BootstrapData } from "./types.js"

const JOPLIN_URL      = `http://127.0.0.1:${process.env.JOPLIN_PORT ?? "41184"}`
const JOPLIN_TOKEN    = process.env.OPENCODE_PA_JOPLIN_TOKEN ?? process.env.JOPLIN_TOKEN ?? ""
const MEMORY_BASE     = process.env.OPENCODE_PA_MEMORY_URL ?? null
const JOPLIN_NOTEBOOK = process.env.OPENCODE_PA_JOPLIN_NOTEBOOK ?? "Second Brain"
const PROJECT_MAP: Record<string, string> = (() => {
  try { return JSON.parse(process.env.OPENCODE_PA_PROJECT_MAP ?? "{}") } catch { return {} }
})()

const sessions = new Map<string, SessionState>()

export const PersonalAgent: Plugin = async ({ client }) => {
  const joplin = new JoplinClient(JOPLIN_URL, JOPLIN_TOKEN)
  const memory = new MemoryClient(MEMORY_BASE)

  return {
    "event": async ({ event }) => {
      if (event.type === "session.created") {
        const info = (event as any).properties?.info
        const sessionId: string = info?.id ?? "unknown"
        const directory: string = info?.directory ?? ""

        const state: SessionState = {
          sessionId,
          startedAt: new Date(),
          lastActivityTs: new Date(),
          lastReflectionTs: null,
          toolCalls: [],
          patternCandidates: new Map(),
          bootstrappedContext: null,
          idleTimer: null,
        }
        sessions.set(sessionId, state)

        await client.app.log({
          body: { service: "personal-agent", level: "info", message: "session started", extra: { sessionId } },
        })

        gatherBootstrapData(joplin, memory, directory).then(async (data) => {
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
        const state = sessions.get(sessionId)
        if (state?.idleTimer) clearTimeout(state.idleTimer)
        sessions.delete(sessionId)
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionId = input.sessionID
      if (!sessionId) return
      const state = sessions.get(sessionId)
      if (state?.bootstrappedContext) {
        output.system.push(state.bootstrappedContext)
      }
    },

    "experimental.session.compacting": async (input, output) => {
      const state = sessions.get(input.sessionID)
      if (state?.bootstrappedContext) {
        output.context.push(state.bootstrappedContext)
      }
    },

    "tool.execute.before": async (input, _output) => {
      const state = sessions.get(input.sessionID)
      if (state) state.lastActivityTs = new Date()
    },

    "tool.execute.after": async (input, _output) => {
      const state = sessions.get(input.sessionID)
      if (state) state.lastActivityTs = new Date()
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
