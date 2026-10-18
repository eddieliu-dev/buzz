"use client"

import { useEngine } from "@/lib/engine"
import { AgentSidebar } from "./agent-sidebar"
import { AgentDetail } from "./agent-detail"
import { IntelReport } from "./intel-report"
import { cn } from "@/lib/utils"
import { AlertTriangle, RotateCcw } from "lucide-react"

export function InvestigatePage() {
  const { state, retryInvestigation } = useEngine()

  const isComplete = state.status === "complete"
  const hasSelectedAgent = state.selectedAgent !== null

  return (
    <div className="relative flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden">
      {state.status === "failed" && (
        <div role="alert" className="flex shrink-0 items-center justify-between gap-4 border-b border-red-400/20 bg-red-400/10 px-5 py-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div>
              <p className="text-sm font-semibold text-red-300">Investigation failed</p>
              <p className="mt-1 text-sm text-foreground/70">{state.error}</p>
            </div>
          </div>
          <button
            onClick={retryInvestigation}
            className="flex shrink-0 items-center gap-2 rounded-lg border border-red-400/30 px-3 py-2 text-sm font-medium text-red-300 hover:bg-red-400/10"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Retry investigation
          </button>
        </div>
      )}
      {/* Intel report — pinned to the right, doesn't move */}
      <div
        className={cn(
          "absolute top-0 right-0 h-full overflow-hidden border-white/[0.06] bg-black/40 backdrop-blur-sm transition-all duration-500 ease-out z-10",
          isComplete
            ? "w-[480px] border-l opacity-100"
            : "w-0 opacity-0"
        )}
      >
        <div className="w-[480px] h-full">
          {isComplete && <IntelReport />}
        </div>
      </div>

      {/* Main content area — shrinks when intel report is visible */}
      <div
        className={cn(
          "flex min-h-0 flex-1 transition-all duration-500 ease-out",
          isComplete ? "mr-[480px]" : "mr-0"
        )}
      >
        {/* Agent panel — wide by default, shrinks when thinking process is open */}
        <div
          className={cn(
            "flex-shrink-0 border-r border-white/[0.06] bg-black/20 transition-all [transition-duration:750ms] ease-in-out overflow-hidden",
            hasSelectedAgent ? "w-80" : "flex-1"
          )}
        >
          <AgentSidebar />
        </div>

        {/* Thinking process column — slides in when agent is selected */}
        <div
          className={cn(
            "overflow-hidden transition-all duration-500 ease-in-out",
            hasSelectedAgent
              ? "flex-1 min-w-0 opacity-100"
              : "w-0 opacity-0"
          )}
        >
          <AgentDetail />
        </div>
      </div>
    </div>
  )
}
