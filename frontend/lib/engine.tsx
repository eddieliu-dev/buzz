"use client"

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
} from "react"
import {
  AgentEvent,
  AgentEventType,
  AgentId,
  AgentState,
  AgentStatus,
  ALL_AGENT_IDS,
  InvestigationReport,
  InvestigationState,
  TimelineEvent,
} from "./types"
import { agentMeta, allAgentEvents, demoReport } from "./agent-data"
import { consumeInvestigationStream, type BackendEvent } from "./investigation-stream"

// ─── Initial state ───────────────────────────────────────────
function makeInitialAgentState(id: AgentId): AgentState {
  const meta = agentMeta[id]
  return {
    id,
    name: meta.name,
    icon: meta.icon,
    status: "idle",
    events: [],
    color: meta.color,
  }
}

function makeAllAgents(status: AgentStatus = "idle"): Record<AgentId, AgentState> {
  const agents = {} as Record<AgentId, AgentState>
  for (const id of ALL_AGENT_IDS) {
    agents[id] = { ...makeInitialAgentState(id), status }
  }
  return agents
}

const initialState: InvestigationState = {
  status: "idle",
  error: null,
  agents: makeAllAgents("idle"),
  timeline: [],
  selectedAgent: null,
  elapsedMs: 0,
  report: null,
}

// ─── Actions ─────────────────────────────────────────────────
type Action =
  | { type: "START_INVESTIGATION" }
  | { type: "RESET" }
  | { type: "SELECT_AGENT"; agentId: AgentId | null }
  | { type: "AGENT_EVENT"; event: AgentEvent }
  | { type: "AGENT_STATUS"; agentId: AgentId; status: AgentStatus }
  | { type: "TIMELINE_EVENT"; event: TimelineEvent }
  | { type: "INVESTIGATION_COMPLETE" }
  | { type: "INVESTIGATION_FAILED"; error: string }
  | { type: "SET_REPORT"; report: InvestigationReport }
  | { type: "TICK"; elapsedMs: number }

// ─── Reducer ─────────────────────────────────────────────────
function reducer(state: InvestigationState, action: Action): InvestigationState {
  switch (action.type) {
    case "START_INVESTIGATION":
      return {
        ...initialState,
        status: "running",
        selectedAgent: null,
        agents: makeAllAgents("idle"),
      }

    case "RESET":
      return initialState

    case "SELECT_AGENT":
      return { ...state, selectedAgent: action.agentId }

    case "AGENT_EVENT": {
      const agentId = action.event.agentId
      const agent = state.agents[agentId]
      if (!agent) return state
      return {
        ...state,
        agents: {
          ...state.agents,
          [agentId]: {
            ...agent,
            events: [...agent.events, action.event],
            status: action.event.type === "finding" ? "finding" : agent.status,
          },
        },
      }
    }

    case "AGENT_STATUS":
      if (!state.agents[action.agentId]) return state
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.agentId]: {
            ...state.agents[action.agentId],
            status: action.status,
          },
        },
      }

    case "TIMELINE_EVENT":
      return {
        ...state,
        timeline: [...state.timeline, action.event],
      }

    case "INVESTIGATION_COMPLETE":
      return { ...state, status: "complete" }

    case "INVESTIGATION_FAILED": {
      const agents = { ...state.agents }
      for (const id of ALL_AGENT_IDS) {
        if (agents[id].status === "running" || agents[id].status === "finding") {
          agents[id] = { ...agents[id], status: "stopped" }
        }
      }
      return { ...state, status: "failed", error: action.error, agents, report: null }
    }

    case "SET_REPORT":
      return { ...state, report: action.report }

    case "TICK":
      return { ...state, elapsedMs: action.elapsedMs }

    default:
      return state
  }
}

// ─── Backend SSE event → Frontend event mapping ──────────────

let _sseEventId = 0

const BACKEND_TYPE_MAP: Record<string, AgentEventType> = {
  status: "action",
  progress: "action",
  result: "result",
  error: "error",
  log: "action",
  complete: "success",
}

function isValidAgentId(id: string): id is AgentId {
  return ALL_AGENT_IDS.includes(id as AgentId)
}

function mapBackendEvent(be: BackendEvent, elapsedMs: number): AgentEvent | null {
  let agentId: AgentId

  if (be.agent === "pipeline") {
    if (be.step === "triage") agentId = "triage"
    else if (be.step === "codebase_search") agentId = "codebase_search"
    else if (be.step === "doc_analysis") agentId = "doc_analysis"
    else if (be.step === "log_analysis") agentId = "log_analysis"
    else if (be.step === "patch_generation") agentId = "patch_generation"
    else if (be.step === "report") agentId = "codebase_search"
    else return null
  } else if (isValidAgentId(be.agent)) {
    agentId = be.agent
  } else {
    return null
  }

  if (/^[═─]{5,}$/.test(be.message.trim())) return null

  const frontendType = BACKEND_TYPE_MAP[be.type] || "action"

  const detail = be.data && Object.keys(be.data).length > 0
    ? JSON.stringify(be.data, null, 2)
    : undefined

  return {
    id: `sse-${++_sseEventId}`,
    agentId,
    type: frontendType,
    message: be.message,
    detail,
    timestamp: elapsedMs,
    delay: 0,
  }
}

// ─── Context ─────────────────────────────────────────────────
interface InvestigationParams {
  issueTitle: string
  issueBody: string
  repoUrl: string
  repoName: string
}

interface EngineContext {
  state: InvestigationState
  dispatch: React.Dispatch<Action>
  startInvestigation: (params?: InvestigationParams) => void
  retryInvestigation: () => void
  resetInvestigation: () => void
  selectAgent: (id: AgentId | null) => void
}

const Ctx = createContext<EngineContext | null>(null)

export function useEngine(): EngineContext {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("useEngine must be used within EngineProvider")
  return ctx
}

// ─── Provider ────────────────────────────────────────────────
export function EngineProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)

  const timeoutIds = useRef<ReturnType<typeof setTimeout>[]>([])
  const startTime = useRef<number>(0)
  const tickInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const lastParams = useRef<InvestigationParams | undefined>(undefined)

  const clearAllTimeouts = useCallback(() => {
    timeoutIds.current.forEach(clearTimeout)
    timeoutIds.current = []
    if (tickInterval.current) {
      clearInterval(tickInterval.current)
      tickInterval.current = null
    }
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
  }, [])

  useEffect(() => clearAllTimeouts, [clearAllTimeouts])

  const selectAgent = useCallback(
    (id: AgentId | null) => dispatch({ type: "SELECT_AGENT", agentId: id }),
    [dispatch]
  )

  const resetInvestigation = useCallback(() => {
    clearAllTimeouts()
    dispatch({ type: "RESET" })
  }, [clearAllTimeouts])

  // ── Start investigation (real backend SSE or demo mock) ─────
  const startInvestigation = useCallback(
    (params?: InvestigationParams) => {
      clearAllTimeouts()
      lastParams.current = params
      dispatch({ type: "START_INVESTIGATION" })

      startTime.current = Date.now()

      tickInterval.current = setInterval(() => {
        dispatch({ type: "TICK", elapsedMs: Date.now() - startTime.current })
      }, 100)

      // ── Real backend SSE mode ───────────────────────────────
      if (params) {
        _sseEventId = 0
        const controller = new AbortController()
        abortRef.current = controller
        const activeAgents = new Set<AgentId>()

        for (const id of ALL_AGENT_IDS) {
          dispatch({ type: "AGENT_STATUS", agentId: id, status: "running" })
          activeAgents.add(id)
        }

        async function consumeSSE() {
          try {
            const res = await fetch("/api/investigate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                issue_title: params!.issueTitle,
                issue_body: params!.issueBody,
                repo_url: params!.repoUrl,
                repo_name: params!.repoName,
                enable_patch_agent: true,
              }),
              signal: controller.signal,
            })

            await consumeInvestigationStream(res, controller.signal, (be) => {
              if (abortRef.current !== controller || controller.signal.aborted) return
              const elapsedMs = Date.now() - startTime.current

              if (be.agent === "pipeline" && be.type === "error") {
                throw new Error(be.message || "The investigation failed. Please try again.")
              }

              if (be.agent === "pipeline" && be.type === "complete") {
                const report = be.data.report
                if (!report || typeof report !== "object" || Array.isArray(report)) {
                  throw new Error("The investigation ended without a report. Please try again.")
                }
                activeAgents.forEach((id) => {
                  dispatch({ type: "AGENT_STATUS", agentId: id, status: "done" })
                })
                dispatch({ type: "SET_REPORT", report: report as InvestigationReport })
                dispatch({ type: "INVESTIGATION_COMPLETE" })
                return
              }

              const frontendEvent = mapBackendEvent(be, elapsedMs)
              if (!frontendEvent) return
              dispatch({ type: "AGENT_EVENT", event: frontendEvent })

              if (
                be.type === "result" &&
                be.step === "complete" &&
                isValidAgentId(be.agent)
              ) {
                dispatch({ type: "AGENT_STATUS", agentId: be.agent, status: "done" })
              }
            })
          } catch (err: unknown) {
            // A reset, retry, or unmount owns cleanup for an abandoned run.
            if (controller.signal.aborted || abortRef.current !== controller) return
            dispatch({
              type: "INVESTIGATION_FAILED",
              error: err instanceof Error ? err.message : "The investigation failed. Please try again.",
            })
          } finally {
            if (abortRef.current === controller) {
              dispatch({ type: "TICK", elapsedMs: Date.now() - startTime.current })
              if (tickInterval.current) {
                clearInterval(tickInterval.current)
                tickInterval.current = null
              }
              abortRef.current = null
            }
          }
        }

        consumeSSE()
        return
      }

      // ── Demo mock mode (no params) ──────────────────────────
      let completedAgents = 0
      const totalAgents = ALL_AGENT_IDS.length

      function completeDemo() {
        dispatch({ type: "SET_REPORT", report: demoReport })
        dispatch({ type: "INVESTIGATION_COMPLETE" })
        if (tickInterval.current) {
          clearInterval(tickInterval.current)
          tickInterval.current = null
        }
      }

      ALL_AGENT_IDS.forEach((agentId) => {
        const events = allAgentEvents[agentId]
        if (events.length === 0) {
          dispatch({ type: "AGENT_STATUS", agentId, status: "done" })
          completedAgents++
          if (completedAgents >= totalAgents) completeDemo()
          return
        }

        dispatch({ type: "AGENT_STATUS", agentId, status: "running" })
        let cumulativeDelay = 0

        events.forEach((event) => {
          cumulativeDelay += event.delay

          const tid = setTimeout(() => {
            const timestamp = Date.now() - startTime.current
            const eventWithTimestamp = { ...event, timestamp }
            dispatch({ type: "AGENT_EVENT", event: eventWithTimestamp })

            if (event.type === "signal" || event.type === "finding" || event.type === "complete") {
              const timelineEvent: TimelineEvent = {
                id: `tl-${event.id}`,
                fromAgent: agentId,
                toAgent: event.targetAgent,
                message: event.message,
                timestamp,
                type: event.type === "signal" ? "signal" : event.type === "complete" ? "complete" : "finding",
              }
              dispatch({ type: "TIMELINE_EVENT", event: timelineEvent })
            }

            if (event.type === "complete") {
              dispatch({ type: "AGENT_STATUS", agentId, status: "done" })
              completedAgents++
              if (completedAgents >= totalAgents) completeDemo()
            }
          }, cumulativeDelay)

          timeoutIds.current.push(tid)
        })
      })
    },
    [clearAllTimeouts]
  )

  const retryInvestigation = useCallback(() => {
    startInvestigation(lastParams.current)
  }, [startInvestigation])

  return (
    <Ctx.Provider
      value={{ state, dispatch, startInvestigation, retryInvestigation, resetInvestigation, selectAgent }}
    >
      {children}
    </Ctx.Provider>
  )
}
