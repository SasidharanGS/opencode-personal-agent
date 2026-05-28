# Memory Backend Adapters

The `opencode-personal-agent` plugin can optionally consult an **ambient memory backend** during `session.created` to inject context like "what apps you were using today" or "what notes you read recently". This is the difference between an agent that wakes up knowing nothing and one that wakes up knowing where you left off.

The plugin doesn't care which backend you use. It speaks **one simple HTTP contract** and any service that implements it can be plugged in.

---

## The contract (v1)

A memory backend is any HTTP service reachable from your local machine that implements these endpoints:

### `GET /activities?date=YYYY-MM-DD`

**Purpose**: Return a coarse summary of what you were doing on the given date.

**Response** — JSON array of activity records. Each record:

```json
{
  "started_at": "2026-05-28T09:14:32Z",
  "ended_at":   "2026-05-28T09:51:08Z",
  "summary":    "Editing TypeScript files in opencode-personal-agent repo",
  "app_name":   "VS Code",
  "task_category": "coding",
  "productivity_state": "deep_work"
}
```

Fields:

| Field | Required | Notes |
|---|---|---|
| `started_at` | yes | ISO 8601 UTC |
| `summary`    | yes | One sentence. The plugin uses this as the bootstrap context. |
| `app_name`   | no  | Top app during the activity |
| `ended_at`   | no  | ISO 8601 UTC |
| `task_category` | no | Free-form. The plugin doesn't filter on it. |
| `productivity_state` | no | Free-form. The plugin doesn't filter on it. |

The plugin requests today's activities and picks the **top 3** by duration for context injection.

### `POST /query`

**Purpose**: Semantic search across the backend's full memory. Used during `/wrap` reflection when the plugin needs to look up "have we discussed this before?".

**Request body**:

```json
{
  "question": "what did we decide about the joplin watcher polling interval?",
  "n_results": 5,
  "date_filter": "2026-05-28"
}
```

**Response** — JSON object:

```json
{
  "results": [
    {
      "text": "User decided to poll Joplin SQLite every 60s rather than use webhooks...",
      "metadata": {
        "source": "activity",
        "timestamp": "2026-05-15T14:22:00Z",
        "title": "Joplin watcher design"
      },
      "score": 0.83
    }
  ]
}
```

Required fields per result: `text` (string), `metadata.timestamp` (ISO 8601 UTC). All others optional.

### `GET /status` (optional but recommended)

**Purpose**: Health check. The plugin calls this once at startup; if it returns non-2xx or times out (>2s), the plugin disables backend lookups for that session and proceeds with Joplin-only context.

**Response**: any 2xx. Body ignored.

---

## Plugging in a backend

In your opencode config or env var:

```bash
export OPENCODE_PA_MEMORY_URL="http://127.0.0.1:7842"
```

That's it. If the URL is unset, the plugin runs in Joplin-only mode — no errors, no warnings beyond a single startup info log.

---

## Reference adapters

The repo doesn't ship adapter code (none is needed — the contract is just HTTP). It does ship documentation for how to satisfy the contract on top of popular memory systems:

- **[2brn](./two-brn.md)** — a personal-use ambient memory daemon (screen capture + OCR + Joplin indexing). Native fit: implements the contract directly out of the box.
- **[Mem0](./mem0.md)** — open-source memory layer. Wrap their API as the contract.
- **[Letta (MemGPT)](./letta.md)** — full agent server with persistent memory. Wrap their `/v1/agents/{id}/messages` search as the contract.
- **[Custom](./custom.md)** — minimal Python/Node skeleton you can copy-paste into a 50-line service.

---

## Why this contract is so small

Larger memory APIs (Mem0, Letta, Zep) expose many endpoints — entity types, graphs, agent state, etc. The plugin only needs two questions answered:

1. *What was the user doing today?*
2. *Have we touched on X before?*

Everything else lives in Joplin (the durable store) and in the LLM call (the reasoning). Keeping the contract this small means a backend takes 30 minutes to write, not 3 days.

---

## Versioning

The contract is currently **v1**. If breaking changes are needed, future versions will be opt-in via an `Accept-Version: 2` header. v1 will stay supported.
