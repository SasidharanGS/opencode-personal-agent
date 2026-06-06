# Joplin Compact Schema v2 — Design

**Date:** 2026-06-06
**Status:** Approved (pending user review of this written spec)
**Owner:** opencode-personal-agent
**Predecessor:** Original verbose schema shipped in v0.1 (see `docs/joplin-integration-improvements.md`).

---

## 1. Problem

Joplin notes written by the personal agent are token-heavy in two ways:

1. **On disk:** Every entry carries ~110 chars of fixed overhead (`**Recorded by**: agent (session ses_xxxx)`, redundant `**Project**: tag  +tag`, empty `(none)` bullets, trailing `---`).
2. **At session start:** The bootstrap message dumps headings from *every* project's last 7 days of Decisions and Memories — even when the active project would benefit from focused context only. Recent measurement showed ~2.5 KB injected on a normal day, with ~80% of bytes carrying low signal for the active task.

Audit of the read path (`src/clients/joplin.ts:parseDecisionLines`, `src/plugin.ts:gatherBootstrapData`) confirms that bootstrap only ever extracts the `## DATE — TITLE` line — the entire body (Context, Rationale, Rejected, Files touched, etc.) is **never re-injected into any session**, only consumed by the user reading Joplin manually.

The `Project Notes — <tag>` mirror notes are a denormalized copy of Memories/Decisions with truncated bodies; they cost a separate write per reflection and add no information bootstrap can't already derive from a `proj:` field on the parent entry.

## 2. Goals

- **Primary:** Reduce per-session bootstrap injection size while *increasing* useful information per token.
- **Secondary:** Reduce on-disk byte volume in Joplin notes, keeping them human-readable.
- **Tertiary:** Eliminate one write path (Project Notes mirror) to simplify the mental model.

Target metrics:
- Bootstrap injection: **≤ 1.6 KB / typical day** (current: ~2.5 KB). **-35% minimum, -44% target.**
- Per-entry on-disk size: **≤ 60% of current** for Memories, Decisions, Learnings.
- Project Notes mirror: **removed entirely**.

## 3. Non-Goals

- Compressing `~/.config/opencode/agent-learnings.md` — different lifecycle, separate decision.
- Redesigning `Skills Proposed` note format — orthogonal lifecycle.
- Joplin tag taxonomy redesign — orthogonal.
- Adding new entry kinds (todos, blockers) — separate feature.
- Changing the structured-output JSON schema beyond adding `significance`. Decision-vs-memory split stays.

## 4. Design

### 4.1 New on-disk entry formats

#### Memory entry

```
## 2026-06-06 14:32 — Fix /compact via stub tool injection
proj: jll-schema-proxy · sig: 8
why: AWS Bedrock requires toolConfig when messages contain tool_calls/tool blocks
did: Reconstruct stub tools from tool_call names; tool_choice:none; patched proxy.py
files: schema-proxy/proxy.py
loose: report bug to JLL Falcon team
```

- Header line: `## ISO-timestamp-minute — title`.
- Metadata line: `proj: <tag> · sig: <1-10>`.
- `why:` is the situation (was `**What happened**`).
- `did:` is the outcome / what was done (was `**Significance**` + a sentence of `**What happened**` merged).
- `files:` comma-separated list, omitted entirely when empty.
- `loose:` comma-separated, omitted when empty.
- No trailing `---`. Subsequent `## ` heading is the section break.

**Avg size: ~280 chars** vs ~470 today. **-40%.**

#### Decision entry

```
## 2026-06-06 14:32 — Inject stub tools at schema-proxy
proj: jll-schema-proxy · sig: 9
why: AWS Bedrock rejects /compact when tools missing but tool blocks present
chose: Reconstruct tools at proxy; tool_choice:none; preserves message history
vs: strip blocks (loses context); fix Falcon Java (not owned); Azure fallback (workaround)
```

- `why:` = context.
- `chose:` = the decision.
- `vs:` = rejected alternatives, semicolon-separated. Each alt is one phrase + one-line why-rejected. Omitted entirely when the reflection LLM emits no rejected alternatives (in which case the entry is automatically classified as a memory anyway — see reflection prompt).

**Avg size: ~340 chars** vs ~680 today. **-50%.**

#### Agent Learning entry

```
## 2026-06-06 14:32 — User prefers Joplin /search not /notes for filtering
type: preference · sig: 8 · seen: 3
observed: User explicitly stated to never use /notes endpoint — Joplin ignores query param
action: AGENTS.md edit (applied)
```

- `type:` one of `behavior_correction`, `preference`, `convention`.
- `seen:` cross-session count (was `**Cross-session count**`).
- `action:` proposed action + current status in parens.

**Avg size: ~280 chars** vs ~470 today. **-40%.**

### 4.2 New field: `sig` (significance, 1–10)

- Reflection LLM emits `significance: number` on every memory, decision, and learning.
- Plugin clamps to `[1, 10]`. Defaults to `5` when missing/invalid.
- Bootstrap uses `sig` to rank top-N within each tier, not just recency. Long-tail trivia (`sig < 5`) still persists in Joplin but is excluded from bootstrap.

### 4.3 Removed from every entry

- `**Recorded by**: agent (session ses_xxxx)` — Joplin already stores creation time; session id never re-read by anything.
- `**Project**: tag  +tag` — Joplin tag is applied programmatically; the body duplicate is noise.
- `**Bold field**:` syntax → `field:` prefix.
- `(none)` / `(none recorded)` empty bullets — omit the field entirely instead.
- Trailing `---` separator.

### 4.4 Removed entity

- **`Project Notes — <tag>` mirror notes.** Deleted as a write path. Existing ones merged into their parent Memories/Decisions via the migration script (§4.7) and then deleted from Joplin.
- Per-project views in Joplin still work via Joplin tag search; the `proj:` field on each entry replaces the body `+tag`.

### 4.5 New bootstrap projection (Option B: active deep + cross-project tail)

```
## Memory bootstrap
proj: opencode-personal-agent
today: VSCode 2h, Terminal 1h, Joplin 30m

### Active repo (last 7d, ranked by sig)
- 06-06 14:32 [d sig:9] Inject stub tools at schema-proxy — AWS Bedrock rejects /compact when tools missing
- 06-06 13:18 [m sig:8] Joplin dedup script merged 85 duplicate notes across 11 title groups
...

### Other recent work (last 3d, top 7 by sig ≥6)
- 06-06 11:00 [2brn]             Timezone bug fixed at daemon level, not frontend
- 06-06 10:50 [jll-schema-proxy] toolConfig root-caused in Falcon→Bedrock chain
...

### Agent Learnings
<file contents unchanged>

_End memory bootstrap. Continue normally._
```

Per-line shape:

- Active line: `- MM-DD HH:MM [<m|d> sig:N] Title — summary` (~95 chars).
- Cross-repo line: `- MM-DD HH:MM [<project>] Title` (~55 chars).

### 4.6 Selection logic

| Section | Source | Filter | Sort | **Cap** |
|---|---|---|---|---|
| Active repo | Memories + Decisions (current + prev month notes) | `proj == active_project` AND `date >= now - 7d` | `sig DESC, date DESC` | **12** |
| Other recent | Memories + Decisions (current + prev month notes) | `proj != active_project` AND `date >= now - 3d` AND `sig >= 6` | `sig DESC, date DESC` | **7** |
| Today's activity | `MemoryClient.getTodayActivities()` | unchanged | unchanged | unchanged |
| Agent Learnings | `~/.config/opencode/agent-learnings.md` | unchanged | unchanged | unchanged |

Caps reflect the user's preference (questions 2 + 3 of brainstorming session 2026-06-06). Implementation must expose them as `BOOTSTRAP_ACTIVE_CAP=12` and `BOOTSTRAP_OTHER_CAP=7` constants in `src/bootstrap.ts` so they can be tuned later without code changes elsewhere.

Token budget at caps with new line shapes: **≤ 12·95 + 7·55 + ~250 (today + agent learnings overhead) ≈ 1.6 KB**. Meets primary goal.

### 4.7 Migration

`scripts/migrate-note-format.ts` (sibling of `scripts/dedup-notes.ts`):

1. Pre-flight: dump every note in `Personal Agent` notebook to `scripts/.backups/notes-pre-migration-<ts>.json` (id, title, body, parent_id, created_time). Backup is required for `--execute`; aborts if write fails.
2. For each `Memories — YYYY-MM`, `Decisions — YYYY-MM`, `Agent Learnings — YYYY-MM`:
   - Parse entries from the old format (regex over `## ts — title` blocks + `**Field**:` lines).
   - Re-render each entry in the new format. Significance: `5` for pre-migration entries (no LLM re-run).
   - PUT merged body back to Joplin.
3. For each `Project Notes — <tag>`:
   - Parse mirror entries. For each, try to find the parent Memory/Decision in the same month with matching `title` (case-insensitive).
   - If parent found: ensure parent's `proj:` field is set to `<tag>`. No data added (parent already has the full info).
   - If parent not found: prepend an "orphan" entry to the appropriate month's Memories note (these are usually older project-only entries from before the dual-write pattern).
   - DELETE the `Project Notes — <tag>` note after all entries are reconciled.
4. Dry-run is the default. `--execute` performs writes after re-reading the latest state from Joplin.
5. Idempotent: a second run after success is a no-op. Re-runs are safe.

Migration must run **before** the new reflect/render code is enabled, or the parser must accept both formats. We will support both during the migration window: parser tries the new-format regex first, falls back to the old-format regex. After migration completes successfully, the old-format branch stays for one release cycle then gets removed.

### 4.8 Code changes (concrete)

| File | Change |
|---|---|
| `src/types.ts` | Add `significance: number` to `ReflectionMemory`, `ReflectionDecision`, `ReflectionLearning`. Replace `BootstrapData.recentDecisions: string[]` and `recentMemories: string[]` and `projectNotes: string[]` with `recentActive: BootstrapEntry[]` and `recentOther: BootstrapEntry[]` where `BootstrapEntry = { date, time, kind: "m"|"d", projectTag, sig, title, summary }`. |
| `src/reflect.ts` | Update `REFLECTION_SYSTEM_PROMPT` to require `significance: 1-10`. Rewrite `renderDecision`, `renderMemory`, `renderLearning` in compact format. **Delete** `renderProjectNoteEntry`, `projectNoteName`, and the two project-mirror append loops at lines 161-164 and 169-172. |
| `src/clients/joplin.ts` | Replace `parseDecisionLines` with `parseEntries(body, opts) -> BootstrapEntry[]`. Returns structured entries from either old or new format. Add date-cutoff and sort-by-sig options. |
| `src/bootstrap.ts` | Rewrite `composeBootstrapMessage` for two-tier output (§4.5). Introduce `BOOTSTRAP_ACTIVE_CAP = 12` and `BOOTSTRAP_OTHER_CAP = 7` constants. |
| `src/plugin.ts` | `gatherBootstrapData` reads Memories + Decisions notes (current + prev month), parses, splits into active/other based on `cwd` project. Drop the separate `searchNotes("tag:projectName")` call — same data sourced from parsed entries. |
| `scripts/migrate-note-format.ts` | New — one-shot migration with dry-run, backup, idempotent re-runs (§4.7). |
| `tests/clients.test.ts` | Update fixtures for new shapes. Add round-trip parse-render tests. Add parser tests for both old and new formats. |
| `tests/bootstrap.test.ts` | New / extended — tests for two-tier projection, cap enforcement, sig threshold for cross-repo, project filtering. |
| `tests/reflect.test.ts` | Update `renderMemory` / `renderDecision` / `renderLearning` golden-string tests. |
| `README.md`, `ARCHITECTURE.md` | Updated examples + new section on bootstrap projection logic + caps env vars. |

### 4.9 Risks & mitigations

1. **Migration loss of data.** Backup JSON file written before any mutation; dry-run is default; idempotent on re-run. If `--execute` fails partway, the backup + Joplin's per-note revision history allow recovery.
2. **Reflection LLM doesn't respect `sig` reliably.** Clamp to `[1, 10]`. Default to `5` when missing/non-numeric.
3. **Old + new format coexist during migration.** Parser handles both; new-format regex tried first. Migration script's idempotency means it can run on any mixed state.
4. **Bootstrap could still blow up if many sig-9 active entries arrive.** Hard caps (12, 7) enforced after sort. Per-section budget never exceeds caps × max-line-length.
5. **Reading Joplin manually feels less rich.** Compact prefixes (`why:`, `chose:`, `vs:`) still render as clean Markdown lines. Bold field labels are gone but headings remain bold. If feedback is "too dense," it's a pure rendering change in `renderXxx()` — easy to walk back per-field.

## 5. Acceptance criteria

A successful migration meets all of:

1. New entries written by `reflect()` follow the new schema; `npm test` passes including new round-trip tests.
2. `scripts/migrate-note-format.ts --execute` completes without error on the live `Personal Agent` notebook; idempotent on second run (zero mutations).
3. Every `Project Notes — <tag>` note is deleted post-migration; the corresponding Memories/Decisions entries carry the correct `proj:` field.
4. Bootstrap message size on a typical day with ≥12 active + ≥7 cross entries is ≤ 1.6 KB.
5. Bootstrap message includes the two-tier structure exactly as in §4.5 (active section, other section, today, agent learnings, end marker).
6. Existing 150 tests still pass; new tests cover both format parsers, two-tier projection, cap enforcement, sig ranking, sig clamping.
7. `~/.cache/opencode/packages/.../dist/plugin.js` synced and `dist/plugin.js` synced; committed atomically.

## 6. Open questions

None at design time. All three brainstorming questions answered:
- Q1 (focus): **B** — agent context cost is the primary concern.
- Q2 (shape): **B** — active repo deep + light cross-project tail.
- Q3 (aggressiveness): **C** — compact prefixes, drop Project Notes mirror.
- Caps: **12 active / 7 cross-project**.

## 7. Out of scope (recap)

- agent-learnings.md compression
- Skills Proposed format
- Joplin tag taxonomy
- New entry kinds (todos, blockers)
- LLM reflection prompt's structural changes beyond adding `significance`

## 8. Next step

After user reviews this spec: invoke `writing-plans` to produce the step-by-step implementation plan.
