# Adapter: Mem0

[Mem0](https://github.com/mem0ai/mem0) is an open-source memory layer for AI agents. It exposes a REST API for storing and querying memories with vector + graph backing.

Mem0 does NOT natively expose "what was the user doing today" — it's a generic memory store, not an activity tracker. So with Mem0 as your backend, the plugin will have a useful `/query` but a sparse `/activities`. This is fine — Joplin Decisions + Memories notes still provide rich session-start context.

## Setup

1. Install and run Mem0 per [their docs](https://docs.mem0.ai/). Either the SaaS or the self-hosted server.
2. Decide on a `user_id` for your personal memories (e.g., `"sasidharan"`).
3. Write a small adapter shim (~80 LOC Node or Python) that fronts Mem0 with the v1 contract.

## Contract mapping

| Plugin endpoint | Mem0 endpoint | Notes |
|---|---|---|
| `GET /activities?date=YYYY-MM-DD` | `POST /v1/memories/search` with date metadata filter | Mem0 has no concept of "activity" per se. Query for memories tagged `type=activity` and `date=<date>`. Returns sparse data unless you populate Mem0 with activity events yourself. |
| `POST /query` | `POST /v1/memories/search` | Direct semantic search. Map plugin's `question` to Mem0's `query`. |
| `GET /status` | `GET /health` (or root) | Health check. |

## Skeleton shim (Node, Bun)

```ts
// mem0-adapter.ts — run on a free local port, e.g. 7843
import { serve } from "bun"

const MEM0_BASE = process.env.MEM0_URL ?? "http://127.0.0.1:7777"
const MEM0_USER = process.env.MEM0_USER ?? "default"

serve({
  port: 7843,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === "/status") return new Response("ok")

    if (url.pathname === "/activities") {
      const date = url.searchParams.get("date") ?? ""
      const r = await fetch(`${MEM0_BASE}/v1/memories/search`, {
        method: "POST",
        body: JSON.stringify({
          user_id: MEM0_USER,
          query: "activity",
          filters: { type: "activity", date }
        }),
      })
      const j = await r.json()
      return Response.json(j.results?.map((m: any) => ({
        started_at: m.metadata?.timestamp,
        summary: m.memory,
        app_name: m.metadata?.app_name,
        task_category: m.metadata?.task_category,
      })) ?? [])
    }

    if (url.pathname === "/query") {
      const { question, n_results = 5 } = await req.json() as any
      const r = await fetch(`${MEM0_BASE}/v1/memories/search`, {
        method: "POST",
        body: JSON.stringify({
          user_id: MEM0_USER,
          query: question,
          limit: n_results,
        }),
      })
      const j = await r.json()
      return Response.json({
        results: j.results?.map((m: any) => ({
          text: m.memory,
          metadata: { timestamp: m.metadata?.timestamp ?? new Date().toISOString() },
          score: m.score,
        })) ?? []
      })
    }

    return new Response("not found", { status: 404 })
  },
})
```

Then point the plugin at the shim:

```bash
export OPENCODE_PA_MEMORY_URL="http://127.0.0.1:7843"
```

## When to use Mem0 vs alternatives

- **Choose Mem0** if you already use it for other agents, or want hosted memory.
- **Choose 2brn** if you want activity capture out of the box.
- **Choose Letta** if you also want the agent runtime; overkill for just memory.
- **Roll your own** if your needs are simple (see [custom.md](./custom.md)).
