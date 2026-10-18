export interface BackendEvent {
  agent: string
  type: string
  step: string
  message: string
  data: Record<string, unknown>
  timestamp: number
}

function parseEvent(data: string): BackendEvent {
  const event: unknown = JSON.parse(data)
  if (
    !event || typeof event !== "object" ||
    !("agent" in event) || typeof event.agent !== "string" ||
    !("type" in event) || typeof event.type !== "string" ||
    !("step" in event) || typeof event.step !== "string" ||
    !("message" in event) || typeof event.message !== "string" ||
    !("data" in event) || !event.data || typeof event.data !== "object" || Array.isArray(event.data) ||
    !("timestamp" in event) || typeof event.timestamp !== "number"
  ) {
    throw new Error("The investigation backend sent an invalid event.")
  }
  return event as BackendEvent
}

/** Consume one investigation, stopping at its terminal event or client cancellation. */
export async function consumeInvestigationStream(
  response: Response,
  signal: AbortSignal,
  onEvent: (event: BackendEvent) => void,
): Promise<void> {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {})
    return
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `Investigation request failed (${response.status}).`
    throw new Error(message)
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("The investigation backend did not return an event stream.")
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let dataLines: string[] = []
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancel, { once: true })

  function deliver(): boolean {
    if (!dataLines.length || signal.aborted) return false
    const data = dataLines.join("\n")
    dataLines = []
    let event: BackendEvent
    try {
      event = parseEvent(data)
    } catch {
      throw new Error("The investigation backend sent an invalid event.")
    }
    onEvent(event)
    return event.agent === "pipeline" && (event.type === "complete" || event.type === "error")
  }

  function readLine(line: string): boolean {
    line = line.replace(/\r$/, "")
    if (!line) return deliver()
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
    return false
  }

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (signal.aborted) return
      buffer += decoder.decode(value, { stream: !done })
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (readLine(line)) return
      }
      if (done) {
        if (buffer && readLine(buffer)) return
        if (deliver()) return
        throw new Error("The investigation connection closed before completion. Please try again.")
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel)
    cancel()
    reader.releaseLock()
  }
}
