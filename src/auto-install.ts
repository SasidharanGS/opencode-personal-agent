// Auto-install skills + slash commands into the user's opencode config dir.
//
// opencode loads skills from ~/.config/opencode/skills/<name>/SKILL.md and
// slash commands from ~/.config/opencode/commands/<name>.md — both are
// filesystem-based and not loaded from npm packages. To keep the install
// flow to a single step (add the plugin to opencode.jsonc), we copy our
// bundled skills/commands into those directories on every plugin load.
//
// Idempotent: only copies files that don't already exist, so we never clobber
// user edits. Opt-out: set OPENCODE_PA_SKIP_AUTO_INSTALL=1.

import { mkdir, readdir, copyFile, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export interface AutoInstallResult {
  skipped: boolean
  skillsAdded: string[]
  commandsAdded: string[]
  reason?: string
}

/**
 * Resolve the package root from a built bundle's import.meta.url.
 * The bundle lives at <pkg>/dist/plugin.js, so root = dirname(dirname(url)).
 */
export function packageRootFromMetaUrl(metaUrl: string): string {
  const fileUrl = new URL(metaUrl)
  const filePath = fileURLToPath(fileUrl)
  return resolve(dirname(filePath), "..")
}

/**
 * Copy missing skill subdirectories and slash command files from the package
 * into the user's opencode config. Returns a summary of what was added.
 */
export async function ensureExtras(
  packageRoot: string,
  opencodeConfigDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AutoInstallResult> {
  if (env.OPENCODE_PA_SKIP_AUTO_INSTALL === "1") {
    return { skipped: true, skillsAdded: [], commandsAdded: [], reason: "OPENCODE_PA_SKIP_AUTO_INSTALL=1" }
  }

  const skillsSrc = join(packageRoot, "skills")
  const commandsSrc = join(packageRoot, "commands")

  if (!existsSync(skillsSrc) && !existsSync(commandsSrc)) {
    return { skipped: true, skillsAdded: [], commandsAdded: [], reason: "no bundled skills or commands found" }
  }

  const skillsDest = join(opencodeConfigDir, "skills")
  const commandsDest = join(opencodeConfigDir, "commands")
  await mkdir(skillsDest, { recursive: true })
  await mkdir(commandsDest, { recursive: true })

  const skillsAdded = await copyMissingSkills(skillsSrc, skillsDest)
  const commandsAdded = await copyMissingCommands(commandsSrc, commandsDest)

  return { skipped: false, skillsAdded, commandsAdded }
}

async function copyMissingSkills(src: string, dest: string): Promise<string[]> {
  if (!existsSync(src)) return []
  const added: string[] = []
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const targetDir = join(dest, entry.name)
    // Treat the skill as "installed" if its SKILL.md exists. Missing assets
    // around a present SKILL.md are the user's concern, not ours.
    const targetSkillMd = join(targetDir, "SKILL.md")
    if (existsSync(targetSkillMd)) continue
    await copyDirShallow(join(src, entry.name), targetDir)
    added.push(entry.name)
  }
  return added
}

async function copyMissingCommands(src: string, dest: string): Promise<string[]> {
  if (!existsSync(src)) return []
  const added: string[] = []
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const target = join(dest, entry.name)
    if (existsSync(target)) continue
    await copyFile(join(src, entry.name), target)
    added.push(entry.name.replace(/\.md$/, ""))
  }
  return added
}

async function copyDirShallow(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    await copyFile(join(src, entry.name), join(dest, entry.name))
  }
}
