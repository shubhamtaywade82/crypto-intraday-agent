'use client'

import { Activity, Bot } from 'lucide-react'
import AgentFeed from '@/components/dashboard/agent-feed'
import { DecisionJournal } from '@/components/dashboard/risk-panel'
import { Panel } from '@/components/dashboard/panel'
import type { EngineFeed } from '@/hooks/use-engine-feed'

// The agent's live reasoning: telemetry on the left, decisions and loop state on the right.
export function AgentView({ feed }: { feed: EngineFeed }) {
  const { status, logs, decisions } = feed
  return (
    <div className="grid gap-2 lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_400px]">
      <Panel
        scroll={false}
        title="Agent activity"
        icon={<Activity className="h-4 w-4 text-emerald-400" aria-hidden />}
        actions={
          <span className={`font-mono text-[10px] ${status.running ? 'text-emerald-400' : 'text-zinc-500'}`}>
            {status.running ? '● AUTO' : '○ IDLE'}
          </span>
        }
      >
        <AgentFeed logs={logs.slice(-300)} />
      </Panel>

      <div className="flex min-h-0 flex-col gap-2 lg:h-full">
        <Panel title="Loop status" icon={<Bot className="h-4 w-4 text-zinc-500" aria-hidden />} scroll={false} className="shrink-0">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-[11px]">
            <Stat label="Cycle" value={`#${status.cycle}`} />
            <Stat label="Interval" value={`${status.scanIntervalSec}s`} />
            <Stat label="Last scan" value={fmtTime(status.lastScanTs)} />
            <Stat label="Next scan" value={fmtTime(status.nextScanTs)} />
            <Stat label="Symbols" value={String(status.symbols.length)} />
            <Stat label="Binance WS" value={status.wsConnected ? 'connected' : 'down'} />
          </dl>
        </Panel>
        <Panel title="Decision journal" icon={<Bot className="h-4 w-4 text-fuchsia-400" aria-hidden />} className="min-h-[240px] flex-1">
          <DecisionJournal decisions={decisions} />
        </Panel>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="text-zinc-200">{value}</dd>
    </div>
  )
}

function fmtTime(ts: number | null) {
  return ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'
}

export default AgentView
