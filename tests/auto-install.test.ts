import { expect, test, describe } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { ensureExtras, packageRootFromMetaUrl } from "../src/auto-install.js"

async function makePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pa-pkg-"))
  await mkdir(join(root, "skills", "wrap"), { recursive: true })
  await mkdir(join(root, "skills", "promote"), { recursive: true })
  await writeFile(join(root, "skills", "wrap", "SKILL.md"), "---\nname: wrap\ndescription: x\n---\nbody")
  await writeFile(join(root, "skills", "wrap", "extra.md"), "asset")
  await writeFile(join(root, "skills", "promote", "SKILL.md"), "---\nname: promote\ndescription: y\n---\nbody")
  await mkdir(join(root, "commands"), { recursive: true })
  await writeFile(join(root, "commands", "wrap.md"), "wrap cmd")
  await writeFile(join(root, "commands", "promote.md"), "promote cmd")
  return root
}

describe("auto-install", () => {
  test("copies skills and commands into an empty config dir", async () => {
    const pkg = await makePackage()
    const cfg = await mkdtemp(join(tmpdir(), "pa-cfg-"))
    try {
      const result = await ensureExtras(pkg, cfg, {} as NodeJS.ProcessEnv)
      expect(result.skipped).toBe(false)
      expect(result.skillsAdded.sort()).toEqual(["promote", "wrap"])
      expect(result.commandsAdded.sort()).toEqual(["promote", "wrap"])
      expect(existsSync(join(cfg, "skills", "wrap", "SKILL.md"))).toBe(true)
      expect(existsSync(join(cfg, "skills", "wrap", "extra.md"))).toBe(true)
      expect(existsSync(join(cfg, "commands", "wrap.md"))).toBe(true)
    } finally {
      await rm(pkg, { recursive: true, force: true })
      await rm(cfg, { recursive: true, force: true })
    }
  })

  test("is idempotent — second run adds nothing", async () => {
    const pkg = await makePackage()
    const cfg = await mkdtemp(join(tmpdir(), "pa-cfg-"))
    try {
      await ensureExtras(pkg, cfg, {} as NodeJS.ProcessEnv)
      const second = await ensureExtras(pkg, cfg, {} as NodeJS.ProcessEnv)
      expect(second.skillsAdded).toEqual([])
      expect(second.commandsAdded).toEqual([])
    } finally {
      await rm(pkg, { recursive: true, force: true })
      await rm(cfg, { recursive: true, force: true })
    }
  })

  test("never overwrites existing skill SKILL.md or command file", async () => {
    const pkg = await makePackage()
    const cfg = await mkdtemp(join(tmpdir(), "pa-cfg-"))
    try {
      await mkdir(join(cfg, "skills", "wrap"), { recursive: true })
      await writeFile(join(cfg, "skills", "wrap", "SKILL.md"), "USER EDITED")
      await mkdir(join(cfg, "commands"), { recursive: true })
      await writeFile(join(cfg, "commands", "wrap.md"), "USER CMD")

      const result = await ensureExtras(pkg, cfg, {} as NodeJS.ProcessEnv)
      expect(result.skillsAdded).toEqual(["promote"])
      expect(result.commandsAdded).toEqual(["promote"])
      expect(await readFile(join(cfg, "skills", "wrap", "SKILL.md"), "utf8")).toBe("USER EDITED")
      expect(await readFile(join(cfg, "commands", "wrap.md"), "utf8")).toBe("USER CMD")
    } finally {
      await rm(pkg, { recursive: true, force: true })
      await rm(cfg, { recursive: true, force: true })
    }
  })

  test("opt-out via OPENCODE_PA_SKIP_AUTO_INSTALL=1", async () => {
    const pkg = await makePackage()
    const cfg = await mkdtemp(join(tmpdir(), "pa-cfg-"))
    try {
      const result = await ensureExtras(pkg, cfg, { OPENCODE_PA_SKIP_AUTO_INSTALL: "1" } as NodeJS.ProcessEnv)
      expect(result.skipped).toBe(true)
      expect(result.reason).toMatch(/SKIP_AUTO_INSTALL/)
      // Nothing was copied.
      expect(existsSync(join(cfg, "skills"))).toBe(false)
    } finally {
      await rm(pkg, { recursive: true, force: true })
      await rm(cfg, { recursive: true, force: true })
    }
  })

  test("skips gracefully when package has no skills or commands", async () => {
    const pkg = await mkdtemp(join(tmpdir(), "pa-empty-"))
    const cfg = await mkdtemp(join(tmpdir(), "pa-cfg-"))
    try {
      const result = await ensureExtras(pkg, cfg, {} as NodeJS.ProcessEnv)
      expect(result.skipped).toBe(true)
      expect(result.reason).toMatch(/no bundled/)
    } finally {
      await rm(pkg, { recursive: true, force: true })
      await rm(cfg, { recursive: true, force: true })
    }
  })

  test("packageRootFromMetaUrl resolves <pkg>/dist/plugin.js to <pkg>", () => {
    const root = packageRootFromMetaUrl("file:///some/where/opencode-personal-agent/dist/plugin.js")
    expect(root).toBe("/some/where/opencode-personal-agent")
  })
})
