# opencode-personal-agent

> Turn [opencode](https://opencode.ai) into a personal AI agent that remembers, reflects, and grows with you — minimally, without a new daemon.

[![Status](https://img.shields.io/badge/status-shipped-green)](./docs/design.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Plugin](https://img.shields.io/badge/opencode-plugin-blue)](https://opencode.ai/docs/plugins)

---

## What this is

A small opencode plugin (TypeScript, ~1800 LOC across 13 files) plus three slash skills that give your opencode sessions three new properties:

| Property | What it means in practice |
|---|---|
| **Memory** | Each session wakes up already knowing what you've been working on, what you've decided, and recent activity. No more cold starts. |
| **Reflection** | After 3 minutes of idle, the plugin runs a background LLM call that silently saves new decisions and memories to Joplin. Zero friction. |
| **Growth** | The plugin watches your tool usage. When it sees a pattern repeat ≥ 3 times, it offers to turn it into a skill. When it sees a cross-session correction ≥ 2 times, it proposes an `AGENTS.md` edit you can review. |

Nothing autonomous — every change to skills or `AGENTS.md` requires your explicit approval. Notes are written silently by design.

---

## How it works

A single TypeScript plugin loads inside opencode. On startup it fetches all existing sessions and bootstraps each one with memory context from Joplin. On `session.created` it does the same for new sessions. On `session.idle` (3 minutes by default) it fires a non-blocking background reflection call to your LLM endpoint, parses the structured JSON response, and silently appends new decisions, memories, and agent-learnings to your Joplin notes. On `tool.execute.before` it tracks normalised tool-call signatures; when a pattern repeats 3 times it gets flagged for `/promote`. When a behaviour correction recurs across 2+ sessions, it gets flagged for `/agents-edit`.

Joplin is accessed directly via its Web Clipper REST API (`GET /search`, `GET /notes/:id`, `POST /notes`, `PUT /notes/:id`). No Joplin MCP server required.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the diagram and [`docs/design.md`](./docs/design.md) for the full spec.

---

## Memory bootstrap

On each session start the plugin injects a compact memory block into the system prompt. Example output:

```
proj: opencode-personal-agent
today: VSCode 2h, Terminal 1h, Joplin 30m

### Active repo (last 7d, ranked by sig)
- 06-06 14:32 [d sig:9] Inject stub tools at schema-proxy — Reconstruct tools at proxy
- 06-06 13:18 [m sig:8] Joplin dedup script merged 85 notes — Cleaned Personal Agent notebook

### Other recent work (last 3d, top 7 by sig ≥6)
- 06-06 11:00 [2brn] Timezone bug fixed at daemon level
- 06-06 10:50 [jll-schema-proxy] toolConfig root-caused

### Agent Learnings
<contents of agent-learnings.md>

_End memory bootstrap. Continue normally._
```

Constants in `src/bootstrap.ts`: `BOOTSTRAP_ACTIVE_CAP=12`, `BOOTSTRAP_OTHER_CAP=7`, `BOOTSTRAP_OTHER_SIG_THRESHOLD=6`.

---

## Schema (v2 compact)

All Joplin notes written since 2026-06-06 use v2 compact format. The parser (`JoplinClient.parseEntries`) reads both v1 and v2 formats for backward compatibility.

**Memory entry:**

```
## 2026-06-06 14:32 — Dedup script merged 85 notes
proj: opencode-personal-agent · sig: 8
why: Duplicate-notes bug created 11 title groups
did: Cleaned Personal Agent notebook
files: scripts/dedup-notes.ts
loose: monitor for re-emergence
```

**Decision entry:**

```
## 2026-06-06 14:32 — Inject stub tools at proxy
proj: jll-schema-proxy · sig: 9
why: Bedrock rejects /compact
chose: Reconstruct tools; tool_choice:none
vs: strip blocks — loses context; fix Falcon — not owned
```

**Learning entry:**

```
## 2026-06-06 14:32 — User prefers Joplin /search not /notes
type: preference_expressed · sig: 8 · seen: 3
observed: User prefers Joplin /search not /notes
action: AGENTS.md edit (proposed_agents_edit)
```

---

## Requirements

- **[opencode](https://opencode.ai)** — the agent runtime
- **[Joplin](https://joplinapp.org/) desktop** with Web Clipper enabled — notes store, must be running for writes
- **An LLM endpoint** — any OpenAI-compatible chat completions endpoint (Anthropic, OpenAI, Gemini, Azure OpenAI, LM Studio, your gateway). Used for background reflection.
- **Optional**: an ambient memory backend (Mem0 / Letta / a custom HTTP service / [2brn](https://github.com/SasidharanGS/2brn)) implementing the [adapter contract](./docs/adapters/). Without one the plugin still works — it just won't have "what you were doing today" context.

---

## Quickstart

### 1. Add the plugin to `~/.config/opencode/opencode.jsonc`

```jsonc
{
  "plugin": [
    "opencode-personal-agent@git+https://github.com/SasidharanGS/opencode-personal-agent.git"
  ]
}
```

opencode clones the repo into its package cache and loads the bundled `dist/plugin.js` on next launch. On first load the plugin copies its bundled skills and slash command files into `~/.config/opencode/` — only when they don't already exist, so your edits are never overwritten. Set `OPENCODE_PA_SKIP_AUTO_INSTALL=1` to disable.

### 2. Get your Joplin Web Clipper token

In Joplin: **Tools → Options → Web Clipper** → enable the service → copy the token.

### 3. Set environment variables

```bash
# Required — LLM endpoint for background reflection:
export OPENCODE_PA_LLM_URL="https://your-openai-compatible-endpoint/v1"
export OPENCODE_PA_LLM_KEY="your-api-key"
export OPENCODE_PA_LLM_MODEL="claude-sonnet-4-6"

# Required — Joplin writes:
export JOPLIN_TOKEN="your-web-clipper-token"
export JOPLIN_PORT="41184"                           # default, change if needed
export OPENCODE_PA_JOPLIN_NOTEBOOK="Personal Agent"  # notebook all notes land in

# Optional — ambient memory backend:
export OPENCODE_PA_MEMORY_URL="http://127.0.0.1:7842"
```

Put these in `~/.zshrc` or `~/.zshenv` (the latter is read by GUI apps).

### 4. Restart opencode

`/wrap`, `/promote`, and `/agents-edit` will be available. Idle reflection runs automatically.

### Updating

opencode caches the git package at `~/.cache/opencode/packages/opencode-personal-agent*`. To pull the latest:

```bash
rm -rf ~/.cache/opencode/packages/opencode-personal-agent*
```

Restart opencode. The plugin re-clones and new skills/commands auto-install on next load.

---

## Slash commands

| Command | What it does |
|---|---|
| `/wrap` | Forces an immediate reflection (synchronous), then shows a summary of what was saved plus any pending skill candidates and AGENTS.md proposals. |
| `/promote <name>` | Promotes a flagged tool-usage pattern into an installed skill. Asks global vs project scope, drafts SKILL.md, shows diff, writes on approval. |
| `/agents-edit` | Reviews pending AGENTS.md proposals (cross-session evidence ≥ 2). Shows LLM-generated diff, apply / skip / edit. |

---

## Notes created by the plugin

All notes land in the notebook configured by `OPENCODE_PA_JOPLIN_NOTEBOOK` (default: `"Personal Agent"`).

| Note | Naming | Created when |
|---|---|---|
| Decisions | `Decisions — YYYY-MM` | First decision written in that month |
| Memories | `Memories — YYYY-MM` | First memory written in that month |
| Agent Learnings | `Agent Learnings — YYYY-MM` | First learning written in that month |
| Skills Proposed | `Skills Proposed` | First pattern flagged for `/promote` |

Monthly notes roll over each month.

> **Note:** The `Project Notes — <projectTag>` mirror entity was removed in v2. Migration applied 2026-06-06. Existing Project Notes in Joplin are no longer written to or read from.

---

## Configuration reference

All config is via environment variables. Defaults shown.

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_PA_LLM_URL` | `http://127.0.0.1:8889/v1` | OpenAI-compatible chat completions base URL |
| `OPENCODE_PA_LLM_KEY` | `1` | API key for the LLM endpoint |
| `OPENCODE_PA_LLM_MODEL` | `CLAUDE_4_6_SONNET` | Model ID to use for reflections |
| `JOPLIN_TOKEN` | _(empty)_ | Joplin Web Clipper token — required for writes |
| `OPENCODE_PA_JOPLIN_TOKEN` | falls back to `JOPLIN_TOKEN` | Override token specifically for the plugin |
| `JOPLIN_PORT` | `41184` | Joplin Web Clipper port |
| `OPENCODE_PA_JOPLIN_NOTEBOOK` | `Second Brain` | Notebook all plugin notes are created in |
| `OPENCODE_PA_MEMORY_URL` | _(none)_ | Optional memory backend base URL |
| `OPENCODE_PA_IDLE_MS` | `180000` (3 min) | Idle threshold before reflection triggers |
| `OPENCODE_PA_DEDUPE_MS` | `120000` (2 min) | Minimum gap between two reflections |
| `OPENCODE_PA_PATTERN_THRESHOLD` | `3` | Tool-call repetitions before pattern is flagged |
| `OPENCODE_PA_PROJECT_MAP` | `{}` | JSON map of `{"dir-name": "ProjectTag"}` overrides |
| `OPENCODE_PA_SKIP_AUTO_INSTALL` | _(unset)_ | Set to `1` to skip auto-installing skills/commands |

---

## Files installed on first load

The plugin copies these into `~/.config/opencode/` on first run (never overwrites):

```
~/.config/opencode/
├── commands/
│   ├── wrap.md
│   ├── promote.md
│   └── agents-edit.md
└── skills/
    ├── wrap/SKILL.md
    ├── promote/SKILL.md
    └── agents-edit/SKILL.md
```

---

## Design principles

1. **No new daemon.** Everything runs as an opencode plugin in opencode's own event loop.
2. **No new database.** Joplin (via its Web Clipper REST API) is the durable store.
3. **Low friction by default.** Silent saves for decisions and memories. Explicit approval only for skill installation and `AGENTS.md` edits.
4. **Never silent-edit `AGENTS.md`.** Cross-session evidence threshold + diff review + user approval every time.
5. **Local-first.** Joplin is local. Memory backends are local. The only outbound call is to your configured LLM endpoint.
6. **Graceful degradation.** If Joplin is down, the memory backend is down, or the LLM times out, the plugin logs a warning and keeps the session usable.

---

## Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — One-page architecture summary with block diagram.
- **[docs/design.md](./docs/design.md)** — Full design spec. Component-level detail, algorithms, error handling, test plan.
- **[docs/adapters/](./docs/adapters/)** — HTTP contract for optional memory backends. Reference adapters for 2brn, Mem0, Letta.
- **[examples/](./examples/)** — Sample opencode config snippet and Joplin note format examples.

---

## License

[MIT](./LICENSE) © 2026 Sasidharan GS
