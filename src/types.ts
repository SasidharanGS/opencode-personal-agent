export interface SessionState {
  sessionId: string
  startedAt: Date
  lastActivityTs: Date
  lastReflectionTs: Date | null
  toolCalls: ToolCall[]
  patternCandidates: Map<string, number>
  pendingPromotions: Set<string>
  pendingAgentsEdits: Set<string>
  bootstrappedContext: string | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

export interface ToolCall {
  ts: Date
  tool: string
  argsSignature: string
}

export interface PatternCandidate {
  sig: string
  tool: string
  hits: number
}

// Parsed from Joplin Agent Learnings note body. Fields are string (not union types)
// because the source is LLM-written Joplin text — values may vary slightly.
export interface AgentLearningEntry {
  observed: string
  type: string              // "behavior_correction" | "preference_expressed"
  crossSessionCount: number
  projectTag: string | null
  status: string            // "proposed_agents_edit" | "pending_more_evidence" | "applied" | "skipped"
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

export interface JoplinTag {
  id: string
  title: string
}

export interface BootstrapData {
  projectName: string
  recentDecisions: string[]
  recentMemories: string[]
  projectNotes: string[]
  activitySummary: string | null
  agentLearnings: string | null    // raw content of agent-learnings.md injected into system prompt
}

export interface MemoryActivity {
  app: string
  title?: string
  duration?: number
}

export interface ReflectionDecision {
  title: string
  context: string
  decision: string
  rationale: string
  rejected: string[]
  project_tag: string | null
  confidence: number
}

export interface ReflectionMemory {
  title: string
  what_happened: string
  significance: string
  files_touched: string[]
  loose_ends: string[]
  project_tag: string | null
  confidence: number
}

export interface ReflectionLearning {
  type: "behavior_correction" | "preference_expressed"
  observed: string
  evidence_message_indices: number[]
  proposed_action: "AGENTS.md edit" | "skill" | "behavior only"
  confidence: number
}

export interface ReflectionResult {
  decisions: ReflectionDecision[]
  memories: ReflectionMemory[]
  agent_learnings: ReflectionLearning[]
}

export interface TranscriptTurn {
  role: "user" | "assistant"
  text: string
}
