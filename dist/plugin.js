// src/bootstrap.ts
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
function detectProject(cwd, projectMap) {
  const parts = cwd.replace(/\/$/, "").split("/").filter(Boolean);
  if (parts.length === 0)
    return "unknown";
  const candidates = [];
  for (let i = parts.length - 1;i >= 0; i--) {
    const seg = parts[i];
    if (seg.startsWith(".")) {
      candidates.pop();
      continue;
    }
    candidates.push(seg);
  }
  for (const seg of candidates) {
    if (projectMap[seg])
      return projectMap[seg];
  }
  return candidates[0] ?? "unknown";
}
function decisionsNoteName(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `Decisions — ${y}-${m}`;
}
function memoriesNoteName(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `Memories — ${y}-${m}`;
}
async function readAgentLearnings(home) {
  try {
    const path = nodePath.join(home, ".config", "opencode", "agent-learnings.md");
    return await fs.readFile(path, "utf-8");
  } catch {
    return null;
  }
}
function composeBootstrapMessage(data) {
  const lines = ["## Memory bootstrap", ""];
  lines.push(`**Active project (from cwd)**: ${data.projectName}`);
  if (data.activitySummary) {
    lines.push(`**Today's activity**: ${data.activitySummary}`);
  }
  lines.push("");
  if (data.recentDecisions.length > 0) {
    lines.push("### Recent decisions (last 7 days)");
    for (const d of data.recentDecisions)
      lines.push(`- ${d}`);
    lines.push("");
  }
  if (data.recentMemories.length > 0) {
    lines.push("### Recent memories (last 7 days)");
    for (const m of data.recentMemories)
      lines.push(`- ${m}`);
    lines.push("");
  }
  if (data.projectNotes.length > 0) {
    lines.push("### Project-tagged notes (last 7 days)");
    for (const n of data.projectNotes)
      lines.push(`- ${n}`);
    lines.push("");
  }
  if (data.agentLearnings) {
    lines.push("### Agent Learnings");
    lines.push(data.agentLearnings);
    lines.push("");
  }
  lines.push("_End memory bootstrap. Continue normally._");
  return lines.join(`
`);
}
function prevMonth(date) {
  const d = new Date(date);
  d.setMonth(d.getMonth() - 1);
  return d;
}
function mergeNoteBodies(current, previous) {
  if (current && previous)
    return `${current}

${previous}`;
  return current ?? previous ?? "";
}

// src/clients/joplin.ts
class JoplinClient {
  baseUrl;
  token;
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
  }
  url(path, params = {}) {
    const p = new URLSearchParams({ token: this.token, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
    return `${this.baseUrl}${path}?${p}`;
  }
  async getNote(titleOrId, notebook = "Second Brain") {
    try {
      if (/^[a-f0-9]{32}$/.test(titleOrId)) {
        const res = await fetch(this.url(`/notes/${titleOrId}`, { fields: "id,title,body,updated_time" }), { signal: AbortSignal.timeout(5000) });
        if (!res.ok)
          return null;
        return await res.json();
      }
      const results = await this.searchNotes(`"${titleOrId}" notebook:"${notebook}"`, 5);
      return results.find((n) => n.title === titleOrId) ?? null;
    } catch {
      return null;
    }
  }
  async searchNotes(query, limit = 5) {
    try {
      const res = await fetch(this.url("/search", { query, fields: "id,title,body,updated_time", limit }), { signal: AbortSignal.timeout(5000) });
      if (!res.ok)
        return [];
      const data = await res.json();
      return data?.items ?? (Array.isArray(data) ? data : []);
    } catch {
      return [];
    }
  }
  async appendToNote(titleOrId, content, notebook, projectTag) {
    try {
      const note = await this.getNote(titleOrId);
      if (note) {
        const res = await fetch(this.url(`/notes/${note.id}`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: note.body + `

` + content }),
          signal: AbortSignal.timeout(1e4)
        });
        if (res.ok && projectTag) {
          const tagId = await this.ensureTag(projectTag);
          if (tagId)
            await this.applyTag(tagId, note.id);
        }
        return res.ok;
      }
      return await this.createNote(titleOrId, content, notebook, projectTag);
    } catch {
      return false;
    }
  }
  async updateNote(id, body) {
    try {
      const res = await fetch(this.url(`/notes/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(1e4)
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  async createNote(title, body, notebook, projectTag) {
    try {
      const folderId = await this.getFolderId(notebook);
      const res = await fetch(this.url("/notes"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, ...folderId ? { parent_id: folderId } : {} }),
        signal: AbortSignal.timeout(1e4)
      });
      if (!res.ok)
        return false;
      if (projectTag) {
        const created = await res.json();
        const tagId = await this.ensureTag(projectTag);
        if (tagId && created?.id)
          await this.applyTag(tagId, created.id);
      }
      return true;
    } catch {
      return false;
    }
  }
  async ensureTag(name) {
    try {
      const res = await fetch(this.url("/tags", { fields: "id,title", query: name }), { signal: AbortSignal.timeout(5000) });
      if (!res.ok)
        return null;
      const data = await res.json();
      const tags = data?.items ?? (Array.isArray(data) ? data : []);
      const existing = tags.find((t) => t.title === name);
      if (existing)
        return existing.id;
      const create = await fetch(this.url("/tags"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: name }),
        signal: AbortSignal.timeout(5000)
      });
      if (!create.ok)
        return null;
      const created = await create.json();
      return created?.id ?? null;
    } catch {
      return null;
    }
  }
  async applyTag(tagId, noteId) {
    try {
      const res = await fetch(this.url(`/tags/${tagId}/notes`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: noteId }),
        signal: AbortSignal.timeout(5000)
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  async getFolderId(title) {
    try {
      const res = await fetch(this.url("/folders", { fields: "id,title" }), { signal: AbortSignal.timeout(5000) });
      if (!res.ok)
        return null;
      const data = await res.json();
      const folders = data?.items ?? (Array.isArray(data) ? data : []);
      return folders.find((f) => f.title === title)?.id ?? null;
    } catch {
      return null;
    }
  }
  static parseDecisionLines(body, withinDays, now) {
    const cutoff = new Date(now.getTime() - withinDays * 24 * 60 * 60 * 1000);
    const sections = body.split(/^---$/m).map((s) => s.trim()).filter(Boolean);
    const results = [];
    for (const section of sections) {
      if (results.length >= 10)
        break;
      const m = section.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+[\d:]+\s+\u2014\s+(.+)$/m);
      if (!m)
        continue;
      const entryDate = new Date(m[1]);
      if (isNaN(entryDate.getTime()) || entryDate < cutoff)
        continue;
      results.push(`${m[1]} — ${m[2].trim()}`);
    }
    return results;
  }
}

// src/clients/memory.ts
class MemoryClient {
  baseUrl;
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }
  async getTodayActivities() {
    if (!this.baseUrl)
      return null;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(`${this.baseUrl}/activities?date=${today}`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok)
        return null;
      const data = await res.json();
      if (!Array.isArray(data))
        return null;
      return data;
    } catch {
      return null;
    }
  }
  static summarizeActivities(activities) {
    if (activities.length === 0)
      return null;
    return [...activities].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0)).slice(0, 3).map((a) => a.app).join(", ");
  }
}

// src/normalizer.ts
function normalizeArgs(tool, args) {
  switch (tool) {
    case "bash": {
      const cmd = args?.command ?? "";
      const normalized = cmd.replace(/"[^"]*"|'[^']*'/g, "<str>");
      const tokens = normalized.split(/\s+/).filter(Boolean).map((t) => {
        if (t === "<str>")
          return "<str>";
        if (/^\/[\w./-]+/.test(t))
          return "<path>";
        if (/^https?:\/\//.test(t))
          return "<url>";
        if (/^-/.test(t))
          return t;
        return t.toLowerCase();
      });
      return `bash:${tokens.slice(0, 6).join(" ")}`;
    }
    case "write":
    case "edit":
    case "read": {
      const filePath = args?.filePath ?? "";
      const parts = filePath.split("/").filter(Boolean);
      return `${tool}:${parts.slice(-2).join("/")}`;
    }
    default:
      return `${tool}:${Object.keys(args ?? {}).sort().join(",")}`;
  }
}

// src/patterns.ts
var PATTERN_THRESHOLD = 3;
function detectPatterns(candidates, alreadyProposed, threshold = PATTERN_THRESHOLD) {
  const result = [];
  for (const [sig, hits] of candidates) {
    if (hits < threshold)
      continue;
    if (alreadyProposed.has(sig))
      continue;
    const tool = sig.split(":")[0] ?? sig;
    result.push({ sig, tool, hits });
  }
  return result;
}
function skillsProposedEntry(candidate, now) {
  const ts = now.toISOString().slice(0, 10);
  return [
    `## ${candidate.sig} — proposed`,
    "",
    `**Tool**: ${candidate.tool}`,
    `**Hits this session**: ${candidate.hits}`,
    `**Status**: pending`,
    `**Proposed**: ${ts}`,
    "",
    "---"
  ].join(`
`);
}
function markPromoted(body, sig) {
  const sectionStart = body.indexOf(`## ${sig} — proposed`);
  if (sectionStart === -1)
    return body;
  const nextSection = body.indexOf(`
## `, sectionStart + 1);
  const sectionEnd = nextSection === -1 ? body.length : nextSection;
  const section = body.slice(sectionStart, sectionEnd);
  const updated = section.replace("**Status**: pending", "**Status**: promoted");
  return body.slice(0, sectionStart) + updated + body.slice(sectionEnd);
}
async function writeNewPatterns(candidates, joplin, notebook) {
  if (candidates.length === 0)
    return;
  const existing = await joplin.getNote("Skills Proposed");
  const existingBody = existing?.body ?? "";
  const alreadyInNote = new Set([...existingBody.matchAll(/^## (.+?) — proposed/gm)].map((m) => m[1]));
  const newEntries = candidates.filter((c) => !alreadyInNote.has(c.sig)).map((c) => skillsProposedEntry(c, new Date)).join(`
`);
  if (!newEntries)
    return;
  await joplin.appendToNote("Skills Proposed", `
` + newEntries, notebook);
}

// src/transcript.ts
function formatTranscript(turns) {
  return turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join(`

`);
}
function trimTranscript(turns, maxTurns, tokenBudget) {
  const recent = turns.slice(-maxTurns);
  let charBudget = tokenBudget * 4;
  const result = [];
  for (let i = recent.length - 1;i >= 0; i--) {
    const chars = recent[i].text.length + 20;
    if (result.length > 0 && charBudget - chars < 0)
      break;
    result.unshift(recent[i]);
    charBudget -= chars;
  }
  return result.length === 0 && recent.length > 0 ? [recent[recent.length - 1]] : result;
}
async function getTranscript(client, sessionId) {
  try {
    const resp = await client.session.messages({ path: { id: sessionId } });
    const messages = Array.isArray(resp?.data) ? resp.data : Array.isArray(resp) ? resp : [];
    if (messages.length === 0 && resp !== undefined && !Array.isArray(resp?.data) && !Array.isArray(resp)) {}
    const turns = [];
    for (const msg of messages) {
      const role = msg.info?.role;
      if (role !== "user" && role !== "assistant")
        continue;
      const text = msg.parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join("").trim();
      if (text)
        turns.push({ role, text });
    }
    return turns;
  } catch {
    return [];
  }
}

// src/reflect.ts
var LLM_BASE = process.env.OPENCODE_PA_LLM_URL ?? "http://127.0.0.1:8889/v1";
var LLM_KEY = process.env.OPENCODE_PA_LLM_KEY ?? "1";
var LLM_MODEL = process.env.OPENCODE_PA_LLM_MODEL ?? "CLAUDE_4_6_SONNET";
var JOPLIN_NOTEBOOK = process.env.OPENCODE_PA_JOPLIN_NOTEBOOK ?? "Second Brain";
var CONFIDENCE_THRESHOLD = 0.6;
var REFLECTION_SYSTEM_PROMPT = `You are the reflection module of a personal AI agent. You read a session transcript and emit JSON describing what should be remembered.

Output schema (strict JSON, no prose):
{
  "decisions": [{"title":"<short>","context":"<what was being worked on>","decision":"<chosen path>","rationale":"<why this over alternatives>","rejected":["<alt with one-line why>"],"project_tag":"<tag or null>","confidence":0.0}],
  "memories": [{"title":"<short>","what_happened":"<single paragraph>","significance":"<one line>","files_touched":["<path>"],"loose_ends":["<line>"],"project_tag":"<tag or null>","confidence":0.0}],
  "agent_learnings": [{"type":"behavior_correction","observed":"<what happened>","evidence_message_indices":[0],"proposed_action":"AGENTS.md edit","confidence":0.0}]
}

Rules:
- A decision requires a rejected alternative. Otherwise it is a memory.
- agent_learnings only when user CORRECTED the agent or expressed a preference. Not routine work.
- confidence >= 0.6 means worth writing. Plugin drops items below 0.6.
- Output only NEW items from this session. If nothing notable happened, return empty arrays.`;
function parseReflectionJson(raw) {
  const empty = { decisions: [], memories: [], agent_learnings: [] };
  if (!raw.trim())
    return empty;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match)
      return empty;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return empty;
    }
  }
  if (!parsed || typeof parsed !== "object")
    return empty;
  const decisions = (Array.isArray(parsed.decisions) ? parsed.decisions : []).filter((d) => d && typeof d === "object" && (d.confidence ?? 0) >= CONFIDENCE_THRESHOLD);
  const memories = (Array.isArray(parsed.memories) ? parsed.memories : []).filter((m) => m && typeof m === "object" && (m.confidence ?? 0) >= CONFIDENCE_THRESHOLD);
  const agent_learnings = (Array.isArray(parsed.agent_learnings) ? parsed.agent_learnings : []).filter((l) => l && typeof l === "object");
  return { decisions, memories, agent_learnings };
}
function renderDecision(d, now, sessionId = "unknown") {
  const ts = now.toISOString().slice(0, 16).replace("T", " ");
  const tag = d.project_tag ? `  +${d.project_tag}` : "";
  const rejected = d.rejected.length > 0 ? d.rejected.map((r) => `  - ${r}`).join(`
`) : "  - (none recorded)";
  return `## ${ts} — ${d.title}

**Project**: ${d.project_tag ?? "general"}${tag}
**Context**: ${d.context}
**Decision**: ${d.decision}
**Rationale**: ${d.rationale}
**Rejected**:
${rejected}

**Recorded by**: agent (session ${sessionId})

---`;
}
function renderMemory(m, now, sessionId = "unknown") {
  const ts = now.toISOString().slice(0, 16).replace("T", " ");
  const tag = m.project_tag ? `  +${m.project_tag}` : "";
  const files = m.files_touched.length > 0 ? m.files_touched.map((f) => `  - ${f}`).join(`
`) : "  - (none)";
  const loose = m.loose_ends.length > 0 ? m.loose_ends.map((l) => `  - ${l}`).join(`
`) : "  - (none)";
  return `## ${ts} — ${m.title}

**Project**: ${m.project_tag ?? "general"}${tag}
**What happened**: ${m.what_happened}
**Significance**: ${m.significance}
**Files touched**:
${files}
**Loose ends**:
${loose}

**Recorded by**: agent (session ${sessionId})

---`;
}
function renderLearning(l, now, crossSessionCount, sessionId) {
  const ts = now.toISOString().slice(0, 16).replace("T", " ");
  const status = crossSessionCount >= 2 ? "proposed_agents_edit" : "pending_more_evidence";
  return `## ${ts} — ${l.observed.slice(0, 60)}

**Type**: ${l.type}
**Observed**: ${l.observed}
**Evidence**: session ${sessionId} messages [${l.evidence_message_indices.join(", ")}]
**Cross-session count**: ${crossSessionCount}
**Proposed action**: ${l.proposed_action}
**Status**: ${status}
**Recorded by**: agent (session ${sessionId})

---`;
}
function renderProjectNoteEntry(type, title, summary, now, sessionId) {
  const ts = now.toISOString().slice(0, 16).replace("T", " ");
  return `## ${ts} — ${title}

**Type**: ${type}
**Summary**: ${summary}

**Recorded by**: agent (session ${sessionId})

---`;
}
function projectNoteName(projectTag) {
  return `Project Notes — ${projectTag}`;
}
function agentLearningsNoteName(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `Agent Learnings — ${y}-${m}`;
}
async function countCrossSessionLearnings(joplin, observed) {
  const keyword = observed.replace(/[^a-zA-Z0-9\s]/g, " ").trim().split(/\s+/).slice(0, 5).join(" ");
  if (!keyword)
    return 1;
  const notes = await joplin.searchNotes(keyword, 20);
  return notes.filter((n) => n.title.startsWith("Agent Learnings") && n.body.includes(observed.slice(0, 30))).length + 1;
}
async function reflect(state, client, joplin) {
  const now = new Date;
  const rawTurns = await getTranscript(client, state.sessionId);
  const turns = trimTranscript(rawTurns, 30, 8000);
  if (turns.length === 0)
    return;
  const transcript = formatTranscript(turns);
  let raw = "";
  try {
    const res = await fetch(`${LLM_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_KEY}`
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: REFLECTION_SYSTEM_PROMPT },
          { role: "user", content: transcript }
        ],
        response_format: { type: "json_object" },
        max_tokens: 2000,
        temperature: 0.2
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) {
      await client.app.log({ body: { service: "personal-agent", level: "warn", message: `reflect: LLM ${res.status}`, extra: {} } });
      return;
    }
    const json = await res.json();
    raw = json?.choices?.[0]?.message?.content ?? "";
  } catch (err) {
    await client.app.log({ body: { service: "personal-agent", level: "warn", message: "reflect: LLM error", extra: { error: String(err) } } });
    return;
  }
  const result = parseReflectionJson(raw);
  for (const d of result.decisions) {
    await joplin.appendToNote(decisionsNoteName(now), renderDecision(d, now, state.sessionId), JOPLIN_NOTEBOOK);
    if (d.project_tag) {
      const entry = renderProjectNoteEntry("decision", d.title, d.decision, now, state.sessionId);
      await joplin.appendToNote(projectNoteName(d.project_tag), entry, JOPLIN_NOTEBOOK, d.project_tag);
    }
  }
  for (const m of result.memories) {
    await joplin.appendToNote(memoriesNoteName(now), renderMemory(m, now, state.sessionId), JOPLIN_NOTEBOOK);
    if (m.project_tag) {
      const entry = renderProjectNoteEntry("memory", m.title, m.what_happened.slice(0, 120), now, state.sessionId);
      await joplin.appendToNote(projectNoteName(m.project_tag), entry, JOPLIN_NOTEBOOK, m.project_tag);
    }
  }
  const learningNoteName = agentLearningsNoteName(now);
  for (const l of result.agent_learnings) {
    const crossCount = await countCrossSessionLearnings(joplin, l.observed);
    await joplin.appendToNote(learningNoteName, renderLearning(l, now, crossCount, state.sessionId), JOPLIN_NOTEBOOK);
  }
  await client.app.log({
    body: {
      service: "personal-agent",
      level: "info",
      message: `reflect: wrote ${result.decisions.length}d ${result.memories.length}m ${result.agent_learnings.length}l`,
      extra: { sessionId: state.sessionId }
    }
  });
}

// src/agents-edit.ts
import * as fs2 from "node:fs/promises";
import * as nodePath2 from "node:path";
var LLM_BASE2 = process.env.OPENCODE_PA_LLM_URL ?? "http://127.0.0.1:8889/v1";
var LLM_KEY2 = process.env.OPENCODE_PA_LLM_KEY ?? "1";
var LLM_MODEL2 = process.env.OPENCODE_PA_LLM_MODEL ?? "CLAUDE_4_6_SONNET";
var AGENT_LEARNINGS_SKELETON = `# Agent Learnings

> Auto-maintained by opencode personal-agent. Do not edit manually.
> Last updated: {DATE}

## Table of Contents

- [Behavioral Rules](#behavioral-rules)
- [Preferences](#preferences)
- [Project-Specific](#project-specific)

---

## Behavioral Rules

Rules the agent must follow, learned from corrections across sessions.

---

## Preferences

User preferences that shape how the agent works.

---

## Project-Specific

Rules that apply only within specific projects.
`;
function findAgentLearnings(noteBody) {
  if (!noteBody.trim())
    return [];
  const sections = noteBody.split(/\n(?=## )/);
  const results = [];
  for (const section of sections) {
    const statusMatch = section.match(/\*\*Status\*\*: (\S+)/);
    if (!statusMatch || statusMatch[1] !== "proposed_agents_edit")
      continue;
    const observedMatch = section.match(/\*\*Observed\*\*: (.+)/);
    const typeMatch = section.match(/\*\*Type\*\*: (\S+)/);
    const countMatch = section.match(/\*\*Cross-session count\*\*: (\d+)/);
    const projectMatch = section.match(/\*\*Project\*\*: (.+)/);
    if (!observedMatch)
      continue;
    results.push({
      observed: observedMatch[1].trim(),
      type: typeMatch?.[1]?.trim() ?? "behavior_correction",
      crossSessionCount: countMatch ? parseInt(countMatch[1], 10) : 1,
      projectTag: projectMatch ? projectMatch[1].trim() : null,
      status: "proposed_agents_edit"
    });
  }
  return results;
}
function markLearningStatus(body, observed, status) {
  const sectionStart = body.indexOf(`**Observed**: ${observed}`);
  if (sectionStart === -1)
    return body;
  const prevHeading = body.lastIndexOf(`
## `, sectionStart);
  const start = prevHeading === -1 ? 0 : prevHeading;
  const nextSection = body.indexOf(`
## `, sectionStart);
  const end = nextSection === -1 ? body.length : nextSection;
  const section = body.slice(start, end);
  const updated = section.replace("**Status**: proposed_agents_edit", `**Status**: ${status}`);
  return body.slice(0, start) + updated + body.slice(end);
}
function buildAgentsMdPrompt(entry, existingContent, editInstruction) {
  const editNote = editInstruction ? `

User edit instruction: "${editInstruction}". Incorporate this into your output.` : "";
  const existingNote = existingContent ? `

Current file content:
${existingContent}` : `

The file does not exist yet — produce a full file using the skeleton structure.`;
  return `You are maintaining agent-learnings.md, a structured markdown file that records behavioral rules and preferences for an AI coding agent.

New learning to incorporate:
- Observed: ${entry.observed}
- Type: ${entry.type}
- Cross-session count: ${entry.crossSessionCount}
- Project tag: ${entry.projectTag ?? "none (global)"}${editNote}${existingNote}

Instructions:
1. If the existing file is empty or missing, output the full file using this skeleton:
   - # Agent Learnings header with "Auto-maintained" note and today's date
   - ## Behavioral Rules section (for behavior_correction type)
   - ## Preferences section (for preference_expressed type)
   - ## Project-Specific section (for entries with a project tag)
   - Table of Contents linking to each section

2. If the file already exists:
   - Add the new learning to the correct section based on type
   - If a similar entry already exists, update it instead of duplicating
   - Update the "Last updated" date
   - Keep all existing entries intact

3. Format each entry as:
   ### <short title from observed>
   - **Learned**: <date>
   - **Evidence**: Corrected/expressed <N> times across sessions
   - **Rule** or **Preference**: <concise actionable rule>

4. Output ONLY the complete file content, no prose before or after.`;
}
function patchAgentLearningsFile(existingContent, llmPatch) {
  if (!llmPatch.includes("# Agent Learnings")) {
    if (!existingContent.trim()) {
      const skeleton = AGENT_LEARNINGS_SKELETON.replace("{DATE}", new Date().toISOString().slice(0, 10));
      return skeleton + `
` + llmPatch;
    }
    return existingContent;
  }
  return llmPatch;
}
function resolveAgentLearningsPath(scope, cwd, home) {
  if (scope === "global") {
    return nodePath2.join(home, ".config", "opencode", "agent-learnings.md");
  }
  return nodePath2.join(cwd, "agent-learnings.md");
}
async function generatePatch(entry, existingContent, editInstruction) {
  const response = await fetch(`${LLM_BASE2}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_KEY2}`
    },
    body: JSON.stringify({
      model: LLM_MODEL2,
      messages: [{ role: "user", content: buildAgentsMdPrompt(entry, existingContent, editInstruction) }],
      max_tokens: 1200
    })
  });
  if (!response.ok)
    throw new Error(`LLM error: ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}
async function runAgentsEdit(args, sessionId, cwd, joplin, pendingAgentsEdits) {
  const parts = args.trim().split(/\s+/);
  const confirmFlag = parts.includes("--confirm");
  const skipFlag = parts.includes("--skip");
  const scopeFlag = parts.find((p) => p.startsWith("--scope="));
  const editFlag = args.match(/--edit="([^"]*)"/);
  const editInstruction = editFlag?.[1];
  const name = parts.filter((p) => !p.startsWith("--") && !p.startsWith('"')).join(" ").trim();
  if (!name) {
    return "Usage: /agents-edit <name>  or  /agents-edit <name> --scope=global --confirm";
  }
  const now = new Date;
  const learningsNote = await joplin.getNote(agentLearningsNoteName(now));
  if (!learningsNote?.body) {
    return "Can't read Agent Learnings from Joplin. Is Joplin running?";
  }
  const entries = findAgentLearnings(learningsNote.body);
  const lowerName = name.toLowerCase();
  const entry = entries.find((e) => e.observed === name) ?? entries.find((e) => e.observed.toLowerCase().includes(lowerName)) ?? null;
  if (!entry) {
    return `No proposed agent learning matching '${name}'. Run /wrap to see candidates.`;
  }
  if (skipFlag) {
    try {
      const updatedBody = markLearningStatus(learningsNote.body, entry.observed, "skipped");
      await joplin.updateNote(learningsNote.id, updatedBody);
    } catch {}
    pendingAgentsEdits.delete(entry.observed);
    return "Skipped. Won't propose again.";
  }
  if (confirmFlag && scopeFlag) {
    const scope = scopeFlag.replace("--scope=", "");
    if (scope !== "global" && scope !== "project") {
      return `Invalid scope '${scope}'. Use --scope=global or --scope=project.`;
    }
    const home2 = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    const filePath = resolveAgentLearningsPath(scope, cwd, home2);
    let existingContent2 = "";
    try {
      existingContent2 = await fs2.readFile(filePath, "utf-8");
    } catch {}
    let patch2;
    try {
      patch2 = await generatePatch(entry, existingContent2, editInstruction);
    } catch (err) {
      return `LLM unavailable — can't generate patch. Try again when endpoint is up. (${String(err)})`;
    }
    if (!patch2)
      return "LLM returned empty patch. Try again.";
    const finalContent = patchAgentLearningsFile(existingContent2, patch2);
    try {
      const dir = nodePath2.dirname(filePath);
      await fs2.mkdir(dir, { recursive: true });
      await fs2.writeFile(filePath, finalContent, "utf-8");
    } catch (err) {
      return `File write failed at ${filePath}: ${String(err)}

Patch content:

${finalContent}`;
    }
    try {
      const updatedBody = markLearningStatus(learningsNote.body, entry.observed, "applied");
      await joplin.updateNote(learningsNote.id, updatedBody);
    } catch {}
    pendingAgentsEdits.delete(entry.observed);
    return `Written to ${filePath}. Agent learnings updated.`;
  }
  if (confirmFlag && !scopeFlag) {
    return "Scope required for confirm. Use --scope=global or --scope=project.";
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const globalPath = resolveAgentLearningsPath("global", cwd, home);
  const projectPath = resolveAgentLearningsPath("project", cwd, home);
  let existingContent = "";
  try {
    existingContent = await fs2.readFile(projectPath, "utf-8");
  } catch {
    try {
      existingContent = await fs2.readFile(globalPath, "utf-8");
    } catch {}
  }
  let patch;
  try {
    patch = await generatePatch(entry, existingContent);
  } catch (err) {
    return `LLM unavailable — can't generate patch. Try again when endpoint is up. (${String(err)})`;
  }
  if (!patch)
    return "LLM returned empty patch. Try again.";
  return [
    "AGENTS_EDIT_CANDIDATE",
    `observed: ${entry.observed}`,
    `type: ${entry.type}`,
    `cross_session_count: ${entry.crossSessionCount}`,
    `global_path: ${globalPath}`,
    `project_path: ${projectPath}`,
    "---PATCH---",
    patch
  ].join(`
`);
}

// src/promote.ts
import * as fs3 from "node:fs/promises";
import * as nodePath3 from "node:path";
var LLM_BASE3 = process.env.OPENCODE_PA_LLM_URL ?? "http://127.0.0.1:8889/v1";
var LLM_KEY3 = process.env.OPENCODE_PA_LLM_KEY ?? "1";
var LLM_MODEL3 = process.env.OPENCODE_PA_LLM_MODEL ?? "CLAUDE_4_6_SONNET";
function findCandidate(noteBody, name) {
  const sections = noteBody.split(/\n(?=## )/);
  const pending = sections.filter((s) => s.includes("**Status**: pending"));
  for (const section of pending) {
    const sigMatch = section.match(/^## (.+?) — proposed/);
    if (!sigMatch)
      continue;
    const sig = sigMatch[1];
    if (sig === name) {
      return extractCandidate(section, sig);
    }
  }
  const lowerName = name.toLowerCase();
  for (const section of pending) {
    const sigMatch = section.match(/^## (.+?) — proposed/);
    if (!sigMatch)
      continue;
    const sig = sigMatch[1];
    if (sig.toLowerCase().includes(lowerName)) {
      return extractCandidate(section, sig);
    }
  }
  return null;
}
function extractCandidate(section, sig) {
  const toolMatch = section.match(/\*\*Tool\*\*: (.+)/);
  const hitsMatch = section.match(/\*\*Hits this session\*\*: (\d+)/);
  return {
    sig,
    tool: toolMatch?.[1]?.trim() ?? sig.split(":")[0] ?? sig,
    hits: hitsMatch ? parseInt(hitsMatch[1], 10) : 0
  };
}
function resolveSkillPath(name, scope, cwd, home) {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (scope === "global") {
    return nodePath3.join(home, ".config", "opencode", "skills", sanitized, "SKILL.md");
  }
  return nodePath3.join(cwd, ".opencode", "skills", sanitized, "SKILL.md");
}
function buildPromotePrompt(candidate) {
  return `You are helping a developer turn a repeated tool pattern into an opencode skill.

Pattern details:
- Signature: ${candidate.sig}
- Tool: ${candidate.tool}
- Times repeated this session: ${candidate.hits}

Write a SKILL.md file for this pattern. opencode requires YAML frontmatter at the top.

The skill should:
1. Have a YAML frontmatter block with kebab-case "name" and a "description" describing when to use it
2. Have a short title matching the pattern
3. Explain when to use this skill (1-2 sentences)
4. Show the exact command or action to perform
5. Include any important notes or caveats

Format (literal — keep the --- delimiters and field names exactly):
---
name: <kebab-case-name-derived-from-signature>
description: "<1-2 sentence trigger description — when should an agent invoke this skill>"
---

# <skill title>

## When to use
<1-2 sentences>

## What it does
<brief description>

## How to use
<exact command or steps>

## Notes
<any caveats>

Output only the SKILL.md content (starting with the --- frontmatter line), no prose before or after.`;
}
async function generateSkillMd(candidate) {
  const response = await fetch(`${LLM_BASE3}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_KEY3}`
    },
    body: JSON.stringify({
      model: LLM_MODEL3,
      messages: [
        { role: "user", content: buildPromotePrompt(candidate) }
      ],
      max_tokens: 600
    })
  });
  if (!response.ok)
    throw new Error(`LLM error: ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}
async function writeSkillFile(path, content) {
  const dir = nodePath3.dirname(path);
  await fs3.mkdir(dir, { recursive: true });
  await fs3.writeFile(path, content, "utf-8");
}
async function runPromote(args, sessionId, cwd, joplin, pendingPromotions) {
  const parts = args.trim().split(/\s+/);
  const confirmFlag = parts.includes("--confirm");
  const scopeFlag = parts.find((p) => p.startsWith("--scope="));
  const name = parts.filter((p) => !p.startsWith("--")).join(" ").trim();
  if (!name) {
    return "Usage: /promote <name>  or  /promote <name> --scope=global --confirm";
  }
  const note = await joplin.getNote("Skills Proposed");
  if (!note?.body) {
    return "No pending skill candidates found. Run a session with repeated tool calls first.";
  }
  const candidate = findCandidate(note.body, name);
  if (!candidate) {
    return `No pending skill candidate matching '${name}'. Run /wrap to see candidates.`;
  }
  if (confirmFlag && scopeFlag) {
    const scope = scopeFlag.replace("--scope=", "");
    if (scope !== "global" && scope !== "project") {
      return `Invalid scope '${scope}'. Use --scope=global or --scope=project.`;
    }
    const home2 = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    const skillPath = resolveSkillPath(candidate.sig, scope, cwd, home2);
    let draft2;
    try {
      draft2 = await generateSkillMd(candidate);
    } catch (err) {
      return `LLM unavailable — can't generate draft. Try again when endpoint is up. (${String(err)})`;
    }
    if (!draft2) {
      return "LLM returned empty draft. Try again.";
    }
    try {
      await writeSkillFile(skillPath, draft2);
    } catch (err) {
      return `File write failed at ${skillPath}: ${String(err)}

Draft content:

${draft2}`;
    }
    try {
      const updatedBody = markPromoted(note.body, candidate.sig);
      const freshNote = await joplin.getNote("Skills Proposed");
      if (freshNote) {
        await joplin.updateNote(freshNote.id, updatedBody);
      }
    } catch {}
    pendingPromotions.delete(candidate.sig);
    return `Written to ${skillPath}. Restart opencode to load the new skill.`;
  }
  let draft;
  try {
    draft = await generateSkillMd(candidate);
  } catch (err) {
    return `LLM unavailable — can't generate draft. Try again when endpoint is up. (${String(err)})`;
  }
  if (!draft) {
    return "LLM returned empty draft. Try again.";
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const globalPath = resolveSkillPath(candidate.sig, "global", cwd, home);
  const projectPath = resolveSkillPath(candidate.sig, "project", cwd, home);
  return [
    `PROMOTE_CANDIDATE`,
    `sig: ${candidate.sig}`,
    `tool: ${candidate.tool}`,
    `hits: ${candidate.hits}`,
    `global_path: ${globalPath}`,
    `project_path: ${projectPath}`,
    `---DRAFT---`,
    draft
  ].join(`
`);
}

// src/wrap.ts
var AGENTS_MD_THRESHOLD = 2;
function formatWrapSummary(data, monthKey, now) {
  const ts = now.toISOString().slice(0, 10);
  const lines = [`═════ Session wrap-up — ${ts} ═════`, ""];
  if (data.reflectError) {
    lines.push(`⚠ Reflection failed: ${data.reflectError}`);
    lines.push("  (pending lists below are from prior saves only)");
    lines.push("");
  }
  if (data.savedDecisions.length > 0) {
    const n = data.savedDecisions.length;
    lines.push(`✓ Saved to Joplin "Decisions — ${monthKey}" (${n} ${n === 1 ? "entry" : "entries"}):`);
    for (const d of data.savedDecisions)
      lines.push(`  • ${d}`);
    lines.push("");
  }
  if (data.savedMemories.length > 0) {
    const n = data.savedMemories.length;
    lines.push(`✓ Saved to Joplin "Memories — ${monthKey}" (${n} ${n === 1 ? "entry" : "entries"}):`);
    for (const m of data.savedMemories)
      lines.push(`  • ${m}`);
    lines.push("");
  }
  if (data.skillCandidates.length > 0) {
    const n = data.skillCandidates.length;
    lines.push(`⚠ ${n} skill candidate${n > 1 ? "s" : ""} awaiting your decision:`);
    for (const c of data.skillCandidates) {
      lines.push(`  • ${c.name}   (${c.hits} hits this session)`);
      lines.push(`    → Run /promote ${c.name} to convert, or ignore.`);
    }
    lines.push("");
  }
  if (data.agentsMdProposals.length > 0) {
    const n = data.agentsMdProposals.length;
    lines.push(`⚠ ${n} AGENTS.md proposal${n > 1 ? "s" : ""} (cross-session evidence):`);
    for (const p of data.agentsMdProposals) {
      lines.push(`  • "${p.observed.slice(0, 60)}"  (${p.crossSessionCount} sessions)`);
      lines.push(`    → Run /agents-edit to review the diff, or ignore.`);
    }
    lines.push("");
  }
  const hasSomething = data.savedDecisions.length > 0 || data.savedMemories.length > 0 || data.skillCandidates.length > 0 || data.agentsMdProposals.length > 0 || data.reflectError;
  if (!hasSomething)
    lines.push("Nothing else flagged.");
  return lines.join(`
`);
}
function extractNewHeadings(before, after) {
  const re = /^## .+ \u2014 (.+)$/gm;
  const beforeSet = new Set([...before.matchAll(re)].map((m) => m[1]));
  return [...after.matchAll(re)].map((m) => m[1]).filter((h) => !beforeSet.has(h));
}
async function runWrap(state, client, joplin) {
  const now = new Date;
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  let reflectError = null;
  const savedDecisions = [];
  const savedMemories = [];
  try {
    const [decisionsBefore, memoriesBefore] = await Promise.all([
      joplin.getNote(decisionsNoteName(now)),
      joplin.getNote(memoriesNoteName(now))
    ]);
    await reflect(state, client, joplin);
    const [decisionsAfter, memoriesAfter] = await Promise.all([
      joplin.getNote(decisionsNoteName(now)),
      joplin.getNote(memoriesNoteName(now))
    ]);
    savedDecisions.push(...extractNewHeadings(decisionsBefore?.body ?? "", decisionsAfter?.body ?? ""));
    savedMemories.push(...extractNewHeadings(memoriesBefore?.body ?? "", memoriesAfter?.body ?? ""));
  } catch (err) {
    reflectError = String(err);
  }
  const skillCandidates = [];
  const skillsNote = await joplin.getNote("Skills Proposed");
  if (skillsNote?.body) {
    for (const m of skillsNote.body.matchAll(/^## (.+?) \u2014 proposed/gm)) {
      const name = m[1];
      const hitsMatch = skillsNote.body.match(new RegExp(`## ${name}[\\s\\S]*?\\*\\*Hits this session\\*\\*: (\\d+)`));
      const sectionStart = skillsNote.body.indexOf(`## ${name} — proposed`);
      const nextSection = skillsNote.body.indexOf(`
## `, sectionStart + 1);
      const section = skillsNote.body.slice(sectionStart, nextSection > -1 ? nextSection : undefined);
      const promoted = /Status: promoted/.test(section);
      if (!promoted)
        skillCandidates.push({ name, hits: hitsMatch ? parseInt(hitsMatch[1], 10) : 0 });
    }
  }
  const agentsMdProposals = [];
  const learningsNote = await joplin.getNote(agentLearningsNoteName(now));
  if (learningsNote?.body) {
    for (const section of learningsNote.body.split(/^---$/m)) {
      if (!section.includes("AGENTS.md edit") && !section.includes("proposed_agents_edit"))
        continue;
      const obs = section.match(/\*\*Observed\*\*: (.+)/);
      const cnt = section.match(/\*\*Cross-session count\*\*: (\d+)/);
      if (!obs || !cnt)
        continue;
      const count = parseInt(cnt[1], 10);
      if (count >= AGENTS_MD_THRESHOLD)
        agentsMdProposals.push({ observed: obs[1].trim(), crossSessionCount: count });
    }
  }
  return formatWrapSummary({ savedDecisions, savedMemories, skillCandidates, agentsMdProposals, reflectError }, monthKey, now);
}

// src/auto-install.ts
import { mkdir as mkdir3, readdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join as join4, dirname as dirname3, resolve } from "node:path";
import { fileURLToPath } from "node:url";
function packageRootFromMetaUrl(metaUrl) {
  const fileUrl = new URL(metaUrl);
  const filePath = fileURLToPath(fileUrl);
  return resolve(dirname3(filePath), "..");
}
async function ensureExtras(packageRoot, opencodeConfigDir, env = process.env) {
  if (env.OPENCODE_PA_SKIP_AUTO_INSTALL === "1") {
    return { skipped: true, skillsAdded: [], commandsAdded: [], reason: "OPENCODE_PA_SKIP_AUTO_INSTALL=1" };
  }
  const skillsSrc = join4(packageRoot, "skills");
  const commandsSrc = join4(packageRoot, "commands");
  if (!existsSync(skillsSrc) && !existsSync(commandsSrc)) {
    return { skipped: true, skillsAdded: [], commandsAdded: [], reason: "no bundled skills or commands found" };
  }
  const skillsDest = join4(opencodeConfigDir, "skills");
  const commandsDest = join4(opencodeConfigDir, "commands");
  await mkdir3(skillsDest, { recursive: true });
  await mkdir3(commandsDest, { recursive: true });
  const skillsAdded = await copyMissingSkills(skillsSrc, skillsDest);
  const commandsAdded = await copyMissingCommands(commandsSrc, commandsDest);
  return { skipped: false, skillsAdded, commandsAdded };
}
async function copyMissingSkills(src, dest) {
  if (!existsSync(src))
    return [];
  const added = [];
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory())
      continue;
    const targetDir = join4(dest, entry.name);
    const targetSkillMd = join4(targetDir, "SKILL.md");
    if (existsSync(targetSkillMd))
      continue;
    await copyDirShallow(join4(src, entry.name), targetDir);
    added.push(entry.name);
  }
  return added;
}
async function copyMissingCommands(src, dest) {
  if (!existsSync(src))
    return [];
  const added = [];
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md"))
      continue;
    const target = join4(dest, entry.name);
    if (existsSync(target))
      continue;
    await copyFile(join4(src, entry.name), target);
    added.push(entry.name.replace(/\.md$/, ""));
  }
  return added;
}
async function copyDirShallow(src, dest) {
  await mkdir3(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile())
      continue;
    await copyFile(join4(src, entry.name), join4(dest, entry.name));
  }
}

// src/plugin.ts
import { join as join5 } from "node:path";
var JOPLIN_URL = `http://127.0.0.1:${process.env.JOPLIN_PORT ?? "41184"}`;
var JOPLIN_TOKEN = process.env.OPENCODE_PA_JOPLIN_TOKEN ?? process.env.JOPLIN_TOKEN ?? "";
var MEMORY_BASE = process.env.OPENCODE_PA_MEMORY_URL ?? null;
var JOPLIN_NOTEBOOK2 = process.env.OPENCODE_PA_JOPLIN_NOTEBOOK ?? "Second Brain";
var PROJECT_MAP = (() => {
  try {
    return JSON.parse(process.env.OPENCODE_PA_PROJECT_MAP ?? "{}");
  } catch {
    return {};
  }
})();
var IDLE_THRESHOLD_MS = Number(process.env.OPENCODE_PA_IDLE_MS ?? 180000);
var REFLECTION_DEDUPE_WINDOW = Number(process.env.OPENCODE_PA_DEDUPE_MS ?? 120000);
var PATTERN_THRESHOLD2 = Number(process.env.OPENCODE_PA_PATTERN_THRESHOLD ?? 3);
var sessions = new Map;
var PersonalAgent = async ({ client }) => {
  const joplin = new JoplinClient(JOPLIN_URL, JOPLIN_TOKEN);
  const memory = new MemoryClient(MEMORY_BASE);
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR ?? (home ? join5(home, ".config", "opencode") : "");
    if (opencodeConfigDir) {
      const pkgRoot = packageRootFromMetaUrl(import.meta.url);
      const result = await ensureExtras(pkgRoot, opencodeConfigDir);
      if (!result.skipped && (result.skillsAdded.length || result.commandsAdded.length)) {
        await client.app.log({
          body: {
            service: "personal-agent",
            level: "info",
            message: `auto-installed extras: skills=[${result.skillsAdded.join(",")}] commands=[${result.commandsAdded.join(",")}]`,
            extra: {}
          }
        });
      }
    }
  } catch (err) {
    await client.app.log({
      body: { service: "personal-agent", level: "warn", message: "auto-install of skills/commands failed", extra: { error: String(err) } }
    });
  }
  function initSession(sessionId, directory) {
    if (sessions.has(sessionId))
      return;
    const state = {
      sessionId,
      startedAt: new Date,
      lastActivityTs: new Date,
      lastReflectionTs: null,
      toolCalls: [],
      patternCandidates: new Map,
      pendingPromotions: new Set,
      pendingAgentsEdits: new Set,
      bootstrappedContext: null,
      idleTimer: null
    };
    sessions.set(sessionId, state);
    gatherBootstrapData(joplin, memory, directory).then(async (data) => {
      if (!sessions.has(sessionId))
        return;
      state.bootstrappedContext = composeBootstrapMessage(data);
      await client.app.log({
        body: {
          service: "personal-agent",
          level: "info",
          message: `bootstrapped session ${sessionId} with ${data.recentDecisions.length} decisions, ${data.recentMemories.length} memories`,
          extra: { project: data.projectName }
        }
      });
      if (data.projectNotes.length === 0 && data.projectName !== "unknown") {
        await client.app.log({
          body: {
            service: "personal-agent",
            level: "info",
            message: `no project notes found for "${data.projectName}" — reflect() will create them automatically after your first session, or create a note in Second Brain tagged +${data.projectName}`,
            extra: { project: data.projectName }
          }
        });
      }
    }).catch(async (err) => {
      await client.app.log({
        body: { service: "personal-agent", level: "warn", message: "bootstrap failed", extra: { error: String(err) } }
      });
    });
  }
  client.session.list().then((res) => {
    const existing = res?.data ?? [];
    for (const s of existing) {
      if (s?.id)
        initSession(s.id, s.directory ?? "");
    }
  }).catch(() => {});
  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const info = event.properties?.info;
        const sessionId = info?.id ?? "unknown";
        const directory = info?.directory ?? "";
        if (sessionId === "unknown") {
          await client.app.log({
            body: { service: "personal-agent", level: "warn", message: "session.created event missing session ID — skipping bootstrap", extra: {} }
          });
          return;
        }
        await client.app.log({
          body: { service: "personal-agent", level: "info", message: "session started", extra: { sessionId } }
        });
        initSession(sessionId, directory);
      }
      if (event.type === "session.deleted") {
        const sessionId = event.properties?.info?.id ?? "unknown";
        if (sessionId === "unknown")
          return;
        const state = sessions.get(sessionId);
        if (state?.idleTimer)
          clearTimeout(state.idleTimer);
        sessions.delete(sessionId);
      }
      if (event.type === "session.idle") {
        const sessionId = event.properties?.info?.id ?? "unknown";
        if (sessionId === "unknown")
          return;
        const state = sessions.get(sessionId);
        if (!state)
          return;
        state.lastActivityTs = new Date;
        if (state.idleTimer)
          clearTimeout(state.idleTimer);
        state.idleTimer = setTimeout(() => {
          const s = sessions.get(sessionId);
          if (!s)
            return;
          if (Date.now() - s.lastActivityTs.getTime() < IDLE_THRESHOLD_MS)
            return;
          if (s.lastReflectionTs && Date.now() - s.lastReflectionTs.getTime() < REFLECTION_DEDUPE_WINDOW)
            return;
          s.lastReflectionTs = new Date;
          reflect(s, client, joplin).then(() => runIdleChecks(s, joplin, client)).catch(async (err) => {
            await client.app.log({ body: { service: "personal-agent", level: "warn", message: "reflect/pattern error", extra: { error: String(err) } } });
          });
        }, IDLE_THRESHOLD_MS);
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      const sessionId = input.sessionID;
      if (!sessionId)
        return;
      const state = sessions.get(sessionId);
      if (state?.bootstrappedContext) {
        output.system.push(state.bootstrappedContext);
      }
      if (state && state.pendingPromotions.size > 0) {
        const sigs = [...state.pendingPromotions].join(", ");
        output.system.push(`[personal-agent] Pattern nudge: the following tool patterns have repeated ${PATTERN_THRESHOLD2}+ times this session and are ready to promote into skills: ${sigs}. Proactively mention this to the user and offer to run /promote.`);
      }
      if (state && state.pendingAgentsEdits.size > 0) {
        const observed = [...state.pendingAgentsEdits].join("; ");
        output.system.push(`[personal-agent] Agent learning nudge: the following cross-session learnings are ready to apply to agent-learnings.md: ${observed}. Proactively mention this to the user and offer to run /agents-edit.`);
      }
    },
    "experimental.session.compacting": async (input, output) => {
      const state = sessions.get(input.sessionID);
      if (state?.bootstrappedContext) {
        output.context.push(state.bootstrappedContext);
      }
    },
    "tool.execute.before": async (input, output) => {
      const state = sessions.get(input.sessionID);
      if (!state)
        return;
      state.lastActivityTs = new Date;
      const sig = normalizeArgs(input.tool, output.args);
      state.toolCalls.push({ ts: new Date, tool: input.tool, argsSignature: sig });
      if (state.toolCalls.length > 200)
        state.toolCalls.shift();
      const newCount = (state.patternCandidates.get(sig) ?? 0) + 1;
      state.patternCandidates.set(sig, newCount);
      if (newCount === PATTERN_THRESHOLD2 && !state.pendingPromotions.has(sig)) {
        state.pendingPromotions.add(sig);
        await client.app.log({
          body: { service: "personal-agent", level: "info", message: `pattern flagged: ${sig}`, extra: { hits: newCount } }
        });
      }
    },
    "tool.execute.after": async (input, _output) => {
      const state = sessions.get(input.sessionID);
      if (state)
        state.lastActivityTs = new Date;
    },
    "command.execute.before": async (input, output) => {
      if (input.command === "wrap") {
        const state = sessions.get(input.sessionID);
        if (!state) {
          output.parts.push({ type: "text", text: "personal-agent: no session state found for /wrap" });
          return;
        }
        try {
          const summary = await runWrap(state, client, joplin);
          output.parts.push({ type: "text", text: summary });
        } catch (err) {
          output.parts.push({ type: "text", text: `personal-agent: /wrap failed — ${String(err)}` });
        }
        return;
      }
      if (input.command === "promote") {
        const state = sessions.get(input.sessionID);
        const args = input.arguments ?? "";
        const cwd = process.cwd();
        try {
          const result = await runPromote(args, input.sessionID, cwd, joplin, state?.pendingPromotions ?? new Set);
          output.parts.push({ type: "text", text: result });
        } catch (err) {
          output.parts.push({ type: "text", text: `personal-agent: /promote failed — ${String(err)}` });
        }
        return;
      }
      if (input.command === "agents-edit") {
        const state = sessions.get(input.sessionID);
        const args = input.arguments ?? "";
        const cwd = process.cwd();
        try {
          const result = await runAgentsEdit(args, input.sessionID, cwd, joplin, state?.pendingAgentsEdits ?? new Set);
          output.parts.push({ type: "text", text: result });
        } catch (err) {
          output.parts.push({ type: "text", text: `personal-agent: /agents-edit failed — ${String(err)}` });
        }
        return;
      }
    }
  };
};
async function runIdleChecks(s, joplin, client) {
  const skillsNote = await joplin.getNote("Skills Proposed");
  const alreadyProposed = new Set([...(skillsNote?.body ?? "").matchAll(/^## (.+?) — proposed/gm)].map((m) => m[1]));
  const candidates = detectPatterns(s.patternCandidates, alreadyProposed, PATTERN_THRESHOLD2);
  await writeNewPatterns(candidates, joplin, JOPLIN_NOTEBOOK2);
  const now = new Date;
  const learningsNote = await joplin.getNote(agentLearningsNoteName(now));
  if (learningsNote?.body) {
    const sections = learningsNote.body.split(/\n(?=## )/);
    for (const section of sections) {
      const statusMatch = section.match(/\*\*Status\*\*: (\S+)/);
      const observedMatch = section.match(/\*\*Observed\*\*: (.+)/);
      if (statusMatch?.[1] === "proposed_agents_edit" && observedMatch) {
        const observed = observedMatch[1].trim();
        if (!s.pendingAgentsEdits.has(observed)) {
          s.pendingAgentsEdits.add(observed);
          await client.app.log({
            body: { service: "personal-agent", level: "info", message: `agents-edit flagged: ${observed}`, extra: {} }
          });
        }
      }
    }
  }
}
async function gatherBootstrapData(joplin, memory, cwd) {
  const now = new Date;
  const prev = prevMonth(now);
  const projectName = detectProject(cwd, PROJECT_MAP);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const [
    decisionsNote,
    prevDecisionsNote,
    memoriesNote,
    prevMemoriesNote,
    projectNotes,
    activities,
    agentLearnings
  ] = await Promise.all([
    joplin.getNote(decisionsNoteName(now)),
    joplin.getNote(decisionsNoteName(prev)),
    joplin.getNote(memoriesNoteName(now)),
    joplin.getNote(memoriesNoteName(prev)),
    joplin.searchNotes(`tag:${projectName}`, 5),
    memory.getTodayActivities(),
    readAgentLearnings(home)
  ]);
  const decisionsBody = mergeNoteBodies(decisionsNote?.body ?? null, prevDecisionsNote?.body ?? null);
  const memoriesBody = mergeNoteBodies(memoriesNote?.body ?? null, prevMemoriesNote?.body ?? null);
  return {
    projectName,
    recentDecisions: JoplinClient.parseDecisionLines(decisionsBody, 7, now),
    recentMemories: JoplinClient.parseDecisionLines(memoriesBody, 7, now),
    projectNotes: projectNotes.slice(0, 5).map((n) => `${n.title} — ${n.body.slice(0, 80).replace(/\n/g, " ")}`),
    activitySummary: activities ? MemoryClient.summarizeActivities(activities) : null,
    agentLearnings
  };
}
export {
  PersonalAgent
};
