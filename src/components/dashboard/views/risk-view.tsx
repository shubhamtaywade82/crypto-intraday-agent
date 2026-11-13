'use client'

import { Gauge, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RiskPanel } from '@/components/dashboard/risk-panel'
import { Panel } from '@/components/dashboard/panel'
import type { EngineFeed } from '@/hooks/use-engine-feed'

// Guardrail state and account health. Limits are shown here; they are edited in the engine config.
export function RiskView({ feed }: { feed: EngineFeed }) {
  const { account } = feed
  const winRate = account.tradeCount ? (account.winCount / account.tradeCount) * 100 : 0

  return (
    <div className="grid gap-2 lg:h-full lg:min-h-0 lg:grid-cols-2">
      <Panel
        title="Risk guardrails"
        icon={<Gauge className="h-4 w-4 text-amber-400" aria-hidden />}
        footer={
          <Button size="sm" variant="outline" onClick={feed.resetAccount} className="h-7 w-full border-zinc-700 text-[11px] text-zinc-400 hover:bg-zinc-800">
            <RotateCcw className="mr-1.5 h-3 w-3" aria-hidden />
            Reset paper account
          </Button>
        }
      >
        <RiskPanel risk={feed.risk} account={account} />
      </Panel>

      <Panel title="Account">
        <dl className="grid grid-cols-2 gap-3 font-mono text-xs sm:grid-cols-3">
          <Metric label="Start equity" value={account.initialEquity.toFixed(2)} />
          <Metric label="Balance" value={account.balance.toFixed(2)} />
          <Metric label="Equity" value={account.equity.toFixed(2)} />
          <Metric label="Daily start" value={account.dailyStartEquity.toFixed(2)} />
          <Metric label="Total PnL" value={`${account.totalPnl >= 0 ? '+' : ''}${account.totalPnl.toFixed(2)}`} tone={account.totalPnl >= 0 ? 'up' : 'down'} />
          <Metric label="Daily PnL" value={`${account.dailyPnl >= 0 ? '+' : ''}${account.dailyPnl.toFixed(2)}`} tone={account.dailyPnl >= 0 ? 'up' : 'down'} />
          <Metric label="Trades" value={String(account.tradeCount)} />
          <Metric label="Wins" value={String(account.winCount)} tone="up" />
          <Metric label="Losses" value={String(account.lossCount)} tone="down" />
          <Metric label="Win rate" value={`${winRate.toFixed(0)}%`} />
          <Metric label="Open" value={`${account.positions.length} / ${feed.risk.maxPositions}`} />
          <Metric label="Cooldowns" value={String(Object.keys(feed.risk.cooldownUntil || {}).length)} />
        </dl>
      </Panel>
    </div>
  )
}

function Metric({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'up' | 'down' }) {
  const toneCls = tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-red-400' : 'text-zinc-100'
  return (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-950/60 p-2.5">
      <dt className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className={`mt-0.5 text-sm font-semibold ${toneCls}`}>{value}</dd>
    </div>
  )
}

export default RiskView
