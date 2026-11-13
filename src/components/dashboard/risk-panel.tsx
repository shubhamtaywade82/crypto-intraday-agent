'use client'

// Risk governor panel and Ollama LLM thesis journal: visualizes drawdown cutoffs,
// portfolio exposure limits, cooling-down symbols, and cycle-by-cycle model reasoning.

import { Badge } from '@/components/ui/badge'
import { AlertTriangle, Clock, ShieldAlert, Sparkles } from 'lucide-react'
import type { LlmDecision, RiskSnapshot, AccountSnapshot } from '@/lib/engine-types'

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false })
}

function ProgressGauge({ value, max, warnThreshold }: { value: number; max: number; warnThreshold: number }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100))
  const isDanger = pct >= warnThreshold
  const color = isDanger ? 'bg-rose-500' : pct >= warnThreshold * 0.7 ? 'bg-amber-500' : 'bg-emerald-500'

  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-900 border border-zinc-800">
      <div className={`h-full transition-all duration-300 ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export function RiskPanel({ risk, account }: { risk: RiskSnapshot; account: AccountSnapshot }) {
  const dailyLossPct = risk.dailyStartEquity ? Math.max(0, (-risk.dailyPnl / risk.dailyStartEquity) * 100) : 0
  const cutoffPct = risk.dailyLossCutoffPct * 100
  const cooldowns = risk.cooldownSymbols ?? []

  return (
    <div className="space-y-4 text-xs">
      {risk.haltedReason && (
        <div className="flex items-center gap-2 rounded-md border border-rose-500/50 bg-rose-500/15 p-2.5 text-rose-300">
          <ShieldAlert className="h-4 w-4 shrink-0 text-rose-400" />
          <span>Trading halted: {risk.haltedReason}</span>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-zinc-400">Daily Loss Guard</span>
          <span className="font-mono tabular-nums text-zinc-200">
            {dailyLossPct.toFixed(2)}% <span className="text-zinc-500">/ {cutoffPct.toFixed(0)}% limit</span>
          </span>
        </div>
        <ProgressGauge value={dailyLossPct} max={cutoffPct} warnThreshold={80} />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-zinc-400">Position Slots</span>
          <span className="font-mono tabular-nums text-zinc-200">
            {account.positions.length} <span className="text-zinc-500">/ {risk.maxPositions} max</span>
          </span>
        </div>
        <div className="flex gap-1.5">
          {Array.from({ length: risk.maxPositions }).map((_, idx) => (
            <div
              key={idx}
              className={`h-2 flex-1 rounded-sm transition-colors ${
                idx < account.positions.length ? 'bg-emerald-500 shadow-sm shadow-emerald-500/40' : 'bg-zinc-800'
              }`}
            />
          ))}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2.5 pt-1 text-zinc-400">
        <div className="rounded border border-zinc-800/80 bg-zinc-950/60 p-2">
          <dt className="text-[10px] uppercase text-zinc-500">Risk / Trade</dt>
          <dd className="mt-0.5 font-mono text-zinc-200">{(risk.riskPerTradePct * 100).toFixed(0)}% equity</dd>
        </div>
        <div className="rounded border border-zinc-800/80 bg-zinc-950/60 p-2">
          <dt className="text-[10px] uppercase text-zinc-500">Max Leverage</dt>
          <dd className="mt-0.5 font-mono text-zinc-200">{risk.maxLeverage}×</dd>
        </div>
        <div className="rounded border border-zinc-800/80 bg-zinc-950/60 p-2">
          <dt className="text-[10px] uppercase text-zinc-500">Confidence Floor</dt>
          <dd className="mt-0.5 font-mono text-zinc-200">{(risk.minConfidence * 100).toFixed(0)}%</dd>
        </div>
        <div className="rounded border border-zinc-800/80 bg-zinc-950/60 p-2">
          <dt className="text-[10px] uppercase text-zinc-500">Mode</dt>
          <dd className="mt-0.5 font-mono text-amber-400 font-semibold">PAPER TRADING</dd>
        </div>
      </dl>

      {cooldowns.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {cooldowns.map((c) => (
            <Badge key={c.symbol} variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-400 font-mono text-[10px]">
              <Clock className="h-3 w-3 mr-1" /> {c.symbol} {c.minutesLeft}m
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

function DecisionCard({ decision }: { decision: LlmDecision }) {
  const isLlm = decision.source === 'llm'
  return (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-950/50 p-2.5 space-y-1.5">
      <div className="flex items-center justify-between text-[10px] text-zinc-500 font-mono">
        <span>Cycle #{decision.cycle} · {time(decision.ts)}</span>
        <Badge
          variant="outline"
          className={`h-4 px-1 text-[9px] font-mono ${
            isLlm ? 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300' : 'border-zinc-700 bg-zinc-800/50 text-zinc-400'
          }`}
        >
          {isLlm ? <Sparkles className="h-2.5 w-2.5 mr-0.5" /> : null}
          {isLlm ? 'OLLAMA MINICPM5:2B' : 'RULES COMPOSITE'}
        </Badge>
      </div>
      <p className="text-xs text-zinc-300 leading-relaxed">{decision.summary}</p>
      {decision.executed.length > 0 && (
        <p className="text-[10px] font-mono text-emerald-400">Filled: {decision.executed.join(' · ')}</p>
      )}
    </div>
  )
}

export function DecisionJournal({ decisions }: { decisions: LlmDecision[] }) {
  const reversed = decisions.slice().reverse()
  return (
    <div className="space-y-2 pr-1">
      {reversed.length === 0 ? (
        <p className="py-6 text-center font-mono text-xs text-zinc-600">no AI deliberations recorded yet</p>
      ) : (
        reversed.map((d, i) => <DecisionCard key={`${d.ts}-${i}`} decision={d} />)
      )}
    </div>
  )
}

export default RiskPanel
