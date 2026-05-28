export function normalizeArgs(tool: string, args: any): string {
  switch (tool) {
    case "bash": {
      const cmd: string = args?.command ?? ""
      const normalized = cmd.replace(/"[^"]*"|'[^']*'/g, "<str>")
      const tokens = normalized.split(/\s+/).filter(Boolean).map(t => {
        if (t === "<str>")          return "<str>"
        if (/^\/[\w./-]+/.test(t))  return "<path>"
        if (/^https?:\/\//.test(t)) return "<url>"
        if (/^-/.test(t))           return t
        return t.toLowerCase()
      })
      return `bash:${tokens.slice(0, 6).join(" ")}`
    }
    case "write":
    case "edit":
    case "read": {
      const filePath: string = args?.filePath ?? ""
      const parts = filePath.split("/").filter(Boolean)
      return `${tool}:${parts.slice(-2).join("/")}`
    }
    default:
      return `${tool}:${Object.keys(args ?? {}).sort().join(",")}`
  }
}
