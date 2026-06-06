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
  created_time?: number
}

export interface JoplinFolder {
  id: string
  title: string
}

export interface JoplinTag {
  id: string
  title: string
}

export interface BootstrapEntry {
  date: string         // ISO date "YYYY-MM-DD"
  time: string         // "HH:MM"
  kind: "m" | "d"      // memory or decision
  projectTag: string   // "general" when null
  sig: number          // 1-10, clamped
  title: string
  summary: string      // first sentence of why/did/chose, ~100 chars max
}

export interface BootstrapData {
  projectName: string
  recentActive: BootstrapEntry[]
  recentOther: BootstrapEntry[]
  activitySummary: string | null
  agentLearnings: string | null
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
  significance: number     // 1-10, clamped at parse time, default 5
}

export interface ReflectionMemory {
  title: string
  what_happened: string
  significance_text: string   // renamed from `significance` (string) — qualitative one-liner
  files_touched: string[]
  loose_ends: string[]
  project_tag: string | null
  confidence: number
  significance: number        // 1-10 numeric — NEW
}

export interface ReflectionLearning {
  type: "behavior_correction" | "preference_expressed"
  observed: string
  evidence_message_indices: number[]
  proposed_action: "AGENTS.md edit" | "skill" | "behavior only"
  confidence: number
  significance: number     // 1-10, NEW
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
