'use client'

// Risk guardrails panel + agentic-AI decision journal.

import { Badge } from '@/components/ui/badge'
import type { LlmDecision, RiskSnapshot, AccountSnapshot } from '@/lib/engine-types'

const time = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false })

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  )
}

export function RiskPanel({ risk, account }: { risk: RiskSnapshot; account: AccountSnapshot }) {
  const dailyLossPct = risk.dailyStartEquity ? Math.max(0, (-risk.dailyPnl / risk.dailyStartEquity) * 100) : 0
  const cutoffPct = risk.dailyLossCutoffPct * 100
  const posUsage = (account.positions.length / risk.maxPositions) * 100
  const halted = !!risk.haltedReason

  return (
    <div className="space-y-4">
      {halted && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">
          ⚠ Trading halted — {risk.haltedReason}
        </div>
      )}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-zinc-400">Daily loss cutoff</span>
          <span className={`font-mono ${dailyLossPct > cutoffPct * 0.6 ? 'text-amber-400' : 'text-zinc-300'}`}>
            {dailyLossPct.toFixed(2)}% / {cutoffPct.toFixed(0)}%
          </span>
        </div>
        <Bar value={(dailyLossPct / cutoffPct) * 100} color={dailyLossPct > cutoffPct * 0.6 ? 'bg-amber-500' : 'bg-emerald-500'} />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-zinc-400">Position slots</span>
          <span className="font-mono text-zinc-300">{account.positions.length} / {risk.maxPositions}</span>
        </div>
        <Bar value={posUsage} color="bg-fuchsia-500" />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div className="flex justify-between">
          <dt className="text-zinc-500">Risk / trade</dt>
          <dd className="font-mono text-zinc-300">{(risk.riskPerTradePct * 100).toFixed(0)}%</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-zinc-500">Max leverage</dt>
          <dd className="font-mono text-zinc-300">{risk.maxLeverage}×</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-zinc-500">Confidence floor</dt>
          <dd className="font-mono text-zinc-300">{(risk.minConfidence * 100).toFixed(0)}%</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-zinc-500">Mode</dt>
          <dd className="font-mono text-amber-400">PAPER</dd>
        </div>
      </dl>
      {(risk.cooldownSymbols?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {risk.cooldownSymbols!.map((c) => (
            <Badge key={c.symbol} variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-400 font-mono text-[10px]">
              {c.symbol} ⏳{c.minutesLeft}m
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

export function DecisionJournal({ decisions }: { decisions: LlmDecision[] }) {
  return (
    <div className="max-h-72 overflow-y-auto space-y-2.5 pr-1">
      {decisions.length === 0 && <p className="text-xs text-zinc-600 text-center py-6">no agent decisions yet</p>}
      {decisions.slice().reverse().map((d, i) => (
        <div key={`${d.ts}-${i}`} className="rounded-md border border-zinc-800/80 bg-zinc-950/50 px-3 py-2">
          <div className="flex items-center justify-between text-[10px] text-zinc-500">
            <span className="font-mono">cycle #{d.cycle} · {time(d.ts)}</span>
            <Badge variant="outline" className={`h-4 px-1.5 font-mono text-[9px] ${
              d.source === 'llm' ? 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300' : 'border-zinc-700 bg-zinc-800/50 text-zinc-400'
            }`}>
              {d.source === 'llm' ? 'LLM' : 'RULES'}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-zinc-300 leading-relaxed">{d.summary}</p>
          {d.executed.length > 0 && (
            <p className="mt-1 text-[10px] text-emerald-400 font-mono">executed: {d.executed.join(' · ')}</p>
          )}
        </div>
      ))}
    </div>
  )
}
