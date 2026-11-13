'use client'

// ─── Crypto Intraday Agent — dashboard shell ────────────────────────────────
// One viewport, four tabs. Data comes from useEngineFeed; UI memory from usePersistentState.

import { Activity, Bot, Gauge, Play, ScanLine, Square, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TradeView } from '@/components/dashboard/views/trade-view'
import { AgentView } from '@/components/dashboard/views/agent-view'
import { RiskView } from '@/components/dashboard/views/risk-view'
import { SettingsView } from '@/components/dashboard/views/settings-view'
import { useEngineFeed, type Timeframe } from '@/hooks/use-engine-feed'
import { usePersistentState, clearPersistentState } from '@/hooks/use-persistent-state'

const KEYS = { view: 'cia.view', symbol: 'cia.symbol', tf: 'cia.tf', restoreView: 'cia.restoreView' }
const DEFAULT_SYMBOL = 'BTCUSDT'
const VIEWS = [
  { id: 'trade', label: 'Trade' },
  { id: 'agent', label: 'Agent' },
  { id: 'risk', label: 'Risk & account' },
  { id: 'settings', label: 'Settings' },
] as const
type ViewId = (typeof VIEWS)[number]['id']

function StatusDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  const cls = ok ? 'bg-emerald-400' : warn ? 'bg-amber-400' : 'bg-red-400'
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} aria-hidden />
}

function Kpi({ label, value, sub, tone = 'neutral', icon }: {
  label: string; value: string; sub?: string; tone?: 'neutral' | 'up' | 'down'; icon?: React.ReactNode
}) {
  const toneCls = tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-red-400' : 'text-zinc-100'
  return (
    <div className="min-w-0 rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
        {icon && <span className="text-zinc-600">{icon}</span>}
      </div>
      <p className={`truncate font-mono text-base font-semibold leading-tight ${toneCls}`}>{value}</p>
      {sub && <p className="truncate text-[10px] text-zinc-500">{sub}</p>}
    </div>
  )
}

export default function Dashboard() {
  const [restoreView, setRestoreView] = usePersistentState(KEYS.restoreView, true)
  const [storedView, setStoredView] = usePersistentState<ViewId>(KEYS.view, 'trade')
  const [selected, setSelected] = usePersistentState(KEYS.symbol, DEFAULT_SYMBOL)
  const [tf, setTf] = usePersistentState<Timeframe>(KEYS.tf, '15m')
  const view = restoreView ? storedView : 'trade'
  const feed = useEngineFeed(selected, tf)
  const { status, account, risk } = feed

  const resetPreferences = () => {
    clearPersistentState(Object.values(KEYS))
    setRestoreView(true)
    setStoredView('trade')
    setSelected(DEFAULT_SYMBOL)
    setTf('15m')
  }

  const winRate = account.tradeCount ? (account.winCount / account.tradeCount) * 100 : 0
  const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-950 text-zinc-100 lg:h-dvh lg:overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 px-3">
        <h1 className="flex min-w-0 items-center gap-2 text-sm font-semibold tracking-tight">
          <Bot className="h-5 w-5 shrink-0 text-emerald-400" aria-hidden />
          <span className="truncate">Crypto Intraday Agent</span>
        </h1>
        <Badge variant="outline" title="Simulated fills at live Binance USDⓈ-M prices (0.05% fee + 0.02% slippage)" className="hidden border-amber-500/40 bg-amber-500/10 font-mono text-[10px] text-amber-400 md:inline-flex">
          PAPER
        </Badge>
        <div className="ml-auto hidden items-center gap-3 text-[11px] text-zinc-400 xl:flex">
          <span className="flex items-center gap-1.5"><StatusDot ok={feed.connected} /> live</span>
          <span className="flex items-center gap-1.5"><StatusDot ok={status.wsConnected} /> ws</span>
          <span className="flex items-center gap-1.5"><StatusDot ok={status.binanceRest === 'ok'} warn={status.binanceRest === 'degraded'} /> rest</span>
          <span className="flex items-center gap-1.5"><StatusDot ok={status.coindcx === 'ok'} warn={status.coindcx !== 'ok'} /> coindcx</span>
          <span className="font-mono text-zinc-500">USDT/INR {status.usdtInr || '—'}</span>
        </div>
        <div className="ml-auto flex items-center gap-2 xl:ml-0">
          <Button size="sm" variant="outline" onClick={feed.runScan} disabled={feed.scanning} className="h-8 border-zinc-700 text-zinc-200 hover:bg-zinc-800 hover:text-emerald-300">
            <ScanLine className="h-3.5 w-3.5" aria-hidden />
            <span className="ml-1.5 hidden sm:inline">{feed.scanning ? 'Scanning…' : 'Scan now'}</span>
          </Button>
          <Button size="sm" variant={status.running ? 'destructive' : 'default'} onClick={feed.toggleAgent} className={`h-8 ${status.running ? '' : 'bg-emerald-600 hover:bg-emerald-500'}`}>
            {status.running ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
            <span className="ml-1.5">{status.running ? 'Stop' : 'Start'}</span>
          </Button>
        </div>
      </header>

      <div aria-label="account summary" className="grid shrink-0 grid-cols-2 gap-2 border-b border-zinc-800 px-3 py-2 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Equity" value={account.equity.toFixed(2)} sub="USDT · paper" icon={<Gauge className="h-3 w-3" />} />
        <Kpi label="Daily PnL" value={signed(account.dailyPnl)} tone={account.dailyPnl >= 0 ? 'up' : 'down'} sub="since UTC 00:00" icon={<Zap className="h-3 w-3" />} />
        <Kpi label="Total PnL" value={signed(account.totalPnl)} tone={account.totalPnl >= 0 ? 'up' : 'down'} sub={`vs ${account.initialEquity.toLocaleString()} start`} />
        <Kpi label="Open positions" value={`${account.positions.length}/${risk.maxPositions}`} sub={`${new Set(account.positions.map((p) => p.symbol)).size} symbols`} icon={<Activity className="h-3 w-3" />} />
        <Kpi label="Win rate" value={`${winRate.toFixed(0)}%`} sub={`${account.winCount}W / ${account.lossCount}L`} />
        <Kpi label="Agent cycle" value={`#${status.cycle}`} sub={status.running ? `every ${status.scanIntervalSec}s · auto` : 'stopped'} icon={<Bot className="h-3 w-3" />} />
      </div>

      <nav aria-label="Dashboard sections" className="flex h-10 shrink-0 items-center border-b border-zinc-800 px-3">
        <Tabs value={view} onValueChange={(v) => setStoredView(v as ViewId)}>
          <TabsList className="h-8 bg-zinc-900">
            {VIEWS.map((v) => (
              <TabsTrigger key={v.id} value={v.id} className="h-6 px-3 text-xs data-[state=active]:bg-zinc-800 data-[state=active]:text-white">
                {v.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </nav>

      <main className="min-h-0 flex-1 p-2 lg:overflow-hidden">
        {view === 'trade' && <TradeView feed={feed} selected={selected} tf={tf} onSelect={setSelected} onTimeframe={setTf} />}
        {view === 'agent' && <AgentView feed={feed} />}
        {view === 'risk' && <RiskView feed={feed} />}
        {view === 'settings' && (
          <SettingsView feed={feed} restoreLastView={restoreView} onRestoreLastView={setRestoreView} onResetPreferences={resetPreferences} />
        )}
      </main>
    </div>
  )
}
