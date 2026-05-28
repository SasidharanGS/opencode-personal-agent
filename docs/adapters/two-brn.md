# Adapter: 2brn

[2brn](https://github.com/SasidharanGS/2brn) is an open-source personal memory daemon: it captures screenshots, OCRs them, classifies activities, and indexes your notes app (Joplin). It runs as a local FastAPI service.

2brn implements the v1 memory backend contract **natively** — no adapter shim needed. Just point the plugin at its HTTP port.

## Setup

1. Install and start 2brn per [its README](https://github.com/SasidharanGS/2brn).
2. Confirm it's running:
   ```bash
   curl http://127.0.0.1:7842/status
   ```
3. Point the plugin at it:
   ```bash
   export OPENCODE_PA_MEMORY_URL="http://127.0.0.1:7842"
   ```

## Contract coverage

| Plugin endpoint | 2brn endpoint | Notes |
|---|---|---|
| `GET /activities?date=YYYY-MM-DD` | `GET /activities?date=YYYY-MM-DD` | Direct match. Returns activity records with `summary`, `app_name`, `task_category`, `productivity_state`. |
| `POST /query` | `POST /chat` | 2brn's `/chat` is RAG (returns SSE stream); a small shim is needed to convert to the synchronous JSON shape the plugin expects. See below. |
| `GET /status` | `GET /status` | Direct match. |

## `/query` shim

2brn's `/chat` endpoint streams an answer rather than returning raw search hits. If you want true semantic-search hits (more useful for the plugin), one of two patterns works:

**Option A — request raw hits from 2brn's internal Chroma directly**: add a small `/query` route to 2brn (~30 LOC) that does the embedding + Chroma query without the LLM step. Recommended.

**Option B — use the SSE chat output as-is**: the plugin won't get raw documents, but the LLM-paraphrased answer is fine for context injection. Implement a 50-line FastAPI wrapper that:

1. Receives `POST /query` per the contract
2. Forwards `question` to 2brn's `/chat`
3. Collects the SSE chunks into one string
4. Returns `{ "results": [{ "text": "<answer>", "metadata": { "timestamp": "<now>", "source": "2brn-rag" } }] }`

Either works.

## Caveats

- 2brn captures screenshots. Make sure your screenshot encryption is configured before running on a sensitive machine. The plugin does NOT send screenshots anywhere — only the JSON activity summary strings from `/activities`.
- 2brn polls Joplin every 60 seconds, so the very latest Joplin notes may take up to a minute to appear in 2brn's `/query` results. For freshly-written decisions, the plugin reads Joplin directly via the Joplin MCP server, not via 2brn.

## Why a separate adapter doc when 2brn is a "native fit"?

Documenting the integration explicitly means future versions of 2brn (or alternative ports of it) can target the same contract. It also clarifies what the plugin actually needs from 2brn — useful if you're forking either side.
