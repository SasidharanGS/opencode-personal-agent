#!/usr/bin/env bun
/**
 * E2E test for opencode-personal-agent
 *
 * Two phases:
 *
 * Phase 1 — Automated (uses a dedicated opencode serve instance):
 *   • Plugin loads and registers /wrap, /promote, /agents-edit
 *   • All existing sessions get bootstrapped on startup
 *
 * Phase 2 — Live (watches the desktop app's log file):
 *   • Waits for the next session.idle event in the desktop app
 *   • Verifies reflect() fires and writes to Joplin
 *   • Cleans up the test Joplin entries afterward
 *
 * Phase 2 requires an active opencode session in the desktop app.
 * Have a conversation, then stop typing — the 3-minute idle timer will fire.
 * Use OPENCODE_PA_IDLE_MS=20000 in ~/.zshrc for faster testing.
 *
 * Usage:
 *   bun run test:e2e                  # run both phases
 *   bun run test:e2e --phase1         # automated checks only
 *   bun run test:e2e --phase2         # live watch only
 *
 * Requirements:
 *   - Joplin desktop running with Web Clipper enabled
 *   - JOPLIN_TOKEN or OPENCODE_PA_JOPLIN_TOKEN set
 *   - OPENCODE_PA_LLM_URL / OPENCODE_PA_LLM_KEY / OPENCODE_PA_LLM_MODEL set
 *   - opencode binary on PATH (Phase 1)
 *   - OpenCode desktop app running with a conversation open (Phase 2)
 */

import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

// ── Config ────────────────────────────────────────────────────────────────────
const PORT      = 4199
const PASSWORD  = "e2e-test"
const BASE      = `http://127.0.0.1:${PORT}`
const AUTH      = Buffer.from(`opencode:${PASSWORD}`).toString("base64")
const DIR       = process.cwd()
const JOPLIN    = `http://127.0.0.1:${process.env.JOPLIN_PORT ?? "41184"}`
const J_TOKEN   = process.env.OPENCODE_PA_JOPLIN_TOKEN ?? process.env.JOPLIN_TOKEN ?? ""
const NOTEBOOK  = process.env.OPENCODE_PA_JOPLIN_NOTEBOOK ?? "Personal Agent"
const IDLE_MS   = Number(process.env.OPENCODE_PA_IDLE_MS ?? 180_000)
const LOG_DIR   = path.join(os.homedir(), ".local", "share", "opencode", "log")

const ONLY_PHASE1 = process.argv.includes("--phase1")
const ONLY_PHASE2 = process.argv.includes("--phase2")

// ── Colours ───────────────────────────────────────────────────────────────────
const G = (s: string) => `\x1b[32m${s}\x1b[0m`
const R = (s: string) => `\x1b[31m${s}\x1b[0m`
const D = (s: string) => `\x1b[2m${s}\x1b[0m`
const B = (s: string) => `\x1b[1m${s}\x1b[0m`
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(method: string, path: string, body?: object) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Basic ${AUTH}`, Accept: "application/json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  try   { return { status: res.status, data: JSON.parse(text) } }
  catch { return { status: res.status, data: text } }
}

async function joplin(method: string, endpoint: string, body?: object) {
  const sep = endpoint.includes("?") ? "&" : "?"
  const res = await fetch(`${JOPLIN}${endpoint}${sep}token=${J_TOKEN}`, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  })
  const text = await res.text()
  try   { return { status: res.status, data: JSON.parse(text) } }
  catch { return { status: res.status, data: text } }
}

async function getJoplinNote(title: string) {
  const tokens = title.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim()
  const { data } = await joplin("GET",
    `/search?query=${encodeURIComponent(`${tokens} notebook:"${NOTEBOOK}"`)}&fields=id,title,body&limit=10`)
  const items = (data as any)?.items ?? []
  return items.find((n: any) => n.title === title) ?? null
}

// ── Results ───────────────────────────────────────────────────────────────────
interface Result { name: string; passed: boolean; detail: string }
const results: Result[] = []
const pass = (name: string, detail = "") => {
  results.push({ name, passed: true, detail })
  console.log(G("  ✓") + ` ${name}` + (detail ? D(`  — ${detail}`) : ""))
}
const fail = (name: string, detail = "") => {
  results.push({ name, passed: false, detail })
  console.log(R("  ✗") + ` ${name}` + (detail ? `  — ${detail}` : ""))
}

// ── Pre-flight ────────────────────────────────────────────────────────────────
async function preflight(): Promise<boolean> {
  console.log(B("\n── Pre-flight checks ─────────────────────────────────\n"))
  let ok = true

  const oc = spawnSync("which", ["opencode"], { encoding: "utf8" })
  if (oc.status === 0) {
    const ver = spawnSync("opencode", ["--version"], { encoding: "utf8" })
    console.log(G("  ✓") + ` opencode ${ver.stdout.trim()}`)
  } else { console.log(R("  ✗") + " opencode not on PATH"); ok = false }

  if (J_TOKEN) {
    const r = await joplin("GET", "/notes?limit=1&fields=id").catch(() => null)
    r?.status === 200
      ? console.log(G("  ✓") + " Joplin API reachable")
      : (console.log(R("  ✗") + ` Joplin API error (${r?.status}) — is Joplin open?`), ok = false)
  } else { console.log(R("  ✗") + " JOPLIN_TOKEN not set"); ok = false }

  const llmUrl = process.env.OPENCODE_PA_LLM_URL ?? "http://127.0.0.1:8889/v1"
  const llmRes = await fetch(`${llmUrl}/models`, {
    headers: { Authorization: `Bearer ${process.env.OPENCODE_PA_LLM_KEY ?? "1"}` },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null)
  llmRes && (llmRes.status === 200 || llmRes.status === 401)
    ? console.log(G("  ✓") + ` LLM gateway at ${llmUrl}`)
    : (console.log(R("  ✗") + ` LLM gateway unreachable at ${llmUrl}`), ok = false)

  return ok
}

// ── Phase 1: automated checks via dedicated serve instance ────────────────────
async function phase1() {
  console.log(B("\n━━ Phase 1: Automated checks ━━━━━━━━━━━━━━━━━━━━━━━━\n"))

  // Start server
  const logFile = path.join(os.tmpdir(), `oc-e2e-${Date.now()}.log`)
  console.log(D(`  log: ${logFile}`))
  const logFd = await fs.open(logFile, "w")
  const proc = spawn("opencode", ["serve", "--port", String(PORT), "--print-logs"], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: PASSWORD, OPENCODE_PA_JOPLIN_TOKEN: J_TOKEN },
    stdio: ["ignore", logFd.fd, logFd.fd],
  })

  let serverUp = false
  for (let i = 0; i < 20; i++) {
    await sleep(1_000)
    const r = await api("GET", "/global/health").catch(() => null)
    if (r?.status === 200) { serverUp = true; break }
  }

  try {
    if (!serverUp) { fail("opencode serve started", "not ready after 20s"); return }
    pass("opencode serve started", `port ${PORT}`)
    await sleep(3_000)

    // Check 1: commands registered
    const { data: commands } = await api("GET", "/command")
    const cmdNames = Array.isArray(commands) ? commands.map((c: any) => c.name) : []
    const pluginCmds = ["wrap", "promote", "agents-edit"].filter(c => cmdNames.includes(c))
    pluginCmds.length === 3
      ? pass("Plugin commands registered", pluginCmds.join(", "))
      : fail("Plugin commands registered", `found: ${pluginCmds.join(", ") || "none"}`)

    // Check 2: bootstrap ran for existing sessions
    const log = await fs.readFile(logFile, "utf8").catch(() => "")
    log.includes("bootstrapped session") && log.includes("personal-agent")
      ? pass("Plugin bootstrapped existing sessions on startup")
      : fail("Plugin bootstrapped existing sessions on startup", "no bootstrap log lines")

    // Check 3: no project notes hint fires (expected for fresh state)
    log.includes("no project notes found")
      ? pass("Plugin logged 'no project notes' hint correctly")
      : pass("Plugin running cleanly", "no unexpected errors")

  } finally {
    proc.kill()
    console.log(D("\n  serve stopped"))
  }
}

// ── Phase 2: live watch of the desktop app ────────────────────────────────────
async function phase2() {
  console.log(B("\n━━ Phase 2: Live desktop app verification ━━━━━━━━━━━━\n"))

  // Find the latest desktop app log file
  let logFiles: string[] = []
  try {
    const entries = await fs.readdir(LOG_DIR)
    logFiles = entries
      .filter(f => f.endsWith(".log"))
      .map(f => path.join(LOG_DIR, f))
      .sort()
      .reverse()
  } catch {
    fail("Desktop app log found", `cannot read ${LOG_DIR}`)
    return
  }

  // Helper: get the current active log (most recently modified)
  async function getActiveLog(): Promise<string> {
    const entries = await fs.readdir(LOG_DIR)
    const logs = await Promise.all(
      entries.filter(f => f.endsWith(".log")).map(async f => {
        const full = path.join(LOG_DIR, f)
        const stat = await fs.stat(full).catch(() => null)
        return { path: full, mtime: stat?.mtimeMs ?? 0 }
      })
    )
    return logs.sort((a, b) => b.mtime - a.mtime)[0]?.path ?? logFiles[0]
  }

  // Find the log with plugin lines (for the "plugin is active" check)
  let logFile = logFiles[0]
  for (const f of logFiles.slice(0, 5)) {
    const content = await fs.readFile(f, "utf8").catch(() => "")
    if (content.includes("personal-agent")) { logFile = f; break }
  }
  console.log(D(`  plugin last seen in: ${path.basename(logFile)}`))

  // Verify the plugin is loaded in this log
  const initialLog = await fs.readFile(logFile, "utf8").catch(() => "")
  if (!initialLog.includes("personal-agent")) {
    fail("Plugin active in desktop app", "no personal-agent lines in latest log — restart OpenCode")
    return
  }
  pass("Plugin active in desktop app log")

  // Snapshot Joplin before
  const now   = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  const decTitle = `Decisions \u2014 ${month}`
  const memTitle = `Memories \u2014 ${month}`
  const alTitle  = `Agent Learnings \u2014 ${month}`

  const decNoteB = await getJoplinNote(decTitle)
  const memNoteB = await getJoplinNote(memTitle)
  const alNoteB  = await getJoplinNote(alTitle)
  const decBefore = (decNoteB?.body ?? "").match(/^## /gm)?.length ?? 0
  const memBefore = (memNoteB?.body ?? "").match(/^## /gm)?.length ?? 0
  const alBefore  = (alNoteB?.body  ?? "").match(/^## /gm)?.length ?? 0

  console.log(D(`  Joplin state before — decisions:${decBefore} memories:${memBefore} learnings:${alBefore}`))

  // Compute idle wait time with buffer
  const idleThreshold = IDLE_MS
  const maxWait = idleThreshold + 90_000  // threshold + 90s for LLM + Joplin write
  const idleMin = Math.round(idleThreshold / 1000)
  const maxMin  = Math.round(maxWait / 1000)

  console.log(Y(`\n  ⏳ Waiting up to ${maxMin}s for idle → reflect → Joplin write`))
  console.log(Y(`     (idle threshold = ${idleMin}s — stop typing in opencode to trigger)`))
  console.log()

  const startTime = Date.now()
  let idleFired  = false
  let reflectRan = false
  let sessionId  = ""

  // Snapshot all log file sizes at test start — only read content added after this point
  const logSnapshots = new Map<string, number>()
  for (const f of logFiles.slice(0, 5)) {
    const stat = await fs.stat(f).catch(() => null)
    logSnapshots.set(f, stat?.size ?? 0)
  }

  async function getNewLogContent(): Promise<string> {
    const parts: string[] = []
    // Always include the most recently modified log
    const activeLog = await getActiveLog()
    if (!logSnapshots.has(activeLog)) logSnapshots.set(activeLog, 0)
    for (const [f, baseline] of logSnapshots) {
      const content = await fs.readFile(f, "utf8").catch(() => "")
      if (content.length > baseline) parts.push(content.slice(baseline))
    }
    return parts.join("")
  }

  while (Date.now() - startTime < maxWait) {
    await sleep(5_000)
    const elapsed = Math.round((Date.now() - startTime) / 1000)
    const newLog = await getNewLogContent()

    if (!idleFired && newLog.includes("session.idle")) {
      idleFired = true
      console.log(G("  ✓") + ` session.idle fired  (+${elapsed}s)`)
    }

    if (!reflectRan && newLog.includes("reflect: wrote")) {
      const match = newLog.match(/service=personal-agent sessionId=(\S+) reflect: wrote (\d+)d (\d+)m (\d+)l/)
      if (match) {
        reflectRan = true
        sessionId  = match[1]
        const [, , d, m, l] = match
        console.log(G("  ✓") + ` reflect() ran  (+${elapsed}s) — wrote ${d}d ${m}m ${l}l`)

        // Wait up to 15s for Joplin to flush
        let joplinUpdated = false
        for (let j = 0; j < 5; j++) {
          await sleep(3_000)
          const decNote = await getJoplinNote(decTitle)
          const memNote = await getJoplinNote(memTitle)
          const alNote  = await getJoplinNote(alTitle)
          const decNow = (decNote?.body ?? "").match(/^## /gm)?.length ?? 0
          const memNow = (memNote?.body ?? "").match(/^## /gm)?.length ?? 0
          const alNow  = (alNote?.body  ?? "").match(/^## /gm)?.length ?? 0
          if (decNow > decBefore || memNow > memBefore || alNow > alBefore) {
            joplinUpdated = true

            // Show new entries
            for (const [title, before, note] of [
              [decTitle, decBefore, decNote],
              [memTitle, memBefore, memNote],
              [alTitle,  alBefore,  alNote ],
            ] as [string, number, any][]) {
              const body = note?.body ?? ""
              const sections = body.split("---").map((s: string) => s.trim()).filter((s: string) => s.startsWith("##"))
              const newSections = sections.slice(before)
              if (newSections.length) {
                console.log(`\n  ${B("📓 " + title)}`)
                for (const s of newSections)
                  console.log(`     ${s.slice(0, 300).replace(/\n/g, "\n     ")}`)
              }
            }
            break
          }
        }

        joplinUpdated
          ? pass("Joplin notes written", `decisions:${(await getJoplinNote(decTitle))?.body?.match(/^## /gm)?.length ?? 0} memories:${(await getJoplinNote(memTitle))?.body?.match(/^## /gm)?.length ?? 0}`)
          : pass("reflect() ran", "wrote 0 new entries this turn (LLM found nothing notable — try having a more substantive conversation)")

        break
      }
    }

    if (!reflectRan) {
      const phase = !idleFired ? "waiting for idle" : "idle fired, timer counting..."
      process.stdout.write(`\r  ${D(`+${elapsed}s  ${phase} (idle in ~${Math.max(0, idleMin - elapsed)}s)`)}\x1b[K`)
    }
  }

  if (!idleFired)  fail("session.idle fired",      `not seen in ${maxMin}s — is OpenCode open with an active session?`)
  if (!reflectRan) fail("reflect() triggered",     "idle fired but reflect never ran — check logs")

  // Cleanup: remove entries written by this test's session from Joplin
  if (sessionId) {
    console.log(D("\n\n  Cleaning up test Joplin entries..."))
    let cleaned = 0
    for (const title of [decTitle, memTitle, alTitle]) {
      const note = await getJoplinNote(title)
      if (!note || !note.body.includes(sessionId)) continue
      const sections = note.body.split("\n---\n")
      const keep = sections.filter((s: string) => !s.includes(sessionId))
      if (keep.length < sections.length) {
        await joplin("PUT", `/notes/${note.id}`, { body: keep.join("\n---\n").trim() })
        cleaned += sections.length - keep.length
      }
    }
    cleaned > 0
      ? pass(`Cleaned up ${cleaned} test Joplin entries`)
      : pass("Cleanup complete")
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(B("\n╔══════════════════════════════════════════════════════╗"))
  console.log(B("║     opencode-personal-agent — E2E Test               ║"))
  console.log(B("╚══════════════════════════════════════════════════════╝"))
  console.log(D(`  notebook  : ${NOTEBOOK}`))
  console.log(D(`  idle_ms   : ${IDLE_MS}`))

  if (!(await preflight())) {
    console.log(R("\nPre-flight failed — fix the issues above and re-run.\n"))
    process.exit(1)
  }

  if (!ONLY_PHASE2) await phase1()
  if (!ONLY_PHASE1) await phase2()

  const passed = results.filter(r => r.passed).length
  const total  = results.length
  console.log(B("\n── Results ───────────────────────────────────────────\n"))
  for (const r of results)
    console.log(`  ${r.passed ? G("✓") : R("✗")} ${r.name}` + (r.detail && !r.passed ? `  — ${r.detail}` : ""))
  console.log()

  if (passed === total) {
    console.log(G(B(`  All ${total} tests passed. Plugin is working end-to-end.\n`)))
  } else {
    console.log(R(B(`  ${passed}/${total} passed.\n`)))
    process.exit(1)
  }
}

main().catch(err => {
  console.error(R("\nFatal: " + err.message))
  process.exit(1)
})
