'use client'

// Realtime + REST wiring for the dashboard. socket.io (engine :3152) pushes
// state; REST (engine :3151) bootstraps and runs commands.

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { io, type Socket } from 'socket.io-client'
import { toast } from '@/hooks/use-toast'
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
  type TelegramSafeConfig,
  type TickerRow,
} from '@/lib/engine-types'

export type Timeframe = '15m' | '5m'

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

interface Setters {
  setStatus: Dispatch<SetStateAction<EngineStatus>>
  setTickers: Dispatch<SetStateAction<TickerRow[]>>
  setAccount: Dispatch<SetStateAction<AccountSnapshot>>
  setRisk: Dispatch<SetStateAction<RiskSnapshot>>
  setLogs: Dispatch<SetStateAction<LogEntry[]>>
  setDecisions: Dispatch<SetStateAction<LlmDecision[]>>
  setTelegram: Dispatch<SetStateAction<TelegramSafeConfig | undefined>>
}

function applySnapshot(snap: Partial<Snapshot>, s: Setters) {
  if (snap.status) s.setStatus(snap.status)
  if (Array.isArray(snap.tickers)) s.setTickers(snap.tickers)
  if (snap.account) s.setAccount(snap.account)
  if (snap.risk) s.setRisk(snap.risk)
  if (Array.isArray(snap.logs)) s.setLogs(snap.logs)
  if (Array.isArray(snap.decisions)) s.setDecisions(snap.decisions)
  if (snap.telegram) s.setTelegram(snap.telegram)
}

function socketUrl() {
  const wsPort = process.env.NEXT_PUBLIC_WS_PORT || '3152'
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  return isLocalhost ? `http://${window.location.hostname}:${wsPort}` : `/?XTransformPort=${wsPort}`
}

function bindSocket(socket: Socket, s: Setters, setConnected: (v: boolean) => void) {
  socket.on('connect', () => setConnected(true))
  socket.on('disconnect', () => setConnected(false))
  socket.on('snapshot', (snap: Snapshot) => applySnapshot(snap, s))
  socket.on('status', (st: EngineStatus) => s.setStatus(st))
  // the engine nudges clients after a telegram config change; refresh that slice
  socket.on('status', async () => {
    try {
      const t = await fetch(ENGINE_REST('/engine/telegram/config')).then((r) => r.json())
      if (t) s.setTelegram(t)
    } catch { /* ignore */ }
  })
  socket.on('tickers', (rows: TickerRow[]) => {
    if (Array.isArray(rows) && rows.length) s.setTickers(rows)
  })
  socket.on('account', (acc: AccountSnapshot) => { if (acc) s.setAccount(acc) })
  socket.on('log', (entry: LogEntry) => {
    if (entry) s.setLogs((prev) => [...prev.slice(-400), entry])
  })
}

function bindKlines(socket: Socket, setCandles: Dispatch<SetStateAction<Candle[]>>, current: { symbol: () => string; tf: () => Timeframe }) {
  socket.on('kline', (k: { symbol: string; interval: string; candle: Candle }) => {
    if (k.symbol !== current.symbol() || k.interval !== current.tf()) return
    setCandles((prev) => {
      if (!prev.length) return [k.candle]
      const last = prev[prev.length - 1]
      if (k.candle.t === last.t) return [...prev.slice(0, -1), k.candle]
      if (k.candle.t > last.t) return [...prev.slice(-299), k.candle]
      return prev
    })
  })
}

export function useEngineFeed(selected: string, tf: Timeframe) {
  const [status, setStatus] = useState<EngineStatus>(EMPTY_STATUS)
  const [tickers, setTickers] = useState<TickerRow[]>([])
  const [account, setAccount] = useState<AccountSnapshot>(EMPTY_ACCOUNT)
  const [risk, setRisk] = useState<RiskSnapshot>(EMPTY_RISK)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [decisions, setDecisions] = useState<LlmDecision[]>([])
  const [trades, setTrades] = useState<ClosedTrade[]>([])
  const [telegram, setTelegram] = useState<TelegramSafeConfig | undefined>(undefined)
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
      const h = await fetch(ENGINE_REST('/engine/history')).then((r) => r.json())
      if (Array.isArray(h.trades)) setTrades(h.trades)
      if (Array.isArray(h.decisions)) setDecisions(h.decisions)
    } catch { /* engine briefly away */ }
  }, [])

  const loadChart = useCallback(async (symbol: string, timeframe: Timeframe) => {
    try {
      const r = await fetch(ENGINE_REST(`/engine/klines?symbol=${symbol}&tf=${timeframe}&limit=200`)).then((x) => x.json())
      if (Array.isArray(r.candles)) setCandles(r.candles)
    } catch { /* keep old candles */ }
  }, [])

  useEffect(() => {
    const setters: Setters = { setStatus, setTickers, setAccount, setRisk, setLogs, setDecisions, setTelegram }
    const socket = io(socketUrl(), {
      path: '/', transports: ['websocket', 'polling'], reconnection: true,
      reconnectionAttempts: 20, reconnectionDelay: 1_500, timeout: 10_000,
    })
    socketRef.current = socket
    bindSocket(socket, setters, setConnected)
    bindKlines(socket, setCandles, { symbol: () => selectedRef.current, tf: () => tfRef.current })

    ;(async () => {
      try {
        const snap = await fetch(ENGINE_REST('/engine/snapshot')).then((r) => r.json())
        applySnapshot(snap, setters)
      } catch {
        toast({ title: 'Engine offline', description: 'Start it with: bun run dev inside mini-services/engine', variant: 'destructive' })
      }
      loadHistory()
    })()

    return () => { socket.close(); socketRef.current = null }
  }, [loadHistory])

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
      else toast({ title: 'Close failed', description: r.detail, variant: 'destructive' })
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

  return {
    status, tickers, account, risk, logs, decisions, trades, telegram, candles,
    connected, scanning, busySymbol,
    runScan, toggleAgent, closePos, resetAccount,
  }
}

export type EngineFeed = ReturnType<typeof useEngineFeed>
