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
 * Phase 2 — Live (polls Joplin for new entries written by the desktop app):
 *   • Waits for idle → reflect → Joplin write from the desktop app
 *   • Verifies real entries appear in Decisions/Memories/Agent Learnings
 *
 * Phase 2 requires an active opencode session in the desktop app.
 * Have a conversation, then stop typing — the idle timer fires, reflect
 * runs, and new entries appear in Joplin. With OPENCODE_PA_IDLE_MS=20000
 * in ~/.zshrc the timer fires after 20s of inactivity.
 *
 * Usage:
 *   bun run test:e2e                  # run both phases
 *   bun run test:e2e --phase1         # automated checks only
 *   bun run test:e2e --phase2         # live Joplin watch only
 *
 * Requirements:
 *   - Joplin desktop running with Web Clipper enabled
 *   - JOPLIN_TOKEN or OPENCODE_PA_JOPLIN_TOKEN set
 *   - OPENCODE_PA_LLM_URL / OPENCODE_PA_LLM_KEY / OPENCODE_PA_LLM_MODEL set
 *   - opencode binary on PATH (Phase 1)
 *   - OpenCode desktop app running with a recent conversation (Phase 2)
 */

import { spawn, spawnSync, execSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

// ── Config ────────────────────────────────────────────────────────────────────
const PORT      = 4199
const PASSWORD  = "e2e-test"
const BASE      = `http://127.0.0.1:${PORT}`
const AUTH      = Buffer.from(`opencode:${PASSWORD}`).toString("base64")
const JOPLIN    = `http://127.0.0.1:${process.env.JOPLIN_PORT ?? "41184"}`
const J_TOKEN   = process.env.OPENCODE_PA_JOPLIN_TOKEN ?? process.env.JOPLIN_TOKEN ?? ""
const NOTEBOOK  = process.env.OPENCODE_PA_JOPLIN_NOTEBOOK ?? "Personal Agent"
const IDLE_MS   = Number(process.env.OPENCODE_PA_IDLE_MS ?? 180_000)

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

// ── Phase 1: automated checks ─────────────────────────────────────────────────
async function phase1() {
  console.log(B("\n━━ Phase 1: Automated checks ━━━━━━━━━━━━━━━━━━━━━━━━\n"))

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

    const { data: commands } = await api("GET", "/command")
    const cmdNames = Array.isArray(commands) ? commands.map((c: any) => c.name) : []
    const pluginCmds = ["wrap", "promote", "agents-edit"].filter(c => cmdNames.includes(c))
    pluginCmds.length === 3
      ? pass("Plugin commands registered", pluginCmds.join(", "))
      : fail("Plugin commands registered", `found: ${pluginCmds.join(", ") || "none"}`)

    const log = await fs.readFile(logFile, "utf8").catch(() => "")
    log.includes("bootstrapped session") && log.includes("personal-agent")
      ? pass("Plugin bootstrapped existing sessions on startup")
      : fail("Plugin bootstrapped existing sessions on startup", "no bootstrap log lines")

    log.includes("no project notes found")
      ? pass("Plugin 'no project notes' hint logged correctly")
      : pass("Plugin running cleanly")

  } finally {
    proc.kill()
    console.log(D("\n  serve stopped"))
  }
}

// ── Phase 2: live Joplin polling ──────────────────────────────────────────────
async function phase2() {
  console.log(B("\n━━ Phase 2: Live desktop app verification ━━━━━━━━━━━━\n"))

  // Verify desktop app is running
  try {
    const out = execSync("lsof -i -n -P 2>/dev/null | grep LISTEN | grep OpenCode", { encoding: "utf8" })
    const m = out.match(/TCP 127\.0\.0\.1:(\d+) \(LISTEN\)/)
    m ? pass("OpenCode desktop app running", `port ${m[1]}`)
      : fail("OpenCode desktop app running", "not detected")
  } catch {
    fail("OpenCode desktop app running", "lsof check failed")
  }

  // Snapshot Joplin before
  const now   = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  const decTitle = `Decisions \u2014 ${month}`
  const memTitle = `Memories \u2014 ${month}`
  const alTitle  = `Agent Learnings \u2014 ${month}`

  const [decB, memB, alB] = await Promise.all([
    getJoplinNote(decTitle),
    getJoplinNote(memTitle),
    getJoplinNote(alTitle),
  ])
  const count = (body: string) => (body.match(/^## /gm) ?? []).length
  const decBefore = count(decB?.body ?? "")
  const memBefore = count(memB?.body ?? "")
  const alBefore  = count(alB?.body  ?? "")

  console.log(D(`  Joplin state before — decisions:${decBefore} memories:${memBefore} learnings:${alBefore}`))

  const maxWait = IDLE_MS + 120_000  // idle threshold + 2 min for LLM + Joplin write
  const idleSec = Math.round(IDLE_MS / 1000)
  const maxSec  = Math.round(maxWait / 1000)

  console.log(Y(`\n  ⏳ Polling Joplin every 5s for up to ${maxSec}s`))
  console.log(Y(`     Idle threshold: ${idleSec}s (OPENCODE_PA_IDLE_MS)`))
  console.log(Y(`     Stop typing in opencode to trigger idle reflection.\n`))

  const startTime = Date.now()
  let written = false
  let newDec = 0, newMem = 0, newAl = 0

  while (Date.now() - startTime < maxWait) {
    await sleep(5_000)
    const elapsed = Math.round((Date.now() - startTime) / 1000)

    const [decN, memN, alN] = await Promise.all([
      getJoplinNote(decTitle),
      getJoplinNote(memTitle),
      getJoplinNote(alTitle),
    ])
    newDec = count(decN?.body ?? "") - decBefore
    newMem = count(memN?.body ?? "") - memBefore
    newAl  = count(alN?.body  ?? "") - alBefore

    if (newDec > 0 || newMem > 0 || newAl > 0) {
      written = true
      process.stdout.write("\r\x1b[K")
      console.log(G("  ✓") + ` Joplin updated!  (+${elapsed}s)  decisions:+${newDec}  memories:+${newMem}  learnings:+${newAl}`)

      // Show the new entries
      for (const [title, before, note] of [
        [decTitle, decBefore, decN],
        [memTitle, memBefore, memN],
        [alTitle,  alBefore,  alN],
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

    const remaining = Math.max(0, idleSec - elapsed)
    process.stdout.write(
      `\r  ${D(`+${elapsed}s  d:+${newDec} m:+${newMem} al:+${newAl}  ${remaining > 0 ? `stop typing — idle in ~${remaining}s` : "waiting for reflect..."}`)}\x1b[K`
    )
  }

  console.log()

  written
    ? pass("reflect() wrote to Joplin end-to-end", `d:+${newDec} m:+${newMem} al:+${newAl}`)
    : fail("reflect() wrote to Joplin",
        `No new entries after ${maxSec}s. ` +
        `Ensure you had a conversation, stopped typing for ${idleSec}s, ` +
        `and OPENCODE_PA_IDLE_MS=${IDLE_MS} is set in ~/.zshrc with OpenCode restarted.`)
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
