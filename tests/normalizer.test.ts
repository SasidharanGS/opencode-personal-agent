import { expect, test, describe } from "bun:test"
import { normalizeArgs } from "../src/normalizer"

describe("normalizeArgs — bash", () => {
  test("replaces quoted strings with <str>", () => {
    expect(normalizeArgs("bash", { command: 'gh pr create --title "fix: foo"' }))
      .toBe("bash:gh pr create --title <str>")
  })

  test("replaces absolute paths with <path>", () => {
    expect(normalizeArgs("bash", { command: "cat /home/user/file.txt" }))
      .toBe("bash:cat <path>")
  })

  test("replaces URLs with <url>", () => {
    expect(normalizeArgs("bash", { command: "curl https://api.example.com/data" }))
      .toBe("bash:curl <url>")
  })

  test("keeps flags", () => {
    expect(normalizeArgs("bash", { command: "git commit -m 'msg'" }))
      .toBe("bash:git commit -m <str>")
  })

  test("lowercases verb tokens", () => {
    expect(normalizeArgs("bash", { command: "NPM install" }))
      .toBe("bash:npm install")
  })

  test("caps at 6 tokens", () => {
    const sig = normalizeArgs("bash", { command: "a b c d e f g h" })
    expect(sig.split(" ").length).toBeLessThanOrEqual(7) // "bash:" prefix + 6 tokens
  })

  test("handles empty command", () => {
    expect(normalizeArgs("bash", { command: "" })).toBe("bash:")
  })

  test("handles missing args", () => {
    expect(normalizeArgs("bash", {})).toBe("bash:")
  })
})

describe("normalizeArgs — file tools", () => {
  test("write uses last 2 path segments", () => {
    expect(normalizeArgs("write", { filePath: "/home/user/project/src/index.ts" }))
      .toBe("write:src/index.ts")
  })

  test("edit uses last 2 path segments", () => {
    expect(normalizeArgs("edit", { filePath: "/a/b/c/d.ts" }))
      .toBe("edit:c/d.ts")
  })

  test("read uses last 2 path segments", () => {
    expect(normalizeArgs("read", { filePath: "/docs/readme.md" }))
      .toBe("read:docs/readme.md")
  })

  test("handles missing filePath", () => {
    expect(normalizeArgs("write", {})).toBe("write:")
  })
})

describe("normalizeArgs — generic fallback", () => {
  test("uses sorted top-level keys", () => {
    expect(normalizeArgs("joplin_search_notes", { query: "foo", limit: 5 }))
      .toBe("joplin_search_notes:limit,query")
  })

  test("handles empty args", () => {
    expect(normalizeArgs("mytool", {})).toBe("mytool:")
  })

  test("handles null args", () => {
    expect(normalizeArgs("mytool", null)).toBe("mytool:")
  })
})
