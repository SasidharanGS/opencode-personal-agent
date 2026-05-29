import { expect, test, describe } from "bun:test"
import { readFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"

// Catches the most likely cause of silent breakage: someone edits src/, commits
// without running `bun run build`, and pushes — opencode installs the package
// via git+https and gets a stale dist/plugin.js. Comparing the committed
// bundle against a fresh build flags the drift before merge.
describe("dist/plugin.js is in sync with src/", () => {
  test("a fresh build matches the committed bundle byte-for-byte", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "opencode-personal-agent-dist-"))
    try {
      await $`bun build src/plugin.ts --outdir ${tmp} --format esm --target node`.quiet()
      const fresh = await readFile(join(tmp, "plugin.js"))
      const committed = await readFile("dist/plugin.js")
      if (!fresh.equals(committed)) {
        throw new Error(
          "dist/plugin.js is out of date — run `bun run build` and commit the result. " +
            `(committed=${committed.length} bytes, fresh=${fresh.length} bytes)`,
        )
      }
      expect(fresh.equals(committed)).toBe(true)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }, 30_000)
})
