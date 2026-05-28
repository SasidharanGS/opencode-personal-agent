# Adapter: Custom (build your own)

If you don't need a heavyweight memory layer, you can satisfy the v1 contract with a tiny service of your own. Below is a working skeleton in two languages.

## Minimum requirements

- Stores memories somewhere (SQLite, JSON file, in-memory dict — your choice).
- Can return today's activities (even if you populate this manually or via a cron).
- Can do basic full-text or semantic search on `POST /query`.

## Python skeleton (~80 LOC)

```python
# memory_adapter.py — minimal personal memory adapter
import json, sqlite3, time
from pathlib import Path
from fastapi import FastAPI
from pydantic import BaseModel
from datetime import datetime, timezone, date as dt_date

DB = Path.home() / ".local/share/opencode-personal-agent/memory.sqlite"
DB.parent.mkdir(parents=True, exist_ok=True)

app = FastAPI()

def conn():
    c = sqlite3.connect(DB)
    c.execute("""CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        text TEXT NOT NULL,
        kind TEXT NOT NULL,             -- 'activity' or 'note'
        app_name TEXT, task_category TEXT
    )""")
    return c

@app.get("/status")
async def status():
    return {"ok": True}

@app.get("/activities")
async def activities(date: str):
    c = conn()
    rows = c.execute(
        "SELECT ts, text, app_name, task_category "
        "FROM memories WHERE kind='activity' AND substr(ts,1,10)=? "
        "ORDER BY ts DESC LIMIT 50",
        (date,)
    ).fetchall()
    return [
        {"started_at": ts, "summary": text, "app_name": app, "task_category": cat}
        for ts, text, app, cat in rows
    ]

class Query(BaseModel):
    question: str
    n_results: int = 5
    date_filter: str | None = None

@app.post("/query")
async def query(body: Query):
    # Naive substring/LIKE search. Replace with FTS5 or a vector store
    # if you want better recall.
    c = conn()
    rows = c.execute(
        "SELECT ts, text FROM memories "
        "WHERE text LIKE ? ORDER BY ts DESC LIMIT ?",
        (f"%{body.question}%", body.n_results)
    ).fetchall()
    return {
        "results": [
            {"text": text, "metadata": {"timestamp": ts}, "score": 0.5}
            for ts, text in rows
        ]
    }

class Ingest(BaseModel):
    text: str
    kind: str = "activity"  # or 'note'
    app_name: str | None = None
    task_category: str | None = None

@app.post("/ingest")
async def ingest(body: Ingest):
    # Not part of the v1 contract — add this if you want a simple way to
    # populate memories from cron jobs, hooks, or other scripts.
    c = conn()
    c.execute(
        "INSERT INTO memories (ts, text, kind, app_name, task_category) VALUES (?,?,?,?,?)",
        (datetime.now(timezone.utc).isoformat(), body.text, body.kind,
         body.app_name, body.task_category)
    )
    c.commit()
    return {"ok": True}
```

Run with:

```bash
pip install fastapi uvicorn
uvicorn memory_adapter:app --port 7843
export OPENCODE_PA_MEMORY_URL="http://127.0.0.1:7843"
```

## Node skeleton (Bun, ~60 LOC)

```ts
// memory_adapter.ts
import { serve } from "bun"
import { Database } from "bun:sqlite"
import { homedir } from "os"
import { mkdirSync } from "fs"
import { join } from "path"

const dir = join(homedir(), ".local/share/opencode-personal-agent")
mkdirSync(dir, { recursive: true })
const db = new Database(join(dir, "memory.sqlite"))
db.exec(`CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  app_name TEXT,
  task_category TEXT
)`)

serve({
  port: 7843,
  async fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === "/status")
      return Response.json({ ok: true })

    if (u.pathname === "/activities") {
      const date = u.searchParams.get("date") ?? ""
      const rows = db.query(
        `SELECT ts, text, app_name, task_category
         FROM memories
         WHERE kind='activity' AND substr(ts,1,10)=?
         ORDER BY ts DESC LIMIT 50`
      ).all(date) as any[]
      return Response.json(rows.map(r => ({
        started_at: r.ts, summary: r.text,
        app_name: r.app_name, task_category: r.task_category,
      })))
    }

    if (u.pathname === "/query" && req.method === "POST") {
      const { question, n_results = 5 } = await req.json() as any
      const rows = db.query(
        `SELECT ts, text FROM memories WHERE text LIKE ?
         ORDER BY ts DESC LIMIT ?`
      ).all(`%${question}%`, n_results) as any[]
      return Response.json({
        results: rows.map(r => ({
          text: r.text, metadata: { timestamp: r.ts }, score: 0.5
        }))
      })
    }

    return new Response("not found", { status: 404 })
  },
})
```

Run with `bun memory_adapter.ts`.

## Upgrading to semantic search

The LIKE-search above is fine if you have a few hundred memories. Above that:

- **Python**: swap to SQLite FTS5, or use `chromadb` or `qdrant-client` for vectors.
- **Node**: use `sqlite-vec` extension, or `lancedb`, or `chromadb-client`.

The contract doesn't care which you pick — `score` is a float and `n_results` is a count.
