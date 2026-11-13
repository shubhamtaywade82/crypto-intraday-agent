'use client'

import { Activity, LineChart } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import MarketTable from '@/components/dashboard/market-table'
import PriceChart from '@/components/dashboard/price-chart'
import PositionsPanel from '@/components/dashboard/positions-panel'
import { Panel } from '@/components/dashboard/panel'
import type { EngineFeed, Timeframe } from '@/hooks/use-engine-feed'

interface Props {
  feed: EngineFeed
  selected: string
  tf: Timeframe
  onSelect: (symbol: string) => void
  onTimeframe: (tf: Timeframe) => void
}

// Three columns on desktop: market list, chart, positions. Everything fits the viewport.
export function TradeView({ feed, selected, tf, onSelect, onTimeframe }: Props) {
  const positionSymbols = new Set(feed.account.positions.map((p) => p.symbol))

  return (
    <div className="grid gap-2 lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)_minmax(0,460px)] 2xl:grid-cols-[minmax(0,460px)_minmax(0,1fr)_minmax(0,600px)]">
      <Panel title={`Market watch · top ${feed.tickers.length || 10} USDT-M`} icon={<LineChart className="h-4 w-4 text-zinc-500" aria-hidden />}>
        <MarketTable rows={feed.tickers} selected={selected} onSelect={onSelect} positionSymbols={positionSymbols} />
      </Panel>

      <Panel
        scroll={false}
        className="min-h-[360px]"
        title={<ChartTitle symbol={selected} feed={feed} />}
        actions={<ChartControls tf={tf} onTimeframe={onTimeframe} />}
      >
        {feed.candles.length ? (
          <PriceChart candles={feed.candles} symbol={selected} tf={tf} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-600">loading {selected} {tf} candles…</div>
        )}
      </Panel>

      <Panel title="Positions & ledger" icon={<Activity className="h-4 w-4 text-emerald-400" aria-hidden />}>
        <PositionsPanel account={feed.account} trades={feed.trades} onClose={feed.closePos} busySymbol={feed.busySymbol} />
      </Panel>
    </div>
  )
}

function ChartTitle({ symbol, feed }: { symbol: string; feed: EngineFeed }) {
  const row = feed.tickers.find((t) => t.symbol === symbol)
  return (
    <span className="font-mono">
      {symbol}
      {row && (
        <span className={`ml-2 font-sans text-xs ${row.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {row.changePct >= 0 ? '+' : ''}{(row.changePct * 100).toFixed(2)}%
        </span>
      )}
    </span>
  )
}

function ChartControls({ tf, onTimeframe }: { tf: Timeframe; onTimeframe: (tf: Timeframe) => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="hidden items-center gap-2 text-[10px] text-zinc-500 sm:flex">
        <span className="h-0.5 w-3 bg-amber-500" aria-hidden />EMA9
        <span className="h-0.5 w-3 bg-fuchsia-400" aria-hidden />EMA21
      </span>
      <Tabs value={tf} onValueChange={(v) => onTimeframe(v as Timeframe)}>
        <TabsList className="h-7 bg-zinc-900">
          <TabsTrigger value="15m" className="h-5 px-2 text-[11px] data-[state=active]:bg-zinc-800">15m</TabsTrigger>
          <TabsTrigger value="5m" className="h-5 px-2 text-[11px] data-[state=active]:bg-zinc-800">5m</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  )
}

export default TradeView
