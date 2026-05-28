export interface SessionState {
  sessionId: string
  startedAt: Date
  lastActivityTs: Date
  lastReflectionTs: Date | null
  toolCalls: ToolCall[]
  patternCandidates: Map<string, number>
  bootstrappedContext: string | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

export interface ToolCall {
  ts: Date
  tool: string
  argsSignature: string
}

export interface JoplinNote {
  id: string
  title: string
  body: string
  updated_time: number
}

export interface JoplinFolder {
  id: string
  title: string
}

export interface BootstrapData {
  projectName: string
  recentDecisions: string[]
  recentMemories: string[]
  projectNotes: string[]
  activitySummary: string | null
}

export interface MemoryActivity {
  app: string
  title?: string
  duration?: number
}
