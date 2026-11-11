'use client'

// ─── Crypto Futures Intraday Agent — dashboard ──────────────────────────────
// Realtime view of the trading engine: market watch, candlestick chart,
// agentic-AI activity, paper positions, risk guardrails and decision journal.
// Data: socket.io (engine :3002) + REST (engine :3001) through the gateway.

import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/hooks/use-toast'
import { Activity, Bot, Gauge, LineChart, Play, RotateCcw, ScanLine, Square, Zap } from 'lucide-react'
import MarketTable from '@/components/dashboard/market-table'
import PriceChart from '@/components/dashboard/price-chart'
import AgentFeed from '@/components/dashboard/agent-feed'
import PositionsPanel from '@/components/dashboard/positions-panel'
import { RiskPanel, DecisionJournal } from '@/components/dashboard/risk-panel'
import {
  ENGINE_REST,
  type AccountSnapshot,
  type Candle,
  type ClosedTrade,
  type EngineStatus,
  type LlmDecision,
  type LogEntry,
  type RiskSnapshot,
  type Snapshot,
  type TickerRow,
} from '@/lib/engine-types'

const EMPTY_ACCOUNT: AccountSnapshot = {
  balance: 10_000, equity: 10_000, initialEquity: 10_000, totalPnl: 0, dailyPnl: 0, dailyStartEquity: 10_000,
  positions: [], tradeCount: 0, winCount: 0, lossCount: 0, equityCurve: [],
}

const EMPTY_STATUS: EngineStatus = {
  running: false, mode: 'paper', cycle: 0, lastScanTs: null, nextScanTs: null, scanIntervalSec: 60,
  wsConnected: false, binanceRest: 'ok', coindcx: 'down', usdtInr: 0, usdtInrSource: '', symbols: [], startedAt: 0,
}

const EMPTY_RISK: RiskSnapshot = {
  dailyStartEquity: 10_000, dailyPnl: 0, dailyLossCutoffPct: 0.03, riskPerTradePct: 0.02,
  maxPositions: 3, minConfidence: 0.6, maxLeverage: 5, cooldownUntil: {}, haltedReason: null,
}

function StatusDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  const cls = ok ? 'bg-emerald-400' : warn ? 'bg-amber-400' : 'bg-red-400'
  return <span className={`inline-block h-2 w-2 rounded-full ${cls}`} aria-hidden />
}

function KpiCard({ label, value, sub, tone = 'neutral', icon }: {
  label: string
  value: string
  sub?: string
  tone?: 'neutral' | 'up' | 'down'
  icon?: React.ReactNode
}) {
  const toneCls = tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-red-400' : 'text-white'
  return (
    <Card className="border-zinc-800 bg-zinc-950/70 py-0 gap-0">
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-center justify-between">
          <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
          {icon && <span className="text-zinc-600">{icon}</span>}
        </div>
        <p className={`mt-1 font-mono text-lg sm:text-xl font-semibold ${toneCls}`}>{value}</p>
        {sub && <p className="text-[11px] text-zinc-500 mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  )
}

export default function Dashboard() {
  const [status, setStatus] = useState<EngineStatus>(EMPTY_STATUS)
  const [tickers, setTickers] = useState<TickerRow[]>([])
  const [account, setAccount] = useState<AccountSnapshot>(EMPTY_ACCOUNT)
  const [risk, setRisk] = useState<RiskSnapshot>(EMPTY_RISK)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [decisions, setDecisions] = useState<LlmDecision[]>([])
  const [trades, setTrades] = useState<ClosedTrade[]>([])
  const [selected, setSelected] = useState('BTCUSDT')
  const [tf, setTf] = useState<'15m' | '5m'>('15m')
  const [candles, setCandles] = useState<Candle[]>([])
  const [scanning, setScanning] = useState(false)
  const [busySymbol, setBusySymbol] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const socketRef = useRef<Socket | null>(null)
  const selectedRef = useRef(selected)
  const tfRef = useRef(tf)
  selectedRef.current = selected
  tfRef.current = tf

  const loadHistory = useCallback(async () => {
    try {
      const h = await fetch(ENGINE_REST(`/engine/history`)).then((r) => r.json())
      if (Array.isArray(h.trades)) setTrades(h.trades)
      if (Array.isArray(h.decisions)) setDecisions(h.decisions)
    } catch { /* engine briefly away */ }
  }, [])

  const loadChart = useCallback(async (symbol: string, timeframe: '15m' | '5m') => {
    try {
      const r = await fetch(ENGINE_REST(`/engine/klines?symbol=${symbol}&tf=${timeframe}&limit=200`)).then((x) => x.json())
      if (Array.isArray(r.candles)) setCandles(r.candles)
    } catch { /* keep old candles */ }
  }, [])

  // ── realtime wiring ──────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io('/?XTransformPort=3002', {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1_500,
      timeout: 10_000,
    })
    socketRef.current = socket

    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))

    socket.on('snapshot', (snap: Snapshot) => {
      if (snap.status) setStatus(snap.status)
      if (Array.isArray(snap.tickers)) setTickers(snap.tickers)
      if (snap.account) setAccount(snap.account)
      if (snap.risk) setRisk(snap.risk)
      if (Array.isArray(snap.logs)) setLogs(snap.logs)
      if (Array.isArray(snap.decisions)) setDecisions(snap.decisions)
    })
    socket.on('status', (st: EngineStatus) => setStatus(st))
    socket.on('tickers', (rows: TickerRow[]) => {
      if (Array.isArray(rows) && rows.length) setTickers(rows)
    })
    socket.on('account', (acc: AccountSnapshot) => {
      if (acc) setAccount(acc)
    })
    socket.on('log', (entry: LogEntry) => {
      if (entry) setLogs((prev) => [...prev.slice(-400), entry])
    })
    socket.on('kline', (k: { symbol: string; interval: string; candle: Candle }) => {
      if (k.symbol !== selectedRef.current || k.interval !== tfRef.current) return
      setCandles((prev) => {
        if (!prev.length) return [k.candle]
        const last = prev[prev.length - 1]
        if (k.candle.t === last.t) return [...prev.slice(0, -1), k.candle]
        if (k.candle.t > last.t) return [...prev.slice(-299), k.candle]
        return prev
      })
    })

    // initial REST bootstrap
    ;(async () => {
      try {
        const snap = await fetch(ENGINE_REST('/engine/snapshot')).then((r) => r.json())
        if (snap.status) setStatus(snap.status)
        if (Array.isArray(snap.tickers)) setTickers(snap.tickers)
        if (snap.account) setAccount(snap.account)
        if (snap.risk) setRisk(snap.risk)
        if (Array.isArray(snap.logs)) setLogs(snap.logs)
        if (Array.isArray(snap.decisions)) setDecisions(snap.decisions)
      } catch {
        toast({ title: 'Engine offline', description: 'Start it with: bun run dev inside mini-services/engine', variant: 'destructive' })
      }
      loadHistory()
    })()

    return () => { socket.close(); socketRef.current = null }
  }, [loadHistory])

  // chart subscription follows selection
  useEffect(() => {
    loadChart(selected, tf)
    socketRef.current?.emit('subscribe:chart', { symbol: selected, tf })
  }, [selected, tf, loadChart])

  const runScan = async () => {
    setScanning(true)
    try {
      const r = await fetch(ENGINE_REST('/engine/scan'), { method: 'POST' }).then((x) => x.json())
      toast({
        title: `Cycle #${r.cycle} complete — ${r.source === 'llm' ? 'LLM confluence' : 'rule fallback'}`,
        description: r.verdicts?.length
          ? r.verdicts.map((v: any) => `${v.symbol}: ${v.action} (${(v.confidence * 100).toFixed(0)}%)`).join(' · ')
          : 'no candidates passed the pre-filter',
      })
      await loadHistory()
    } catch {
      toast({ title: 'Scan failed', description: 'Engine unreachable', variant: 'destructive' })
    } finally {
      setScanning(false)
    }
  }

  const toggleAgent = async () => {
    try {
      const path = status.running ? '/engine/agent/stop' : '/engine/agent/start'
      await fetch(ENGINE_REST(path), { method: 'POST' })
      setStatus((s) => ({ ...s, running: !s.running }))
      toast({ title: status.running ? 'Agent loop stopped' : 'Agent loop started', description: status.running ? 'Open positions keep their TP/SL brackets' : 'Full-auto paper trading within risk limits' })
    } catch {
      toast({ title: 'Engine unreachable', variant: 'destructive' })
    }
  }

  const closePos = async (symbol: string) => {
    setBusySymbol(symbol)
    try {
      const r = await fetch(ENGINE_REST(`/engine/close/${encodeURIComponent(symbol)}`), { method: 'POST' }).then((x) => x.json())
      if (r.ok) toast({ title: `Closed ${symbol}`, description: r.detail })
      else toast({ title: `Close failed`, description: r.detail, variant: 'destructive' })
      await loadHistory()
    } catch {
      toast({ title: 'Engine unreachable', variant: 'destructive' })
    } finally {
      setBusySymbol(null)
    }
  }

  const resetAccount = async () => {
    try {
      const r = await fetch(ENGINE_REST('/engine/reset'), { method: 'POST' }).then((x) => x.json())
      toast({ title: 'Paper account reset', description: r.detail })
      await loadHistory()
    } catch {
      toast({ title: 'Engine unreachable', variant: 'destructive' })
    }
  }

  const winRate = account.tradeCount ? (account.winCount / account.tradeCount) * 100 : 0
  const positionSymbols = new Set(account.positions.map((p) => p.symbol))
  const selRow = tickers.find((t) => t.symbol === selected)

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100">
      {/* header */}
      <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:px-5">
          <h1 className="flex items-center gap-2 text-sm font-semibold tracking-tight sm:text-base">
            <Bot className="h-5 w-5 text-emerald-400" aria-hidden />
            Crypto Intraday Agent
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-400 font-mono text-[10px]">
              PAPER · BINANCE USDT-M + COINDCX
            </Badge>
          </h1>
          <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
            <span className="flex items-center gap-1.5" title="Engine realtime link"><StatusDot ok={connected} /> live</span>
            <span className="flex items-center gap-1.5" title="Binance WebSocket"><StatusDot ok={status.wsConnected} /> ws</span>
            <span className="hidden sm:flex items-center gap-1.5" title="Binance REST health">
              <StatusDot ok={status.binanceRest === 'ok'} warn={status.binanceRest === 'degraded'} /> rest
            </span>
            <span className="hidden sm:flex items-center gap-1.5" title={`CoinDCX: ${status.coindcx}`}>
              <StatusDot ok={status.coindcx === 'ok'} warn={status.coindcx !== 'ok'} /> coindcx
            </span>
            <span className="hidden md:inline font-mono text-zinc-500">USDT/INR {status.usdtInr || '—'}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={runScan}
              disabled={scanning}
              className="h-8 border-zinc-700 text-zinc-200 hover:bg-zinc-800 hover:text-emerald-300 min-w-[44px]"
            >
              <ScanLine className="h-3.5 w-3.5" aria-hidden />
              <span className="ml-1.5 hidden sm:inline">{scanning ? 'Scanning…' : 'Scan now'}</span>
            </Button>
            <Button
              size="sm"
              variant={status.running ? 'destructive' : 'default'}
              onClick={toggleAgent}
              className={`h-8 min-w-[44px] ${status.running ? '' : 'bg-emerald-600 hover:bg-emerald-500'}`}
            >
              {status.running ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
              <span className="ml-1.5">{status.running ? 'Stop agent' : 'Start agent'}</span>
            </Button>
          </div>
        </div>
      </header>

      {/* KPI strip */}
      <section aria-label="account summary" className="mx-auto w-full max-w-[1600px] px-3 pt-3 sm:px-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <KpiCard label="Equity" value={`${account.equity.toFixed(2)}`} sub="USDT · paper" icon={<Gauge className="h-3.5 w-3.5" />} />
          <KpiCard label="Daily PnL" value={`${account.dailyPnl >= 0 ? '+' : ''}${account.dailyPnl.toFixed(2)}`} tone={account.dailyPnl >= 0 ? 'up' : 'down'} sub="USDT since UTC 00:00" icon={<Zap className="h-3.5 w-3.5" />} />
          <KpiCard label="Total PnL" value={`${account.totalPnl >= 0 ? '+' : ''}${account.totalPnl.toFixed(2)}`} tone={account.totalPnl >= 0 ? 'up' : 'down'} sub={`vs ${account.initialEquity.toLocaleString()} start`} />
          <KpiCard label="Open positions" value={`${account.positions.length}/${risk.maxPositions}`} sub={`${positionSymbols.size} symbols`} icon={<Activity className="h-3.5 w-3.5" />} />
          <KpiCard label="Win rate" value={`${winRate.toFixed(0)}%`} sub={`${account.winCount}W / ${account.lossCount}L`} />
          <KpiCard label="Agent cycle" value={`#${status.cycle}`} sub={status.running ? `every ${status.scanIntervalSec}s · auto` : 'stopped'} tone="neutral" icon={<Bot className="h-3.5 w-3.5" />} />
        </div>
      </section>

      {/* main grid */}
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-3 py-3 sm:px-5">
        <div className="grid gap-3 lg:grid-cols-3">
          {/* left: market + chart */}
          <div className="space-y-3 lg:col-span-2">
            <Card className="border-zinc-800 bg-zinc-950/70 py-0 gap-0">
              <CardHeader className="border-b border-zinc-800/70 py-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    <LineChart className="h-4 w-4 text-zinc-500" aria-hidden />
                    Market watch — top {tickers.length || 10} USDT-M perps
                  </CardTitle>
                  <span className="text-[10px] text-zinc-600">click a row to chart it</span>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <MarketTable rows={tickers} selected={selected} onSelect={setSelected} positionSymbols={positionSymbols} />
              </CardContent>
            </Card>

            <Card className="border-zinc-800 bg-zinc-950/70 py-0 gap-0">
              <CardHeader className="border-b border-zinc-800/70 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="font-mono text-sm font-medium text-zinc-200">
                    {selected}
                    {selRow && (
                      <span className={`ml-2 font-sans text-xs ${selRow.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {selRow.changePct >= 0 ? '+' : ''}{(selRow.changePct * 100).toFixed(2)}%
                      </span>
                    )}
                  </CardTitle>
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-3 text-[10px] text-zinc-500">
                      <span className="flex items-center gap-1"><span className="h-0.5 w-3 bg-amber-500" aria-hidden />EMA9</span>
                      <span className="flex items-center gap-1"><span className="h-0.5 w-3 bg-fuchsia-400" aria-hidden />EMA21</span>
                    </span>
                    <Tabs value={tf} onValueChange={(v) => setTf(v as '15m' | '5m')}>
                      <TabsList className="h-7 bg-zinc-900">
                        <TabsTrigger value="15m" className="h-5 px-2 text-[11px] data-[state=active]:bg-zinc-800">15m</TabsTrigger>
                        <TabsTrigger value="5m" className="h-5 px-2 text-[11px] data-[state=active]:bg-zinc-800">5m</TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-2">
                {candles.length ? (
                  <PriceChart candles={candles} symbol={selected} tf={tf} />
                ) : (
                  <div className="flex h-[340px] items-center justify-center text-sm text-zinc-600 sm:h-[400px]">
                    loading {selected} {tf} candles…
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* right: agent feed */}
          <Card className="border-zinc-800 bg-zinc-950/70 py-0 gap-0 self-start">
            <CardHeader className="border-b border-zinc-800/70 py-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                <Activity className="h-4 w-4 text-emerald-400" aria-hidden />
                Agent activity
                <span className={`ml-auto text-[10px] font-mono ${status.running ? 'text-emerald-400' : 'text-zinc-500'}`}>
                  {status.running ? '● AUTO' : '○ IDLE'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-2">
              <AgentFeed logs={logs.slice(-160)} />
            </CardContent>
          </Card>
        </div>

        {/* bottom grid */}
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          <Card className="border-zinc-800 bg-zinc-950/70 py-0 gap-0 lg:col-span-2 self-start">
            <CardHeader className="border-b border-zinc-800/70 py-3">
              <CardTitle className="text-sm font-medium text-zinc-200">Positions & history</CardTitle>
            </CardHeader>
            <CardContent className="p-3">
              <PositionsPanel account={account} trades={trades} onClose={closePos} busySymbol={busySymbol} />
            </CardContent>
          </Card>

          <div className="space-y-3">
            <Card className="border-zinc-800 bg-zinc-950/70 py-0 gap-0">
              <CardHeader className="border-b border-zinc-800/70 py-3">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                  <Gauge className="h-4 w-4 text-amber-400" aria-hidden />
                  Risk guardrails
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3">
                <RiskPanel risk={risk} account={account} />
                <Separator className="my-3 bg-zinc-800" />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={resetAccount}
                  className="h-7 w-full border-zinc-700 text-[11px] text-zinc-400 hover:bg-zinc-800"
                >
                  <RotateCcw className="mr-1.5 h-3 w-3" aria-hidden />
                  Reset paper account
                </Button>
              </CardContent>
            </Card>

            <Card className="border-zinc-800 bg-zinc-950/70 py-0 gap-0">
              <CardHeader className="border-b border-zinc-800/70 py-3">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                  <Bot className="h-4 w-4 text-fuchsia-400" aria-hidden />
                  Decision journal
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3">
                <DecisionJournal decisions={decisions} />
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      {/* sticky footer */}
      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-[10px] text-zinc-600 sm:px-5">
          <span>Paper trading only — simulated fills at live Binance USDⓈ-M prices (0.05% fee + 0.02% slippage).</span>
          <span className="hidden sm:inline">Strategies: momentum breakout · mean reversion · cross-exchange spread · LLM confluence.</span>
          <span className="ml-auto font-mono">{status.symbols.length} symbols · cycle #{status.cycle}</span>
        </div>
      </footer>
    </div>
  )
}
