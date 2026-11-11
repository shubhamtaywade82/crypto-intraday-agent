// ─── Shared types for the crypto intraday trading engine ────────────────────

export type Side = 'LONG' | 'SHORT'
export type Timeframe = '5m' | '15m'

export interface Candle {
  t: number          // open time (ms)
  o: number
  h: number
  l: number
  c: number
  v: number          // base volume
  q: number          // quote volume
  closed: boolean
}

export interface TickerRow {
  symbol: string
  price: number
  changePct: number       // 24h
  high: number
  low: number
  quoteVolume: number     // 24h quote volume (USDT)
  fundingRate: number     // e.g. 0.0001
  nextFundingMs: number
  oiChangePct: number | null  // last 15m period change %
  spreadPct: number | null    // CoinDCX vs Binance perp premium %
  inrPrice: number | null     // INR reference price
  inrSource: 'coindcx' | 'derived' | null
  signals: SignalSet | null
}

export interface SignalSet {
  momentum: { score: number; dir: -1 | 0 | 1; note: string }     // 15m EMA cross + volume + OI
  meanRev: { score: number; dir: -1 | 0 | 1; note: string }       // 5m RSI(2) + BB
  spread: { score: number; dir: -1 | 0 | 1; note: string }        // cross-exchange / funding
  composite: number                                              // -1..1
}

export interface Position {
  id: string
  symbol: string
  side: Side
  qty: number
  entry: number
  stop: number
  takeProfit: number
  openedAt: number
  confidence: number
  rationale: string
  strategy: string
  riskUsd: number
}

export interface ClosedTrade {
  id: string
  symbol: string
  side: Side
  qty: number
  entry: number
  exit: number
  pnl: number
  fees: number
  openedAt: number
  closedAt: number
  closeReason: 'take-profit' | 'stop-loss' | 'manual' | 'agent-exit' | 'eod'
  rationale: string
  strategy: string
}

export interface LogEntry {
  ts: number
  level: 'info' | 'trade' | 'warn' | 'error' | 'llm'
  tag: string       // SCAN / RISK / AGENT / FILL / ...
  msg: string
}

export interface LlmDecision {
  ts: number
  cycle: number
  candidates: Array<{
    symbol: string
    action: 'BUY' | 'SELL' | 'HOLD'
    confidence: number
    reason: string
  }>
  executed: string[]
  skipped: string[]
  source: 'llm' | 'rules-fallback'
  summary: string
}

export interface EquityPoint { ts: number; equity: number }

export interface EngineStatus {
  running: boolean          // agent loop active
  mode: 'paper'
  cycle: number
  lastScanTs: number | null
  nextScanTs: number | null
  scanIntervalSec: number
  wsConnected: boolean
  binanceRest: 'ok' | 'degraded' | 'down'
  coindcx: 'ok' | 'blocked' | 'down'
  usdtInr: number
  usdtInrSource: string
  symbols: string[]
  startedAt: number
}

export interface RiskState {
  dailyStartEquity: number
  dailyPnl: number
  dailyLossCutoffPct: number
  riskPerTradePct: number
  maxPositions: number
  minConfidence: number
  maxLeverage: number
  cooldownUntil: Record<string, number>
  haltedReason: string | null
}

export interface AccountState {
  balance: number            // free cash USDT
  equity: number             // balance + unrealized
  initialEquity: number
  positions: Position[]
  trades: ClosedTrade[]
  equityCurve: EquityPoint[]
}
