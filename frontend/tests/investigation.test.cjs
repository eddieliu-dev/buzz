const assert = require("node:assert/strict")
const { test } = require("node:test")
const React = require("react")
const { create, act } = require("react-test-renderer")
const { EngineProvider, useEngine } = require("../lib/engine.tsx")
const { demoReport } = require("../lib/agent-data.ts")
const { consumeInvestigationStream } = require("../lib/investigation-stream.ts")
const { POST } = require("../app/api/investigate/route.ts")
const { InvestigatePage } = require("../components/investigate/investigate-page.tsx")

const params = {
  issueTitle: "Refund calculation fails",
  issueBody: "Use the purchase price",
  repoUrl: "https://github.com/example/shop",
  repoName: "example/shop",
}

function event(overrides = {}) {
  return {
    agent: "pipeline", type: "complete", step: "done", message: "Investigation complete",
    data: { report: demoReport }, timestamp: 1, ...overrides,
  }
}

function frame(value) { return `data: ${JSON.stringify(value)}\n\n` }

function stream(chunks = []) {
  let controller
  let canceled = false
  const body = new ReadableStream({
    start(value) { controller = value },
    cancel() { canceled = true },
  })
  for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
  return {
    response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    send(value) { controller.enqueue(new TextEncoder().encode(value)) },
    close() { controller.close() },
    fail(error) { controller.error(error) },
    get canceled() { return canceled },
  }
}

function harness(t, children = null) {
  let engine
  let root
  let nextInterval = 0
  const intervals = new Set()
  t.mock.method(global, "setInterval", () => {
    const id = ++nextInterval
    intervals.add(id)
    return id
  })
  t.mock.method(global, "clearInterval", (id) => intervals.delete(id))
  function Probe() { engine = useEngine(); return null }
  act(() => { root = create(React.createElement(EngineProvider, null, React.createElement(Probe), children)) })
  t.after(() => act(() => root.unmount()))
  return {
    get engine() { return engine },
    get root() { return root },
    intervals,
    async start() { await act(async () => engine.startInvestigation(params)) },
    async retry() { await act(async () => engine.retryInvestigation()) },
    reset() { act(() => engine.resetInvestigation()) },
    unmount() { act(() => root.unmount()) },
  }
}

function assertFailed(h, message) {
  assert.equal(h.engine.state.status, "failed")
  assert.match(h.engine.state.error, message)
  assert.equal(h.engine.state.report, null)
  assert.equal(h.intervals.size, 0)
  assert.ok(Object.values(h.engine.state.agents).every(a => a.status !== "running" && a.status !== "finding"))
}

test("HTTP errors stop the run and preserve the backend's useful error", async (t) => {
  t.mock.method(global, "fetch", async () => Response.json({ error: "Python server is unavailable" }, { status: 502 }))
  const h = harness(t)
  await h.start()
  assertFailed(h, /Python server is unavailable/)
})

test("network failures stop the run and timer", async (t) => {
  t.mock.method(global, "fetch", async () => { throw new Error("Network connection lost") })
  const h = harness(t)
  await h.start()
  assertFailed(h, /Network connection lost/)
})

test("fatal pipeline errors preserve finished agents and stop unfinished agents", async (t) => {
  const s = stream([
    frame(event({ agent: "triage", type: "result", step: "complete", data: {} })),
    frame(event({ type: "error", step: "fatal", message: "API key expired", data: {} })),
    frame(event()), // A later success must never overwrite the failure.
  ])
  t.mock.method(global, "fetch", async () => s.response)
  const h = harness(t)
  await h.start()
  assertFailed(h, /API key expired/)
  assert.equal(h.engine.state.agents.triage.status, "done")
  assert.equal(h.engine.state.agents.codebase_search.status, "stopped")
  assert.equal(s.canceled, true)
})

test("EOF without completion fails rather than leaving the UI running", async (t) => {
  const s = stream([frame(event({ agent: "triage", type: "progress", data: {} }))])
  s.close()
  t.mock.method(global, "fetch", async () => s.response)
  const h = harness(t)
  await h.start()
  assertFailed(h, /closed before completion/)
})

test("a stream read error stops the run", async (t) => {
  const s = stream()
  t.mock.method(global, "fetch", async () => s.response)
  const h = harness(t)
  await h.start()
  await act(async () => s.fail(new Error("Stream disconnected")))
  assertFailed(h, /Stream disconnected/)
})

test("invalid JSON or event shapes fail explicitly", async (t) => {
  for (const payload of ["data: {broken\n\n", "data: null\n\n", "data: {}\n\n"]) {
    const s = stream([payload])
    t.mock.method(global, "fetch", async () => s.response)
    const h = harness(t)
    await h.start()
    assertFailed(h, /invalid event/)
  }
})

test("success requires a report", async (t) => {
  const s = stream([frame(event({ data: {} }))])
  t.mock.method(global, "fetch", async () => s.response)
  const h = harness(t)
  await h.start()
  assertFailed(h, /without a report/)
})

test("a valid terminal report completes, stops the timer, and releases the stream", async (t) => {
  const s = stream([frame(event())])
  t.mock.method(global, "fetch", async () => s.response)
  const h = harness(t)
  await h.start()
  assert.equal(h.engine.state.status, "complete")
  assert.equal(h.engine.state.error, null)
  assert.deepEqual(h.engine.state.report, demoReport)
  assert.ok(Object.values(h.engine.state.agents).every(a => a.status === "done"))
  assert.equal(h.intervals.size, 0)
  assert.equal(s.canceled, true)
  assert.equal(s.response.body.locked, false)
})

test("agent errors can recover without being mistaken for a fatal pipeline error", async (t) => {
  const s = stream([
    frame(event({ agent: "codebase_search", type: "error", step: "retry", message: "Retrying search", data: {} })),
    frame(event()),
  ])
  t.mock.method(global, "fetch", async () => s.response)
  const h = harness(t)
  await h.start()
  assert.equal(h.engine.state.status, "complete")
  assert.equal(h.engine.state.agents.codebase_search.events[0].type, "error")
})

test("retry clears the error and reuses the same issue parameters", async (t) => {
  const s = stream()
  const calls = []
  t.mock.method(global, "fetch", async (url, options) => {
    calls.push(JSON.parse(options.body))
    return calls.length === 1 ? Response.json({ error: "Try again" }, { status: 502 }) : s.response
  })
  const h = harness(t)
  await h.start()
  assertFailed(h, /Try again/)
  await h.retry()
  assert.equal(h.engine.state.status, "running")
  assert.equal(h.engine.state.error, null)
  assert.equal(h.intervals.size, 1)
  assert.deepEqual(calls[1], calls[0])
  await act(async () => s.send(frame(event())))
  assert.equal(h.engine.state.status, "complete")
  assert.equal(h.intervals.size, 0)
})

test("reset cancels a pending stream without turning cancellation into a failure", async (t) => {
  const s = stream()
  let signal
  t.mock.method(global, "fetch", async (_, options) => { signal = options.signal; return s.response })
  const h = harness(t)
  await h.start()
  await act(async () => h.reset())
  assert.equal(h.engine.state.status, "idle")
  assert.equal(h.engine.state.error, null)
  assert.equal(h.intervals.size, 0)
  assert.equal(signal.aborted, true)
  assert.equal(s.canceled, true)
})

test("unmount aborts the request and clears its timer", async (t) => {
  const s = stream()
  let signal
  t.mock.method(global, "fetch", async (_, options) => { signal = options.signal; return s.response })
  const h = harness(t)
  await h.start()
  await act(async () => h.unmount())
  assert.equal(signal.aborted, true)
  assert.equal(s.canceled, true)
  assert.equal(h.intervals.size, 0)
})

test("an old rejected request cannot fail a newer run or clear its timer", async (t) => {
  let rejectOld
  const old = new Promise((_, reject) => { rejectOld = reject })
  const s = stream()
  let calls = 0
  t.mock.method(global, "fetch", () => ++calls === 1 ? old : Promise.resolve(s.response))
  const h = harness(t)
  await h.start()
  await h.start()
  await act(async () => rejectOld(new Error("Old connection failed")))
  assert.equal(h.engine.state.status, "running")
  assert.equal(h.engine.state.error, null)
  assert.equal(h.intervals.size, 1)
  await act(async () => s.send(frame(event())))
  assert.equal(h.engine.state.status, "complete")
})

test("a late successful response from a reset run is ignored and canceled", async (t) => {
  let resolveOld
  const old = new Promise(resolve => { resolveOld = resolve })
  const s = stream([frame(event())])
  t.mock.method(global, "fetch", () => old)
  const h = harness(t)
  await h.start()
  h.reset()
  await act(async () => resolveOld(s.response))
  assert.equal(h.engine.state.status, "idle")
  assert.equal(h.engine.state.report, null)
  assert.equal(h.intervals.size, 0)
  assert.equal(s.canceled, true)
})

test("the failed UI shows the error and retry control without a success report", async (t) => {
  const s = stream()
  let calls = 0
  t.mock.method(global, "fetch", async () => ++calls === 1
    ? Response.json({ error: "Backend offline" }, { status: 502 })
    : s.response)
  const h = harness(t, React.createElement(InvestigatePage))
  await h.start()
  const alert = h.root.root.findByProps({ role: "alert" })
  assert.match(alert.findAllByType("p").map(p => p.props.children).join(" "), /Backend offline/)
  assert.doesNotMatch(JSON.stringify(h.root.toJSON()), /Investigation Complete|agents completed analysis/)
  const retry = h.root.root.findAllByType("button").find(button => button.props.children.includes("Retry investigation"))
  await act(async () => retry.props.onClick())
  assert.equal(h.engine.state.status, "running")
  assert.equal(h.root.root.findAllByProps({ role: "alert" }).length, 0)
})

test("fragmented CRLF and multiline SSE data are decoded correctly", async () => {
  const json = JSON.stringify(event({ message: "Complete ✓" }), null, 2)
  const data = ": heartbeat\r\n" + json.split("\n").map(line => `data: ${line}\r\n`).join("") + "\r\n"
  const bytes = new TextEncoder().encode(data)
  const body = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  })
  const received = []
  await consumeInvestigationStream(
    new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    new AbortController().signal,
    value => received.push(value),
  )
  assert.equal(received.length, 1)
  assert.equal(received[0].message, "Complete ✓")
})

test("the final event is processed even without a trailing newline", async () => {
  const s = stream([frame(event()).trimEnd()])
  s.close()
  const received = []
  await consumeInvestigationStream(s.response, new AbortController().signal, value => received.push(value))
  assert.equal(received.length, 1)
})

test("the proxy returns a useful 502 when the backend cannot be reached", async (t) => {
  let upstreamSignal
  t.mock.method(global, "fetch", async (_, options) => {
    upstreamSignal = options.signal
    throw new Error("ECONNREFUSED")
  })
  const request = new Request("http://localhost/api/investigate", { method: "POST", body: JSON.stringify({ issue_title: "Bug" }) })
  const response = await POST(request)
  assert.equal(response.status, 502)
  assert.match((await response.json()).error, /Python server/)
  assert.equal(upstreamSignal, request.signal)
})

test("the proxy rejects invalid request JSON with 400", async (t) => {
  const fetch = t.mock.method(global, "fetch", async () => { throw new Error("Should not fetch") })
  const response = await POST(new Request("http://localhost/api/investigate", { method: "POST", body: "{" }))
  assert.equal(response.status, 400)
  assert.equal(fetch.mock.callCount(), 0)
})

test("the proxy handles rejected requests and non-stream backend responses", async (t) => {
  for (const [upstream, expected] of [
    [Response.json({}, { status: 422 }), 422],
    [Response.json({}, { status: 500 }), 502],
    [new Response("<html>Error</html>"), 502],
  ]) {
    t.mock.method(global, "fetch", async () => upstream)
    const response = await POST(new Request("http://localhost/api/investigate", { method: "POST", body: "{}" }))
    assert.equal(response.status, expected)
    assert.equal(typeof (await response.json()).error, "string")
  }
})
