# Architecture

One-page summary. For the full spec see [`docs/design.md`](./docs/design.md).

## The shape

```
┌──────────────────────────────────────────────────────────────────────┐
│  opencode (terminal agent — unchanged)                               │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Plugin: personal-agent  (~1800 LOC across 13 TS files)         │  │
│  │                                                                │  │
│  │  Hooks (via event bus):                                        │  │
│  │   • session.created  → initSession() + memory bootstrap        │  │
│  │   • session.idle     → 3-min debounce → reflect()              │  │
│  │   • tool.execute.*   → PatternTracker.record()                 │  │
│  │   • experimental.session.compacting → re-inject memory         │  │
│  │   • command.execute.before → /wrap, /promote, /agents-edit     │  │
│  │   • experimental.chat.system.transform → inject bootstrap      │  │
│  └────────────────────────────────────────────────────────────────┘  │
│         │                       │                          │         │
└─────────┼───────────────────────┼──────────────────────────┼─────────┘
          │                       │                          │
   ┌──────▼────────────┐  ┌───────▼──────────────┐  ┌────────▼─────────────┐
   │ LLM endpoint      │  │ Joplin REST API      │  │ Memory backend       │
   │ (configurable)    │  │ (Web Clipper)         │  │ (optional, pluggable)│
   │                   │  │                      │  │                      │
   │ • OpenAI-         │  │ • GET /search        │  │ Any HTTP service     │
   │   compatible      │  │ • GET /notes/:id     │  │ implementing the     │
   │   chat endpoint   │  │ • POST /notes        │  │ adapter contract:    │
   │ • Used for the    │  │ • PUT /notes/:id     │  │  • GET /activities   │
   │   3-min reflection│  │ • POST /tags         │  │  • POST /query       │
   │   and AGENTS.md   │  │ • POST /tags/:id/    │  │ Examples: 2brn,      │
   │   diff generation │  │   notes              │  │  Mem0, Letta, custom │
   └───────────────────┘  └──────────┬───────────┘  └──────────────────────┘
                                     │
                                     ▼
                          ┌──────────────────────────────────────────┐
                          │ Your Joplin SQLite                       │
                          │                                          │
                          │ Notes the plugin reads & writes:         │
                          │ • Decisions — YYYY-MM                    │
                          │ • Memories — YYYY-MM                     │
                          │ • Agent Learnings — YYYY-MM              │
                          │ • Skills Proposed (rolling)              │
                          │                                          │
                          │ Removed in v2 (migration 2026-06-06):    │
                          │   Project Notes — <projectTag>           │
                          └──────────────────────────────────────────┘
```

## Why a plugin, not a separate process

1. **State locality.** The plugin observes tool calls, session events, and injects system messages — all inside opencode's event loop. A separate process would need IPC for every event.
2. **Lifecycle alignment.** Plugin lives exactly as long as the opencode session. No daemon to babysit, no port conflicts.
3. **User stays the host.** All decisions are made inside opencode. The plugin only orchestrates external services (Joplin, memory backend, LLM endpoint).

## Why direct REST, not the Joplin MCP server

The opencode plugin SDK does not expose `client.mcp.call()` — plugins cannot invoke MCP tools from code. Joplin is therefore accessed directly via its Web Clipper REST API. The plugin uses `/search` (FTS5) for lookups and `/notes/:id` for direct reads, matching what the MCP server does internally.

## Three growth loops, three friction tiers

| Loop | Latency | Friction | What changes |
|---|---|---|---|
| **Memory loop** | Per-session | Zero (silent writes) | Joplin Decisions + Memories accumulate |
| **Skill loop** | Per-week-ish | Low (one prompt at `/promote`) | New skill files added to opencode skills dir |
| **Rules loop** | Per-month-ish | Medium (diff review) | `AGENTS.md` evolves with new general truths |

## Data flow — silent reflection path

```
Time 0:00   User asks a question. Agent answers. Tool calls happen.
Time 0:01   session.idle fires → schedule timer for +3min.
Time 0:02   User types again → lastActivityTs updates, timer re-schedules.
Time 3:01   Timer fires. reflect() runs — NOT awaited.
Time 3:01.1 reflect() fetches transcript and POSTs to LLM endpoint.
            User can keep typing. No lag.
Time 3:04   reflect() resolves with structured JSON.
Time 3:04.1 Plugin appends to "Decisions — 2026-05" via Joplin REST. Silent.
            No skill candidates, no AGENTS.md proposals → nothing shown.
            User never noticed.
```

## Two-tier bootstrap projection (v2)

`gatherBootstrapData` parses the current + previous month's Memories and Decisions notes via `JoplinClient.parseEntries` (dual-format: reads both v1 and v2). Entries are split into two tiers: *active* (project matches current repo, last 7d, top 12 by significance) and *other* (different project, last 3d, sig ≥ 6, top 7). `composeBootstrapMessage` renders these as `### Active repo` and `### Other recent work` sections. Target: ≤1.6 KB total injection.

Renderers `renderDecision`, `renderMemory`, and `renderLearning` now emit compact v2 format (multi-line key:value blocks with `proj`, `sig`, `why`, `chose`/`did`, `vs`/`files`, `loose` fields). The older v1 prose format is still parsed for backward compatibility but no longer written.

## What stays in scope

- TypeScript plugin (13 source files)
- Three slash skills (`/wrap`, `/promote`, `/agents-edit`)
- A documented HTTP contract for pluggable memory backends
- Four Joplin note types (Project Notes removed in v2)

## What's explicitly out of scope (v1)

- Web/dashboard UI for browsing learnings → use Joplin UI
- Config file → env vars only
- Multi-machine sync → single machine
- Embedding-based pattern detection → exact-signature matching only
- Mobile / voice interface → opencode is terminal-based

See [`docs/design.md` § 13](./docs/design.md#13-whats-explicitly-deferred-not-in-v1) for the full list.
