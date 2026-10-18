import { NextRequest } from "next/server"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000"

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "Invalid investigation request JSON." }, { status: 400 })
  }

  let upstream: Response
  try {
    upstream = await fetch(`${BACKEND_URL}/investigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: req.signal,
    })
  } catch {
    if (req.signal.aborted) return new Response(null, { status: 499 })
    return Response.json(
      { error: "Unable to connect to the investigation backend. Check that the Python server is running." },
      { status: 502 },
    )
  }

  if (!upstream.ok) {
    void upstream.body?.cancel().catch(() => {})
    return Response.json(
      { error: `The investigation backend rejected the request (${upstream.status}).` },
      { status: upstream.status >= 500 ? 502 : upstream.status },
    )
  }
  if (!upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream")) {
    void upstream.body?.cancel().catch(() => {})
    return Response.json(
      { error: "The investigation backend did not return an event stream." },
      { status: 502 },
    )
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
