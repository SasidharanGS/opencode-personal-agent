# Adapter: Letta (MemGPT)

[Letta](https://github.com/letta-ai/letta) (formerly MemGPT) is a server-based agent platform with persistent self-editing memory blocks. Letta is significantly heavier than what this plugin needs — but if you already run a Letta server for other agents, you can reuse it as the memory backend.

## Setup

1. Install Letta and create a personal agent ([Letta docs](https://docs.letta.com/)).
2. Note the agent's ID and Letta server URL (default `http://localhost:8283`).
3. Write a small adapter shim that fronts Letta's API with the v1 contract.

## Contract mapping

| Plugin endpoint | Letta endpoint | Notes |
|---|---|---|
| `GET /activities?date=YYYY-MM-DD` | None native. | Letta isn't an activity tracker. Either skip activities (plugin tolerates absence) or populate Letta's archival memory with activity records via a separate ingestion script. |
| `POST /query` | `POST /v1/agents/{agent_id}/messages/search` (or archival memory search) | Letta supports searching across an agent's archival memory. Map directly. |
| `GET /status` | `GET /v1/health` | Direct map. |

## Skeleton shim

```python
# letta_adapter.py — minimal FastAPI wrapper
import os, httpx
from fastapi import FastAPI
from datetime import datetime, timezone

LETTA_BASE  = os.getenv("LETTA_URL", "http://127.0.0.1:8283")
AGENT_ID    = os.getenv("LETTA_AGENT_ID")  # required
LETTA_TOKEN = os.getenv("LETTA_TOKEN", "")

app = FastAPI()

@app.get("/status")
async def status():
    async with httpx.AsyncClient() as c:
        r = await c.get(f"{LETTA_BASE}/v1/health")
    return {"ok": r.status_code == 200}

@app.get("/activities")
async def activities(date: str):
    # Letta doesn't track activities natively. Return empty.
    # Or query archival memory for entries tagged type=activity if you populate that yourself.
    return []

@app.post("/query")
async def query(body: dict):
    question = body.get("question", "")
    n        = body.get("n_results", 5)
    headers = {"Authorization": f"Bearer {LETTA_TOKEN}"} if LETTA_TOKEN else {}
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.post(
            f"{LETTA_BASE}/v1/agents/{AGENT_ID}/archival-memory/search",
            json={"query": question, "limit": n},
            headers=headers,
        )
    items = r.json() if r.is_success else []
    return {
        "results": [
            {
                "text": item.get("text", ""),
                "metadata": {"timestamp": item.get("created_at", datetime.now(timezone.utc).isoformat())},
                "score": item.get("score", 0.0),
            }
            for item in items
        ]
    }
```

Run with `uvicorn letta_adapter:app --port 7843` and point the plugin at it.

## Is this worth it?

If you already run Letta for other agent workflows, yes — reuse it. If you're choosing a memory backend from scratch specifically for this plugin, **don't pick Letta** — it's a full agent server and the plugin only uses a tiny slice. 2brn or a custom 80-LOC service is a better fit.
