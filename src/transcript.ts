import type { TranscriptTurn } from "./types.js"

export function formatTranscript(turns: TranscriptTurn[]): string {
  return turns
    .map(t => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
    .join("\n\n")
}

export function trimTranscript(
  turns: TranscriptTurn[],
  maxTurns: number,
  tokenBudget: number,
): TranscriptTurn[] {
  const recent = turns.slice(-maxTurns)
  let charBudget = tokenBudget * 4
  const result: TranscriptTurn[] = []
  for (let i = recent.length - 1; i >= 0; i--) {
    const chars = recent[i].text.length + 20
    if (result.length > 0 && charBudget - chars < 0) break
    result.unshift(recent[i])
    charBudget -= chars
  }
  return result.length === 0 && recent.length > 0 ? [recent[recent.length - 1]] : result
}

export async function getTranscript(
  client: any,
  sessionId: string,
): Promise<TranscriptTurn[]> {
  try {
    const resp = await client.session.messages({ path: { id: sessionId } })
    const messages: Array<{ info: any; parts: any[] }> = resp.data ?? []
    const turns: TranscriptTurn[] = []
    for (const msg of messages) {
      const role = msg.info?.role as "user" | "assistant" | undefined
      if (role !== "user" && role !== "assistant") continue
      const text = msg.parts
        .filter((p: any) => p.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text as string)
        .join("")
        .trim()
      if (text) turns.push({ role, text })
    }
    return turns
  } catch {
    return []
  }
}
