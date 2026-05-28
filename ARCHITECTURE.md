# Architecture

One-page summary. For the full spec see [`docs/design.md`](./docs/design.md).

## The shape

```
┌──────────────────────────────────────────────────────────────────────┐
│  opencode TUI (your terminal agent — unchanged)                      │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Plugin: personal-agent.ts  (~300 LOC, single TS file)          │  │
│  │                                                                │  │
│  │  Hooks:                                                        │  │
│  │   • session.created  → MemoryBootstrap.inject()                │  │
│  │   • session.idle     → IdleWatcher → 3-min debounce → reflect()│  │
│  │   • tool.execute.*   → PatternTracker.record()                 │  │
│  │   • experimental.session.compacting → re-inject memory         │  │
│  │   • tui.command.execute → dispatch /wrap, /promote, /agents-edit│ │
│  └────────────────────────────────────────────────────────────────┘  │
│         │                       │                          │         │
└─────────┼───────────────────────┼──────────────────────────┼─────────┘
          │                       │                          │
   ┌──────▼────────────┐  ┌───────▼──────────────┐  ┌────────▼─────────────┐
   │ LLM endpoint      │  │ Joplin MCP server    │  │ Memory backend       │
   │ (configurable)    │  │ (community / your    │  │ (optional, pluggable)│
   │                   │  │  own choice)         │  │                      │
   │ • OpenAI-         │  │                      │  │ Any HTTP service     │
   │   compatible      │  │ Tools used:          │  │ implementing the     │
   │   chat endpoint   │  │ • search_notes       │  │ adapter contract:    │
   │ • Used for the    │  │ • get_note           │  │  • GET /activities   │
   │   3-min reflection│  │ • append_to_note     │  │  • POST /query       │
   │   and AGENTS.md   │  │ • create_note        │  │ Examples: 2brn,      │
   │   diff generation │  │                      │  │  Mem0, Letta, custom │
   └───────────────────┘  └──────────┬───────────┘  └──────────────────────┘
                                     │
                                     ▼
                          ┌────────────────────────────────────┐
                          │ Your Joplin SQLite                 │
                          │                                    │
                          │ Notes the plugin reads & writes:   │
                          │ • Decisions — YYYY-MM              │
                          │ • Memories — YYYY-MM               │
                          │ • Agent Learnings — YYYY-MM        │
                          │ • Skills Proposed (single rolling) │
                          └────────────────────────────────────┘
```

## Why a plugin, not a separate process

1. **State locality.** The plugin observes tool calls, session events, and injects system messages — all inside opencode's event loop. A separate process would need IPC for every event.
2. **Lifecycle alignment.** Plugin lives exactly as long as the opencode session. No daemon to babysit, no port conflicts.
3. **User stays the host.** All decisions are made inside opencode. The plugin only orchestrates external services (Joplin, memory backend, LLM endpoint).

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
Time 0:02   User types again → lastActivityTs updates, next idle re-schedules.
Time 0:06   3-min idle reached. reflect() runs — NOT awaited.
Time 0:06.1 reflect() begins fetching transcript and POSTing to LLM endpoint.
            User can keep typing. No lag.
Time 0:09   reflect() resolves with structured JSON.
Time 0:09.1 Plugin appends to "Decisions — 2026-05" via Joplin MCP. Silent.
            No skill candidates, no AGENTS.md proposals → no toast shown.
            User never noticed.
```

## What stays in scope

- One TypeScript plugin file
- Three slash skills (`/wrap`, `/promote`, `/agents-edit`)
- A documented HTTP contract for pluggable memory backends
- Four Joplin note conventions

## What's explicitly out of scope (v1)

- Web/dashboard UI for browsing learnings → use Joplin UI
- Config file → hardcoded constants at top of plugin, env vars override
- Multi-machine sync → single machine
- Embedding-based pattern detection → exact-signature only for v1
- Mobile / voice interface → opencode is terminal-only

See [`docs/design.md` § 13](./docs/design.md#13-whats-explicitly-deferred-not-in-v1) for the full list.
