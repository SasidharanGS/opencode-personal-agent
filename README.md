# opencode-personal-agent

> Turn [opencode](https://opencode.ai) into a personal AI agent that remembers, reflects, and grows with you — minimally, without a new daemon.

[![Status](https://img.shields.io/badge/status-design-orange)](./docs/design.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Plugin](https://img.shields.io/badge/opencode-plugin-blue)](https://opencode.ai/docs/plugins)

---

## Status: Design phase

**No code has shipped yet.** This repository currently holds the design specification, architecture, and adapter contracts. Implementation will land as commits against the phases described in [`docs/design.md`](./docs/design.md).

If you'd like to follow along, watch the repo or open a discussion.

---

## What this is

A small opencode plugin (TypeScript, ~300 LOC) plus three slash skills that give your opencode sessions three new properties:

| Property | What it means in practice |
|---|---|
| **Memory** | Each session wakes up already knowing what you've been working on, what you've decided, and recent activity. No more cold starts. |
| **Reflection** | Every 3 minutes of idle, the plugin runs a background LLM call that silently saves new decisions and memories to your notes app (Joplin). Zero friction. |
| **Growth** | The plugin watches your tool usage. When it sees a pattern repeat, it offers to turn it into a real skill. When it sees a cross-session correction, it proposes an `AGENTS.md` edit you can review. |

Nothing autonomous — every change to skills or `AGENTS.md` requires your explicit approval. Notes are written silently by design.

---

## Why this exists

Existing personal-agent stacks are either heavyweight (Letta, MemGPT) or coding-only (Cursor, Aider, Continue). Hand-written `AGENTS.md` / `CLAUDE.md` files don't update themselves. Cursor rules don't either. Meanwhile, opencode already has rich plugin hooks (`session.created`, `session.idle`, `tool.execute.*`) and the open-source ecosystem already has notes apps (Joplin) and memory backends (Mem0, Letta, custom) that solve memory well in isolation.

The gap is the **integration glue**: a small layer that lets opencode read from your notes app on session start, write reflections on idle, watch your tool patterns, and propose changes to its own instructions. That's all this project is.

If you already have a notes app you trust and a coding agent you like, this connects them.

---

## How it works (one paragraph)

A single TypeScript plugin loads inside opencode. On `session.created` it queries your Joplin notes (Decisions, Memories) and an optional memory backend (any HTTP service implementing the [adapter contract](./docs/adapters/)), then injects ~400 tokens of context as a system message. On `session.idle` (3 minutes), it fires a non-blocking background reflection call to an LLM, parses the JSON response, and silently appends new decisions, memories, and agent-learnings to your notes. On `tool.execute.before` it tracks normalized tool-call signatures; when a pattern repeats 3 times it gets flagged for `/promote` (skill creation). When a behavior correction recurs across 2+ sessions, it gets flagged for `/agents-edit` (AGENTS.md proposal). Three slash skills — `/wrap`, `/promote`, `/agents-edit` — handle the user-facing moments.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the diagram, [`docs/design.md`](./docs/design.md) for the full spec.

---

## Requirements

When implemented, you'll need:

- **opencode** — the agent runtime ([install](https://opencode.ai))
- **[Joplin](https://joplinapp.org/)** desktop with Web Clipper enabled — decisions and memories store
- **Joplin MCP server** — there are several; any one with `search_notes`, `get_note`, `append_to_note`, `create_note` tools works
- **An LLM endpoint** — any OpenAI-compatible chat completions endpoint (Anthropic, OpenAI, Gemini, Azure OpenAI, LM Studio, your-own-gateway). Configured via env var.
- **Optional**: an ambient memory backend (Mem0 / Letta / a custom HTTP service / [2brn](https://github.com/SasidharanGS/2brn)) implementing the [adapter contract](./docs/adapters/). Without one, the plugin still works — it just won't have "what you were doing today" context, only Joplin notes.

---

## Quickstart (placeholder — Phase 1 not shipped yet)

```bash
# Will work after Phase 1 ships:
cd ~/.config/opencode/plugins
git clone https://github.com/SasidharanGS/opencode-personal-agent.git
# Then symlink or copy the plugin file:
ln -s opencode-personal-agent/dist/personal-agent.js .

# Set env vars (or put in opencode.jsonc):
export OPENCODE_PA_LLM_URL="https://your-openai-compatible-endpoint/v1"
export OPENCODE_PA_LLM_KEY="..."
export OPENCODE_PA_LLM_MODEL="claude-3-5-sonnet"
export OPENCODE_PA_MEMORY_URL="http://127.0.0.1:7842"   # optional
export OPENCODE_PA_JOPLIN_NOTEBOOK="Second Brain"       # or whatever you use

# Then just run opencode normally:
opencode
```

Until then, the [design spec](./docs/design.md) is the canonical reference.

---

## Roadmap

Implementation lands in five phases. Each phase is independently useful.

| Phase | Deliverable | Status |
|---|---|---|
| 1 | Plugin scaffold + session.created memory bootstrap | **Shipped (awaiting review)** |
| 2 | Idle watcher + background reflection (silent Joplin writes) | **Shipped (awaiting review)** |
| 3 | `/wrap` slash skill (session summary) | **Shipped (awaiting review)** |
| 4 | Pattern detection + `/promote` slash skill | Not started |
| 5 | Cross-session learnings + `/agents-edit` slash skill | Not started |

Each phase has explicit acceptance criteria in [`docs/design.md` § 9](./docs/design.md#9-implementation-phases).

---

## Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — One-page architecture summary with block diagram. Start here.
- **[docs/design.md](./docs/design.md)** — Full design spec (~1100 lines). Component-level detail, algorithms, error handling, test plan.
- **[docs/adapters/](./docs/adapters/)** — HTTP contract for memory backends. Reference adapters for 2brn, Mem0, Letta.
- **[examples/](./examples/)** — Sample opencode config snippet, sample Joplin note formats for Decisions / Memories / Agent Learnings / Skills Proposed.

---

## Design principles

These are intentionally non-negotiable:

1. **No new daemon.** Everything runs as an opencode plugin in opencode's own event loop.
2. **No new database.** Joplin SQLite (via the Joplin MCP server) is the durable store. Memory backends are optional and pluggable.
3. **Low friction by default.** Silent saves for decisions and memories. Explicit approval gates only for skill installation and `AGENTS.md` edits.
4. **Never silent-edit AGENTS.md.** Cross-session evidence threshold + diff review + user approval — every time.
5. **Local-first.** Joplin is local. Memory backends are local. The only outbound HTTP call is to your chosen LLM endpoint, which is configurable.
6. **Graceful degradation.** If Joplin is down, memory backend is down, or the LLM endpoint times out, the plugin logs a warning and keeps the session usable. Never blocks.

---

## Contributing

This is currently a one-person design project, in the design phase. Once Phase 1 lands, contributions will be welcome via PRs and issues.

For now, the most useful contribution is feedback on the design spec — open a GitHub Discussion or Issue with comments/critique.

---

## License

[MIT](./LICENSE) © 2026 Sasidharan GS
