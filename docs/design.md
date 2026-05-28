# opencode-personal-agent — Design Spec

**Status**: Approved for implementation (no code shipped yet — design phase)
**License**: MIT

---

## 0. TL;DR

Extend [opencode](https://opencode.ai) into a personal AI agent that:

1. **Remembers** — wakes up each session already knowing what you've been working on, what you've decided, and what you've learned. Reads Joplin (decisions/memories) and an optional pluggable memory backend (activity history) on session start.
2. **Reflects** — every 3 minutes of idle (and on `/wrap`), runs a non-blocking background reflection via your configured LLM endpoint that silently writes new decisions and memories to Joplin.
3. **Grows** — detects repeated tool patterns and offers to promote them to skills (`/promote`); detects cross-session corrections and proposes `AGENTS.md` edits when an evidence threshold is hit. Never silent-edits `AGENTS.md`.

**Implementation surface**: 1 opencode plugin (TypeScript, ~300 LOC), 3 slash skills, 4 Joplin note conventions, 1 documented HTTP adapter contract for pluggable memory backends. No new daemon, no new MCP server, no new database.

---

## 1. Vision & Goals

### 1.1 The problem

Opencode sessions start cold. Every conversation begins from zero context — the agent doesn't know what you decided yesterday, what you're working on now, or that you've corrected it the same way ten times. Meanwhile, the ecosystem already has:

- **Notes apps** (Joplin) holding your deliberate knowledge
- **Memory backends** (Mem0, Letta, custom services) continuously capturing context
- **Opencode skills + Superpowers** for procedural know-how
- **`AGENTS.md`** for hand-written rules

Each is solid in isolation. None of them talk to each other.

### 1.2 What "grows with you" actually means

Three loops, in increasing order of friction:

| Loop | Latency | Friction | What changes |
|---|---|---|---|
| **Memory loop** | Per-session | Zero (silent) | Joplin Decisions + Memories notes accumulate |
| **Skill loop** | Per-week | Low (one prompt at `/promote` time) | New skill files added under `~/.config/opencode/skills/` or `.opencode/skills/` |
| **Rules loop** | Per-month | Medium (review diff) | `AGENTS.md` evolves with new general truths |

### 1.3 Non-goals

- ❌ Not building a new agent runtime. Opencode is the agent.
- ❌ Not building a new memory store. Joplin SQLite + your chosen memory backend are the stores.
- ❌ Not building a new daemon. Plugin runs in-process inside opencode.
- ❌ Not unifying frontends. Opencode stays terminal-only / coding-focused; your notes app stays your notes app; this design only shares memory between them.
- ❌ Not auto-editing `AGENTS.md`. Proposals only, always with diff + approval.
- ❌ Not building any web UI, dashboard, or settings panel.

---

## 2. Required Surface Area

What you need installed and running for the plugin to function:

| Asset | Required? | Notes |
|---|---|---|
| opencode | yes | The runtime. [Install](https://opencode.ai) |
| Joplin desktop + Web Clipper | yes | Decisions + Memories store. Web Clipper provides the local HTTP API used by the MCP server |
| Joplin MCP server | yes | Any community/custom MCP server exposing `search_notes`, `get_note`, `list_notes`, `create_note`, `append_to_note` |
| LLM endpoint | yes | Any OpenAI-compatible chat completions endpoint. Configured via env var (`OPENCODE_PA_LLM_URL`, `OPENCODE_PA_LLM_KEY`, `OPENCODE_PA_LLM_MODEL`) |
| Memory backend | optional | Any HTTP service implementing the [adapter contract](./adapters/README.md). Without one, plugin runs with Joplin-only context. |
| Opencode plugin dir | yes | `~/.config/opencode/plugins/` |
| Opencode skills dir | yes | `~/.config/opencode/skills/` (global) and/or `.opencode/skills/` (project) |
| Opencode `AGENTS.md` | optional | Only touched via `/agents-edit`. If absent, the rules-loop is a no-op. |

---

## 3. Locked-in Design Decisions

These were settled during the design phase. Don't revisit during implementation unless a constraint blocks you.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Architecture**: opencode IS the agent (extend it, no new process) | Lowest friction, reuses existing process tree |
| D2 | **Memory store policy**: Joplin for decisions + memories. `AGENTS.md` only for big general rules with cross-session evidence. | Joplin is durable, append-only friendly, and queryable. `AGENTS.md` is the agent's instructions — too risky to edit silently |
| D3 | **Friction level**: low — silent saves, ask only for skills + `AGENTS.md` edits | Maximize signal capture, minimize interruption |
| D4 | **Skill creation**: ask before creating, when repetition ≥ 3 in session OR ≥ 2 cross-session | Above noise floor; below daily-friction floor |
| D5 | **Reflection model**: any chat-completions LLM (configurable) | Plugin is model-agnostic; Sonnet/GPT-4o/Gemini-Pro all work |
| D6 | **Reflection trigger**: 3-min idle + `/wrap` only | No `session.deleted`, no `session.compacted` triggers in v1 |
| D7 | **Reflection execution**: non-blocking background `fetch()` (fire-and-forget Promise) | Plugins run in opencode's event loop; an unawaited Promise + `.catch()` is the simplest non-blocking pattern |
| D8 | **Skill location on /promote**: ask each time (global vs project) | User intent varies per pattern |
| D9 | **v1 scope**: all 5 phases upfront | Each phase delivers usable value; total budget ~500 LOC |
| D10 | **Joplin note granularity**: monthly notes + `#project` tags inline | Matches common Joplin convention; keeps notes small enough to query |
| D11 | **Memory backend dependency**: graceful degrade if down | Backend is optional and may be remote/local — robustness required |
| D12 | **New Joplin notes**: `Agent Learnings — YYYY-MM` (monthly) and `Skills Proposed` (single rolling) created on first run if absent | Needed for cross-session signal aggregation |
| D13 | **Idle debounce**: 3 minutes of true idle (no user input AND no tool execution) | Conservative — avoids interrupting active work |
| D14 | **Plugin / skill file locations** | Plugin: `~/.config/opencode/plugins/personal-agent.ts`. Skills: `~/.config/opencode/skills/{wrap,promote,agents-edit}/SKILL.md` |

---

## 4. Architecture

### 4.1 Block diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  opencode TUI (your terminal agent)                                  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Plugin: personal-agent.ts (~300 LOC, TypeScript)               │  │
│  │                                                                │  │
│  │  Subscribes:                                                   │  │
│  │   • session.created  → MemoryBootstrap.inject(ctx)             │  │
│  │   • session.idle     → IdleWatcher.tick() → maybe reflect()    │  │
│  │   • tool.execute.*   → PatternTracker.record()                 │  │
│  │   • experimental.session.compacting → re-inject memory         │  │
│  │   • tui.command.execute → handle /wrap, /promote, /agents-edit │  │
│  │                                                                │  │
│  │  In-memory state per session:                                  │  │
│  │   • lastActivityTs: Date                                       │  │
│  │   • toolCallRingBuffer: ToolCall[]   (last 200)                │  │
│  │   • patternCandidates: Map<sig, count>                         │  │
│  │   • lastReflectionTs: Date                                     │  │
│  └────────────────────────────────────────────────────────────────┘  │
│         │                       │                          │         │
└─────────┼───────────────────────┼──────────────────────────┼─────────┘
          │ fetch()               │ MCP                      │ fetch()
          ▼                       ▼                          ▼
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐
│ LLM endpoint         │  │ Joplin MCP server    │  │ Memory backend   │
│ (configurable)       │  │ (community / custom) │  │ (optional)       │
│                      │  │                      │  │                  │
│ • Reflection prompt  │  │ • search_notes       │  │ • GET /activities│
│ • Skill draft prompt │  │ • get_note           │  │ • POST /query    │
│ • AGENTS.md propose  │  │ • append_to_note     │  │ • GET /status    │
│   prompt             │  │ • create_note        │  │                  │
└──────────────────────┘  └──────────────────────┘  │ Adapter contract │
                                     │              │ → docs/adapters/ │
                                     ▼              └──────────────────┘
                          ┌────────────────────────────────┐
                          │ Joplin SQLite                  │
                          │                                │
                          │ Notes (read by agent):         │
                          │ • Decisions — YYYY-MM          │
                          │ • Memories — YYYY-MM           │
                          │ • Agent Learnings — YYYY-MM    │
                          │ • Skills Proposed              │
                          └────────────────────────────────┘
```

### 4.2 Why a plugin and not a separate process

Three reasons:

1. **State locality.** The plugin needs to observe tool calls, session events, and inject system messages — all happen inside opencode's event loop. A separate process would need IPC for every event.
2. **Lifecycle alignment.** Plugin lives exactly as long as the opencode session. No daemon to babysit, no port conflicts.
3. **User stays the host.** All decisions are made inside opencode (where the user is). The plugin only orchestrates external services (Joplin, memory backend, LLM endpoint).

### 4.3 Why three skills instead of one big skill

`/wrap`, `/promote`, `/agents-edit` are three different user intents:
- `/wrap` = end this session cleanly (summarize, save, show pending)
- `/promote` = turn a flagged pattern into a real skill (interactive draft + write)
- `/agents-edit` = review proposed `AGENTS.md` diff and apply or reject

Keeping them separate means each skill is short, single-purpose, and reusable by other workflows (e.g., user can run `/promote` manually even without `/wrap`).

---

## 5. Components — Detailed

### 5.1 Plugin: `personal-agent.ts`

**Path**: `~/.config/opencode/plugins/personal-agent.ts`
**Language**: TypeScript (uses `@opencode-ai/plugin` types)
**Dependencies**: none beyond `@opencode-ai/plugin` (already available via opencode itself)
**Size budget**: 300–400 LOC across one file, or 5 small files if it grows

#### 5.1.1 Module structure (single-file initial impl)

```ts
// ~/.config/opencode/plugins/personal-agent.ts

import type { Plugin } from "@opencode-ai/plugin"

// ── Configuration (env-var driven; defaults shown) ────────────────────
const LLM_BASE        = process.env.OPENCODE_PA_LLM_URL   ?? "http://127.0.0.1:8080/v1"
const LLM_KEY         = process.env.OPENCODE_PA_LLM_KEY   ?? ""
const LLM_MODEL       = process.env.OPENCODE_PA_LLM_MODEL ?? "claude-3-5-sonnet"
const MEMORY_BASE     = process.env.OPENCODE_PA_MEMORY_URL ?? null  // optional
const JOPLIN_NOTEBOOK = process.env.OPENCODE_PA_JOPLIN_NOTEBOOK ?? "Second Brain"

const IDLE_THRESHOLD_MS  = 3 * 60 * 1000              // 3 min
const SKILL_REPEAT_IN_SESSION_THRESHOLD = 3
const AGENTS_MD_CROSS_SESSION_THRESHOLD = 2
const REFLECTION_DEDUPE_WINDOW_MS = 2 * 60 * 1000

// ── Per-session state (kept in module-scope Map keyed by session id) ──
interface SessionState {
  sessionId: string
  startedAt: Date
  lastActivityTs: Date
  lastReflectionTs: Date | null
  toolCalls: ToolCall[]                 // ring buffer (max 200)
  patternCandidates: Map<string, number>
  pendingReflectionAt: Date | null
  bootstrappedContext: string | null    // for re-injection on compaction
}

interface ToolCall {
  ts: Date
  tool: string
  argsSignature: string
}

const sessions = new Map<string, SessionState>()

// ── Plugin entry ──────────────────────────────────────────────────────
export const PersonalAgent: Plugin = async ({ client, project, directory, worktree, $ }) => {
  return {
    "session.created":                 onSessionCreated,
    "session.idle":                    onSessionIdle,
    "session.deleted":                 onSessionDeleted,
    "tool.execute.before":             onToolBefore,
    "tool.execute.after":              onToolAfter,
    "experimental.session.compacting": onCompacting,
    "tui.command.execute":             onTuiCommand,
  }

  // … handler implementations below (§ 5.1.2 onward)
}
```

#### 5.1.2 `session.created` — Memory bootstrap

**Goal**: Build a ~400-token system message containing what the agent should remember, inject it before the user's first turn.

**Algorithm**:

```text
1. Parse cwd to detect active project (match against +ProjectName tags Joplin uses).
   - Heuristic: take last 2 path segments of cwd; lookup map { "myrepo": "MyRepo", ... }
     (the plugin reads an optional mapping from $OPENCODE_PA_PROJECT_MAP if present).
   - Fallback: use cwd basename as project name.

2. In parallel:
   a. Joplin search for "+<ProjectTag>" sorted by updated_time desc, last 7 days, limit 5
   b. Joplin get note "Decisions — <current YYYY-MM>" (entries from last 7 days only)
   c. Joplin get note "Memories — <current YYYY-MM>"  (entries from last 7 days only)
   d. If MEMORY_BASE is set: GET <MEMORY_BASE>/activities?date=<today>
      (graceful skip if 5xx/timeout — see § 8)

3. Compose bootstrap message (max 500 tokens):

   ┌─ INJECTED CONTEXT ──────────────────────────────────┐
   │ ## Memory bootstrap                                 │
   │                                                     │
   │ **Active project (from cwd)**: <ProjectName>        │
   │ **Today's activity (from memory backend)**: <top 3> │
   │                                                     │
   │ ### Recent decisions (last 7 days)                  │
   │ - <date> — <title> — <one-line rationale>           │
   │ - …                                                 │
   │                                                     │
   │ ### Recent memories (last 7 days)                   │
   │ - <date> — <title> — <one-line significance>        │
   │                                                     │
   │ ### Project-tagged notes (last 7 days)              │
   │ - <note title> — <preview 80 chars>                 │
   │                                                     │
   │ _End memory bootstrap. Continue normally._          │
   └─────────────────────────────────────────────────────┘

4. Push as a system-role message via opencode's session API.
   (Exact API confirmed at implementation time — see § 12.1 risk.)

5. Persist bootstrappedContext in SessionState (re-injected by onCompacting).

6. Initialize SessionState in `sessions` map.
```

**Error handling**:
- Joplin MCP unreachable → log warn, inject only memory-backend portion
- Memory backend unreachable → log warn, inject only Joplin portion
- Both down → inject minimal "(No memory available — Joplin and memory backend both unreachable)" so the user knows the system tried
- Any unexpected error → swallow, log via `client.app.log`, do not block session

#### 5.1.3 `session.idle` — Idle watcher + reflection trigger

**Note on the event**: per opencode plugin docs, `session.idle` fires when the session goes idle (after a turn completes and no further activity is happening). It does NOT fire on a continuous timer.

**Algorithm**:

```text
On every session.idle event:
  1. Update state.lastActivityTs = now()
  2. Schedule a setTimeout(checkIdleAndReflect, IDLE_THRESHOLD_MS)
     - Cancel any previously scheduled timer first.
  3. In checkIdleAndReflect:
     a. If (now - state.lastActivityTs) < IDLE_THRESHOLD_MS, abort (something happened).
     b. If state.lastReflectionTs && (now - state.lastReflectionTs) < REFLECTION_DEDUPE_WINDOW_MS,
        abort (just reflected).
     c. Call reflect(state) without awaiting. Attach .catch() that logs only.
     d. Set state.lastReflectionTs = now() optimistically (so a rapid re-fire dedupes).

On tool.execute.before AND on session.idle: update lastActivityTs.
On session.deleted: cancel any pending timer for that session.
```

This pattern is the simplest possible "fire when truly idle" — single rolling `setTimeout`, no polling, no extra events.

#### 5.1.4 `reflect(state)` — the background reflection

**Goal**: One LLM call that reads the session, returns a structured JSON with proposed Joplin writes + skill candidates + AGENTS.md proposals. The plugin then dispatches.

**Step 1 — gather session transcript**: The plugin reads the last N user/assistant turns from opencode's session API. Trim to last 30 turns or 8K tokens, whichever is smaller.

**Step 2 — build reflection prompt**:

```text
SYSTEM: You are the reflection module of a personal AI agent. You read a
session transcript and emit JSON describing what should be remembered.

Output schema (strict JSON, no prose):
{
  "decisions": [
    {
      "title": "<short>",
      "context": "<what was being worked on>",
      "decision": "<chosen path>",
      "rationale": "<why this over alternatives>",
      "rejected": ["<alt 1 with one-line why>", ...],
      "project_tag": "<e.g. myrepo>" | null,
      "confidence": 0.0..1.0
    }
  ],
  "memories": [
    {
      "title": "<short>",
      "what_happened": "<single paragraph>",
      "significance": "<one line>",
      "files_touched": ["<path>", ...],
      "loose_ends": ["<line>", ...],
      "project_tag": "<e.g. myrepo>" | null,
      "confidence": 0.0..1.0
    }
  ],
  "agent_learnings": [
    {
      "type": "behavior_correction" | "preference_expressed",
      "observed": "<what happened>",
      "evidence_message_indices": [12, 47],
      "proposed_action": "AGENTS.md edit" | "skill" | "behavior only",
      "confidence": 0.0..1.0
    }
  ]
}

Rules:
- A "decision" requires a rejected alternative. Otherwise it's a "memory".
- "agent_learnings" only when user CORRECTED the agent or expressed a preference.
  Do NOT include routine work.
- Set confidence >= 0.6 for items worth writing. The plugin will drop items
  below 0.6.
- Output only items NEW in this session — if the transcript shows the
  agent already saved something, skip it.
- If nothing notable happened, return empty arrays. This is fine and common.

USER: <session transcript here>
```

**Step 3 — call the LLM endpoint**:

```ts
const res = await fetch(`${LLM_BASE}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(LLM_KEY ? { "Authorization": `Bearer ${LLM_KEY}` } : {}),
  },
  body: JSON.stringify({
    model: LLM_MODEL,
    messages: [
      { role: "system", content: REFLECTION_SYSTEM_PROMPT },
      { role: "user",   content: transcript },
    ],
    response_format: { type: "json_object" },
    max_tokens: 2000,
    temperature: 0.2,
  }),
  signal: AbortSignal.timeout(30_000),
})
```

The plugin assumes an **OpenAI-compatible chat completions endpoint**. Anthropic's native API, OpenAI, Azure OpenAI, Gemini, LM Studio, Ollama, and most LLM gateways speak this dialect (or speak it through a thin proxy).

**Step 4 — dispatch outputs**:

For each `decision` (confidence ≥ 0.6):
  → `mcp.call("joplin_append_to_note", { id_or_title: "Decisions — YYYY-MM", content: render(decision) })`
  → Create the note via `joplin_create_note` if 404 on first write of the month.

For each `memory` (confidence ≥ 0.6):
  → Same pattern, `Memories — YYYY-MM`

For each `agent_learning`:
  → Append to `Agent Learnings — YYYY-MM`
  → If `proposed_action == "skill"` → also bump count for that pattern in `Skills Proposed` rolling note
  → If `proposed_action == "AGENTS.md edit"` → check cross-session count via Joplin search; if count ≥ 2 → emit toast via `tui.toast.show("Proposed AGENTS.md edit: ... run /agents-edit to review")`

**Step 5 — pattern detection check** (independent of LLM):
  → For every pattern in `state.patternCandidates` with count ≥ 3:
    → Append a `skill_candidate` entry to `Agent Learnings — YYYY-MM`
    → Emit toast: `"Pattern detected: <tool>(<args>) ×3. Run /promote to convert."`
    → Add to `Skills Proposed` rolling note

#### 5.1.5 `tool.execute.before` / `tool.execute.after` — Pattern tracker

**Goal**: Detect when the same tool with structurally similar args repeats within a session.

**Normalization** — turn raw args into a signature:

```ts
function normalizeArgs(tool: string, args: any): string {
  switch (tool) {
    case "bash": {
      // Strip arg values that look like data; keep flags and command tokens.
      const cmd = args.command ?? ""
      const tokens = cmd.split(/\s+/).map(t => {
        if (/^["'].*["']$/.test(t)) return "<str>"
        if (/^\/[\w./-]+/.test(t))  return "<path>"
        if (/^https?:\/\//.test(t)) return "<url>"
        if (/^-/.test(t))           return t           // keep flags
        return t.toLowerCase()                          // keep verb tokens
      })
      return `bash:${tokens.slice(0, 6).join(" ")}`
    }
    case "write": case "edit": case "read":
      return `${tool}:${(args.filePath ?? "").split("/").slice(-2).join("/")}`
    default:
      // Generic: tool name + sorted top-level keys
      return `${tool}:${Object.keys(args ?? {}).sort().join(",")}`
  }
}
```

**On `tool.execute.before`**:
```ts
const sig = normalizeArgs(input.tool, output.args)
const state = sessions.get(sessionId)
state.toolCalls.push({ ts: new Date(), tool: input.tool, argsSignature: sig })
if (state.toolCalls.length > 200) state.toolCalls.shift()
state.patternCandidates.set(sig, (state.patternCandidates.get(sig) ?? 0) + 1)
state.lastActivityTs = new Date()
```

**On `tool.execute.after`**: just bump `lastActivityTs`.

**Threshold check** happens inside `reflect()`, not per-call. We don't want to interrupt mid-work.

#### 5.1.6 `experimental.session.compacting` — Memory survival

Inject the same `bootstrappedContext` into `output.context` so memory survives compaction:

```ts
async ({ session }, output) => {
  const state = sessions.get(session.id)
  if (state?.bootstrappedContext) {
    output.context.push(state.bootstrappedContext)
  }
}
```

This means after `/compact`, the agent still knows what it knew on bootstrap. Mid-session writes are not re-injected here — they're in Joplin already, queryable via Joplin MCP if needed.

#### 5.1.7 `tui.command.execute` — Slash command dispatch

Handle `/wrap`, `/promote`, `/agents-edit`:

```ts
async (input) => {
  if (input.command === "wrap")        return runWrap(input.sessionId)
  if (input.command === "promote")     return runPromote(input.sessionId, input.args)
  if (input.command === "agents-edit") return runAgentsEdit(input.sessionId)
}
```

These three handlers call the same primitives the idle reflection uses, but in a synchronous (awaited) mode and emit a structured summary back to the TUI.

#### 5.1.8 `session.deleted` — Cleanup

Cancel pending idle timer. Delete `sessions[sessionId]`. Do NOT trigger a final reflection (per D6).

---

### 5.2 Slash skill: `/wrap`

**Path**: `~/.config/opencode/skills/wrap/SKILL.md`

**Description**: "Wrap up the current opencode session: force immediate background reflection, then show a summary of what was saved plus any pending proposals."

**Behavior**:
1. Skill prompts the agent to invoke the plugin's `runWrap` via the registered slash command (the plugin receives this through `tui.command.execute`).
2. `runWrap` does:
   - Synchronously run `reflect(state)` (awaited, not fire-and-forget)
   - Read `Skills Proposed` note → list pending skill candidates
   - Read `Agent Learnings — YYYY-MM` → list AGENTS.md proposals waiting (cross-session count ≥ 2)
3. Emit a structured summary:

```
═════ Session wrap-up — 2026-05-28 18:14 ═════

✓ Saved to Joplin "Decisions — 2026-05" (2 entries):
  • Use SQLite poll over Joplin webhooks
  • Encrypt screenshots with AES-256-GCM, password in keychain

✓ Saved to Joplin "Memories — 2026-05" (1 entry):
  • Public-release branch merged

⚠ 1 skill candidate awaiting your decision:
  • pr-create   (4 hits this session)
    → Run /promote pr-create to convert, or ignore.

⚠ 1 AGENTS.md proposal (cross-session count = 2):
  • "Always confirm before pushing to main"
    → Run /agents-edit to review the diff, or ignore.

Nothing else flagged.
```

**Failure mode**: if reflection fails (network, timeout) → emit warning, list nothing under "saved", keep pending lists intact (read directly from Joplin).

### 5.3 Slash skill: `/promote`

**Path**: `~/.config/opencode/skills/promote/SKILL.md`

**Description**: "Promote a flagged tool-usage pattern into a real opencode skill. Asks whether to install globally or in the current project, drafts the SKILL.md, shows diff, writes it."

**Invocation**: `/promote <name>` (e.g. `/promote pr-create`)

**Behavior**:
1. Look up `<name>` in `Skills Proposed` Joplin note. If absent → error: "No such pending pattern. Run /wrap to see pending."
2. Read the pattern's tool-call signature + hit examples from the proposed note.
3. Ask user: **"Install to `~/.config/opencode/skills/` (global) or `.opencode/skills/` (project)?"** (per D8).
4. Generate a draft `SKILL.md` via a built-in template (see § 5.3.1).
5. Show the diff (the new file content) and ask for approval / edits.
6. On approval:
   - Write to chosen location: `<base>/<name>/SKILL.md`
   - Append "promoted on YYYY-MM-DD" to the `Skills Proposed` note entry (don't delete — keeps history)
   - Toast: `"Skill <name> installed at <path>. Restart opencode to load."` (Skills are discovered at startup.)

#### 5.3.1 SKILL.md template the plugin uses

```markdown
---
name: <name>
description: <one-line auto-generated from pattern>
---

# <Name>

Auto-promoted from observed pattern.

## When to use

The pattern was detected when:
<list 2-3 example contexts from the captured ToolCall entries>

## What it does

<expand from the tool signature>

## Steps

1. <step inferred from tool call sequence>
2. ...

## Notes

This skill was promoted automatically. Edit this file to refine.
```

The auto-template will rarely be perfect. That's expected — it's a head-start, not a final draft. User edits before merging.

### 5.4 Slash skill: `/agents-edit`

**Path**: `~/.config/opencode/skills/agents-edit/SKILL.md`

**Description**: "Review and apply any pending AGENTS.md edit proposals from cross-session evidence."

**Behavior**:
1. Read `Agent Learnings — YYYY-MM` for entries with `proposed_action == "AGENTS.md edit"` and cross-session count ≥ 2.
2. For each: show the proposed diff against the appropriate `AGENTS.md` (global vs project — determined by whether the learning is project-tagged).
3. Ask: apply / skip / edit.
4. On apply: write the diff, append "applied YYYY-MM-DD" to the Agent Learnings entry.
5. On skip: append "rejected YYYY-MM-DD" so it doesn't keep proposing the same thing.

**Diff generation** is itself an LLM call:

```text
SYSTEM: You are editing an AGENTS.md file. Given the current file, a learning
to incorporate, and the location it should be added, produce a unified diff.
Keep edits minimal and place new content under the most relevant heading.

USER: <current AGENTS.md>

LEARNING: <text of the agent_learning entry>
```

---

### 5.5 Joplin Note Schemas

#### 5.5.1 `Decisions — YYYY-MM`

One per month. Created lazily on first write of the month via `joplin_create_note` (after `joplin_get_note` returns 404). Notebook: `$OPENCODE_PA_JOPLIN_NOTEBOOK` (default `Second Brain`).

**Body format** — append-only, each entry is one `##` section:

```markdown
## 2026-05-28 14:32 — Joplin for notes, not Obsidian

**Project**: myrepo  +myrepo
**Context**: Picking the deliberate notes app for the project knowledge layer.
**Decision**: Use Joplin desktop with SQLite read + Web Clipper write.
**Rationale**: AGPL open-source, allowed by org compliance, standard markdown export, stable SQLite for polling.
**Rejected**:
  - Obsidian — compliance issue.
  - Dendron — author archived the project.
  - Plain markdown folder — no UI, no mobile.

**Tags**: #decision #myrepo #notes-stack
**Recorded by**: agent (session abc123)

---
```

**Rules**:
- One section per decision, separated by `---`.
- Project tag uses `+ProjectName` inline.
- `**Recorded by**` is always `agent (session <id>)` so the user can trace.
- Never modify existing sections — append only.

#### 5.5.2 `Memories — YYYY-MM`

Same notebook, same one-per-month, same append pattern. See [`examples/joplin-notes/memories.md`](../examples/joplin-notes/memories.md) for a sample.

#### 5.5.3 `Agent Learnings — YYYY-MM`

Same monthly pattern. Three types of entries:

**Type A — behavior correction** (agent did something user fixed):
```markdown
## 2026-05-28 18:02 — Forgot to create worktree before edits

**Type**: behavior_correction
**Observed**: User reminded me twice this session to create a worktree first.
**Already in AGENTS.md**: yes (§ "Use git worktrees for all code changes")
**Evidence**: Session abc123 messages [42, 67]
**Cross-session count**: 4
**Proposed action**: none (rule already exists; agent needs to follow it)
**Status**: noted
**Recorded by**: agent (session abc123)

---
```

**Type B — preference expressed** (user said "I prefer X"):
```markdown
## 2026-05-28 18:10 — Prefer pnpm over npm in new projects

**Type**: preference_expressed
**Observed**: User said "use pnpm" when initializing a TS project.
**Already in AGENTS.md**: no
**Evidence**: Session abc123 messages [88]
**Cross-session count**: 1 (first time)
**Proposed action**: AGENTS.md edit when cross-session count reaches 2
**Status**: pending_more_evidence
**Recorded by**: agent (session abc123)

---
```

**Type C — skill candidate** (repeated tool pattern):
```markdown
## 2026-05-28 18:15 — Skill candidate: pr-create

**Type**: skill_candidate
**Observed**: User ran `gh pr create ...` 4 times this session.
**Pattern signature**: `bash:gh pr create --assignee <str> --title <str> --body <str>`
**Cross-session count**: 1
**Proposed action**: promote to skill `pr-create`
**Status**: pending_user_approval (see Skills Proposed)
**Recorded by**: agent (session abc123)

---
```

**Cross-session count calculation**: when reflection writes a new learning, the plugin first searches `Agent Learnings — *` (all months, last 90 days) for entries with matching `Pattern signature` or matching normalized `Observed` text (via Joplin MCP `search_notes`). The returned hit count = cross-session count. Stored in the new entry.

#### 5.5.4 `Skills Proposed` (single rolling note, no monthly suffix)

One note ever. Append-only. Read by `/wrap` and `/promote`. See [`examples/joplin-notes/skills-proposed.md`](../examples/joplin-notes/skills-proposed.md) for a sample.

---

## 6. Data Flow Walk-Throughs

### 6.1 Cold start in a project worktree

```
$ cd ~/code/myrepo/.worktrees/feature-branch
$ opencode

[opencode internal]                           [plugin]
session.created event fires        ──►        onSessionCreated:
                                                1. project = "myrepo" (cwd match)
                                                2. parallel fetch:
                                                   - Joplin search "+myrepo" last 7d
                                                   - Joplin get "Decisions — 2026-05"
                                                   - Joplin get "Memories — 2026-05"
                                                   - memory backend /activities (if configured)
                                                3. compose ~400-token system msg
                                                4. inject via session API
                                                5. store in state.bootstrappedContext

User: "let me continue the work"
Agent (already knows from injected context):
  "Yesterday you decided to prune cached entries older than 90 days but keep
   them in the long-term collection. The script lives at scripts/prune.py.
   Where were we?"
```

### 6.2 Idle reflection (silent path)

```
Time 0:00  User asks a question, agent answers, tool calls happen
Time 0:01  session.idle fires → schedule timer for +3min
Time 0:02  User runs a bash command → tool.execute.before fires
           → lastActivityTs updated, timer is implicitly invalid (next idle re-schedules)
Time 0:03  Agent finishes responding → session.idle fires again → re-schedule timer
Time 0:06  Timer fires. now - lastActivityTs = 3 min ✓.
           Plugin starts reflect() but does NOT await.
Time 0:06.1 reflect() begins fetching transcript and POSTing to LLM endpoint.
            User can keep typing.
Time 0:06.5 User starts typing a new question.
Time 0:09  reflect() resolves with JSON:
            { decisions: [{title: "...", ...}], memories: [], agent_learnings: [] }
Time 0:09.1 Plugin appends to "Decisions — 2026-05" via Joplin MCP. Silent.
Time 0:09.2 No skill candidates, no AGENTS.md proposals. No toast shown.
            User never noticed.
```

### 6.3 Pattern detection → skill promotion

```
Time 0:00–0:30  User runs `gh pr create ...` 4 times.
                On each tool.execute.before:
                  patternCandidates["bash:gh pr create ..."] += 1
                  count reaches 4.

Time 0:33  3-min idle hits → reflect() runs.
           Plugin's pattern check sees count ≥ 3 for "gh_pr_create" pattern.
           Appends to "Agent Learnings — 2026-05" (Type C, skill_candidate).
           Appends to "Skills Proposed".
           Emits toast: "Pattern detected: gh pr create ×4. Run /promote pr-create."

Time 0:40  User types `/wrap` to end session.
           Plugin's runWrap shows the summary including:
             "⚠ 1 skill candidate: pr-create"

Time 0:41  User types `/promote pr-create`.
           Plugin asks: "Install globally or in current project?"
           User picks "global".
           Plugin generates draft SKILL.md, shows diff.
           User edits 2 lines, approves.
           Plugin writes ~/.config/opencode/skills/pr-create/SKILL.md.
           Updates Skills Proposed entry: "Status: promoted 2026-05-28".
           Toast: "Skill pr-create installed. Restart opencode to load."
```

### 6.4 Cross-session AGENTS.md proposal

```
Day 1   Reflection detects: "User said 'don't use try/except for control flow'"
         → Appends Agent Learning Type B, cross-session count = 1
         → Status: pending_more_evidence (no AGENTS.md proposal yet)

Day 8   Reflection detects: "User corrected agent: don't use try/except for control flow"
         → Searches Agent Learnings — * for matching pattern.
         → Finds the Day 1 entry. Cross-session count = 2 now.
         → Appends new Agent Learning Type B, count = 2.
         → Proposed action: AGENTS.md edit.
         → Toast: "Cross-session pattern (2 sessions): don't use try/except for
                   control flow. Run /agents-edit to review."

Day 8 later  User runs `/agents-edit`.
              Plugin shows proposed diff against ~/.config/opencode/AGENTS.md:
                + Under "### KISS — keep it simple":
                +   **No try/except for control flow** — exceptions are
                +   for exceptional cases; use returns and conditionals.
              User approves. Plugin writes the diff.
              Updates Agent Learning entry: "Status: applied 2026-06-05".
```

---

## 7. Configuration

All hardcoded constants live at the top of `personal-agent.ts`. v1 does NOT add a config file — environment variables override defaults.

| Constant | Default | Override env var |
|---|---|---|
| `IDLE_THRESHOLD_MS` | 180_000 (3 min) | edit source |
| `LLM_BASE` | `http://127.0.0.1:8080/v1` | `OPENCODE_PA_LLM_URL` |
| `LLM_KEY` | `""` (empty) | `OPENCODE_PA_LLM_KEY` |
| `LLM_MODEL` | `claude-3-5-sonnet` | `OPENCODE_PA_LLM_MODEL` |
| `MEMORY_BASE` | none (disabled) | `OPENCODE_PA_MEMORY_URL` |
| `JOPLIN_NOTEBOOK` | `Second Brain` | `OPENCODE_PA_JOPLIN_NOTEBOOK` |
| `SKILL_REPEAT_IN_SESSION_THRESHOLD` | 3 | edit source |
| `AGENTS_MD_CROSS_SESSION_THRESHOLD` | 2 | edit source |
| `REFLECTION_DEDUPE_WINDOW_MS` | 120_000 (2 min) | edit source |

**v2 candidate**: move all knobs to `~/.config/opencode/personal-agent.json`. Not in v1 scope.

See [`examples/opencode-config-snippet.jsonc`](../examples/opencode-config-snippet.jsonc) for a sample setup.

---

## 8. Error Handling & Degradation

| Failure | Behavior |
|---|---|
| Joplin MCP unreachable | Log warn. Memory bootstrap proceeds with memory-backend-only data. Reflection writes are queued in-memory (lost on session.deleted). |
| Memory backend down | Log warn. Memory bootstrap skips activity portion. No retry. |
| LLM endpoint returns 5xx | Log warn. Reflection skipped this round. Pending writes deferred to next reflection. |
| LLM endpoint returns 4xx | Log error with response body. Skip this round. |
| LLM endpoint times out (>30s) | Abort. Skip this round. |
| Reflection returns invalid JSON | Log error. Skip dispatch. Do not retry within session. (See § 12.5.) |
| `joplin_append_to_note` fails with 404 (note doesn't exist) | Auto-create via `joplin_create_note` and retry once. If retry fails, log error and drop the write. |
| Plugin throws unhandled exception | Caught at top level, logged via `client.app.log`. Plugin remains loaded; failure does not kill session. |

**Principle**: the plugin must never block, crash, or interrupt the user's session. Every external call is wrapped in `try/catch`. Every async dispatch is fire-and-forget with `.catch()`. Logs go to opencode's structured log, not stdout.

---

## 9. Implementation Phases

All 5 phases are in v1 scope (per D9). Build in order — later phases depend on earlier ones.

### Phase 1 — Plugin scaffold + Memory bootstrap (~120 LOC)

**Deliverable**: opencode starts up, plugin loads, `session.created` event injects Joplin + memory-backend context. No reflection yet.

**Files**:
- `~/.config/opencode/plugins/personal-agent.ts` (new)
- `~/.config/opencode/package.json` (new — declares `@opencode-ai/plugin` type dep)

**Acceptance**:
- `opencode` starts without errors with plugin loaded.
- `client.app.log` shows `"personal-agent: bootstrapped session <id> with N decisions, M memories"` on session start.
- First user message receives a response that demonstrably uses injected context (e.g., user asks "what did we decide last week?" → agent answers from Decisions note without searching).
- If memory backend stopped, plugin logs warn and still injects Joplin portion.
- If Joplin MCP not running, plugin logs warn and still injects memory-backend portion.

### Phase 2 — Idle watcher + background reflection (~100 LOC)

**Deliverable**: 3-min idle triggers fire-and-forget reflection that writes Decisions + Memories to Joplin silently.

**Acceptance**:
- After a session with at least one notable event, 3 min of idle results in a new entry appearing in `Decisions — YYYY-MM` OR `Memories — YYYY-MM`.
- User can keep typing during reflection; no observable lag.
- Reflection that returns empty arrays writes nothing (no noise).
- Reflections dedupe within 2 min window — running idle twice in 4 min reflects only once.
- New monthly notes auto-create with the configured notebook.

### Phase 3 — `/wrap` slash skill (~60 LOC + 1 SKILL.md)

**Deliverable**: user can run `/wrap` to force reflection synchronously and see a summary.

**Acceptance**:
- `/wrap` produces a structured summary matching the format in § 5.2.
- Summary correctly distinguishes "saved this run" vs "pending from earlier".
- If reflection times out, `/wrap` still returns the pending lists (read from Joplin).

### Phase 4 — Pattern detection + `/promote` (~80 LOC + 1 SKILL.md)

**Deliverable**: repeated tool calls get flagged and can be promoted.

**Acceptance**:
- Running the same bash command 3 times in one session results in a `Skills Proposed` entry within 3 min.
- `/promote <name>` asks global-vs-project, generates a draft SKILL.md, writes it on approval.
- New skill appears under chosen base after restart.
- Pattern normalizer handles `bash`, `write`, `edit`, `read` distinctly; falls back to generic for others.

### Phase 5 — Cross-session learnings + `/agents-edit` (~50 LOC + 1 SKILL.md)

**Deliverable**: cross-session corrections accumulate; user can review and apply AGENTS.md diffs.

**Acceptance**:
- After 2 sessions with the same correction, an Agent Learning entry shows `Cross-session count: 2` and `Proposed action: AGENTS.md edit`.
- `/agents-edit` shows a diff generated by the LLM, supports apply / skip / edit.
- Apply writes to the correct `AGENTS.md` (global if no project tag, project-level if tagged).
- Skip / reject marks the entry so it won't propose again.

---

## 10. File Layout

```
~/.config/opencode/
├── opencode.jsonc                   (existing — add plugin path + MCP servers)
├── AGENTS.md                        (touched only via /agents-edit)
├── package.json                     ★ NEW — declares plugin deps if any
├── plugins/
│   └── personal-agent.ts            ★ NEW — the brain (~300 LOC)
└── skills/
    ├── wrap/
    │   └── SKILL.md                 ★ NEW
    ├── promote/
    │   └── SKILL.md                 ★ NEW
    └── agents-edit/
        └── SKILL.md                 ★ NEW

Joplin (your chosen notebook):
├── Decisions — YYYY-MM              (existing or auto-created — agent appends)
├── Memories — YYYY-MM               (existing or auto-created — agent appends)
├── Agent Learnings — YYYY-MM        ★ NEW — auto-created on first run
└── Skills Proposed                  ★ NEW — single rolling note
```

---

## 11. Testing Strategy

### 11.1 Unit (where feasible — TS plugin)

- `normalizeArgs(tool, args)` is pure — test with table of inputs / expected signatures.
- Joplin note name builder `decisionsNoteName(date)` → `"Decisions — 2026-05"`.
- Reflection JSON validator — given good/bad payloads, verify accept/reject.

### 11.2 Integration (manual, scripted)

- **Phase 1**: start opencode, ask the agent "what's in my decisions note?" — agent should answer from injected context.
- **Phase 2**: have a session, idle 3 min, check Joplin in 5 min — expect new entries.
- **Phase 3**: `/wrap` after a real session, verify summary format.
- **Phase 4**: run a contrived 3x bash repeat, idle 3 min, verify Skills Proposed entry, run `/promote`, verify file written.
- **Phase 5**: across 2 sessions, repeat the same correction, verify Cross-session count + AGENTS.md proposal toast.

### 11.3 Failure injection

Run each phase with:
- Joplin MCP killed
- Memory backend stopped
- LLM endpoint off
- Network unplugged

Expected: warnings logged, no crashes, opencode session usable throughout.

---

## 12. Risks & Open Risks

### 12.1 Opencode SDK shape

The plugin needs to do two things the docs don't fully spec:
- **Inject a system message** at session start (for memory bootstrap)
- **Read session transcript** for reflection

The docs show `client.app.log` and `experimental.session.compacting` shape, but the exact API for injecting messages and listing messages must be confirmed at implementation time. The plugin's repo will include a small spike script to verify the relevant `@opencode-ai/plugin` exports.

**Mitigation**: Phase 1 starts with a short spike to verify the injection API. If it doesn't exist as a first-class hook, the fallback is to use the `experimental.session.compacting` pattern: inject context via `output.context.push()` on a synthetic compaction trigger at session start. Worst case, contribute the missing hook upstream — opencode is open source.

### 12.2 Reflection cost & rate

Reflections cost depends on your LLM choice. With Claude Sonnet @ ~$3/M input, ~$15/M output, a 4K-token reflection input + 1K output ≈ $0.027 per reflection. At 10 sessions/day × 4 reflections/session = 40 reflections/day ≈ $1/day. Cheap. No throttling needed in v1. With local models (LM Studio, Ollama) — free.

### 12.3 Pattern false positives

Naive normalization will flag patterns like "user always reads README.md first" as skill candidates.

Mitigation:
- Skill detection only proposes; never installs without `/promote`.
- The `skill_candidate` entry in Agent Learnings lets the user audit later.
- v1.1 candidate: blocklist for common patterns (`read:README.md`, `read:AGENTS.md`).

### 12.4 Joplin write conflicts

If two reflections fire near-simultaneously (shouldn't happen given dedupe, but possible across sessions), both could append to the same note. Joplin Web Clipper handles concurrent writes serially. Acceptable risk — no special locking needed.

### 12.5 JSON parsing fragility

Some LLMs occasionally wrap JSON in prose despite `response_format: { type: "json_object" }`. Wrap parse in try/catch with regex extraction fallback (find first `{` to last `}`). Drop the round if both fail.

### 12.6 Privacy

All data stays local. Session transcripts go to whichever LLM endpoint you configure. Joplin runs locally. The memory backend runs locally (or wherever you point it). No telemetry from this plugin — the only outbound HTTP calls are to your chosen LLM endpoint and your chosen memory backend.

### 12.7 Skill auto-promotion safety

`/promote` always asks confirmation and shows the file before writing. There is no path where a skill is installed without explicit user click. Same for `/agents-edit`.

---

## 13. What's Explicitly Deferred (Not in v1)

- Web/dashboard UI for browsing Agent Learnings — use Joplin UI for now
- Config file at `~/.config/opencode/personal-agent.json` — env vars only for v1
- Plugin tests as a Bun test suite — manual testing only for v1
- Mobile/voice interface — opencode is terminal-only
- Multi-user / multi-machine sync — single machine
- Embedding-based pattern detection (semantic similarity of tool calls) — exact-signature only for v1
- Auto-revoking stale Agent Learnings (e.g., after 6 months no recurrence) — manual cleanup
- A "memory replay" feature where user can ask "what did we do on YYYY-MM-DD" — agent will read Joplin Memories on demand via the existing Joplin MCP search; no dedicated tool

---

## 14. Glossary

| Term | Definition |
|---|---|
| Reflection | A single LLM call after idle that summarizes the session and proposes Joplin writes. |
| Bootstrap | Injecting memory context at `session.created`. |
| Pattern | A normalized tool-call signature, e.g., `bash:gh pr create --assignee <str>`. |
| Pattern signature | The string output of `normalizeArgs(tool, args)`. |
| Cross-session count | Number of distinct prior sessions where the same Agent Learning was recorded. |
| Hit | One occurrence of a pattern in a single session. |
| Promotion | Converting a skill candidate into an installed SKILL.md. |
| Skill Proposed entry | A pending pattern awaiting `/promote`. |
| Agent Learning | A meta-observation about the user's preferences or agent's mistakes. |
| Decision | A choice with rejected alternatives. Written to Decisions note. |
| Memory | An episodic event. Written to Memories note. |
| Silent save | Plugin writes to Joplin without prompting or notifying the user. |
| Friction tier | Silent < Toast < `/wrap` summary < explicit prompt < blocking modal. |
| Memory backend | Optional pluggable HTTP service providing ambient activity context. See [adapters](./adapters/README.md). |
| Adapter | Concrete implementation of the memory backend HTTP contract. |

---

## 15. Sign-off

This spec is the canonical reference for v1. Locked decisions in § 3 are not up for revision during implementation — open an issue if you think a decision needs to change.

**Status**: design complete, implementation not yet started.

**End of spec.**
