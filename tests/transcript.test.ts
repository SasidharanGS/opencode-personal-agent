import { expect, test, describe } from "bun:test"
import { formatTranscript, trimTranscript } from "../src/transcript"
import type { TranscriptTurn } from "../src/types"

describe("formatTranscript", () => {
  test("formats user and assistant turns", () => {
    const turns: TranscriptTurn[] = [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
    ]
    const result = formatTranscript(turns)
    expect(result).toContain("User: hello")
    expect(result).toContain("Assistant: hi there")
  })

  test("returns empty string for empty turns", () => {
    expect(formatTranscript([])).toBe("")
  })
})

describe("trimTranscript", () => {
  test("keeps all turns when under limit", () => {
    const turns: TranscriptTurn[] = [
      { role: "user", text: "a" },
      { role: "assistant", text: "b" },
    ]
    expect(trimTranscript(turns, 30, 8000)).toHaveLength(2)
  })

  test("trims to maxTurns", () => {
    const turns: TranscriptTurn[] = Array.from({ length: 40 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `message ${i}`,
    }))
    expect(trimTranscript(turns, 30, 8000)).toHaveLength(30)
  })

  test("trims when total chars exceed token budget (rough: chars/4)", () => {
    const longText = "x".repeat(1000)
    const turns: TranscriptTurn[] = Array.from({ length: 10 }, () => ({
      role: "user" as const,
      text: longText,
    }))
    const result = trimTranscript(turns, 30, 100)
    expect(result.length).toBeLessThan(10)
  })

  test("always returns at least 1 turn if any exist", () => {
    const turns: TranscriptTurn[] = [{ role: "user", text: "x".repeat(10000) }]
    expect(trimTranscript(turns, 30, 10)).toHaveLength(1)
  })
})
