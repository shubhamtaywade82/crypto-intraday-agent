// ─── Shared types for the crypto intraday trading engine ────────────────────

export type Side = 'LONG' | 'SHORT'
export type Timeframe = '5m' | '15m' | '1h'

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
  // ── derivatives analytics (v2) ──
  lsRatio?: number | null            // global long/short account ratio
  topTraderRatio?: number | null     // top-trader position ratio
  takerRatio?: number | null         // taker buy/sell volume ratio
  liqLongUsd?: number                // liquidated long notional (1h window)
  liqShortUsd?: number               // liquidated short notional (1h window)
  liqCascade?: boolean
  basisPct?: number | null           // perp vs spot reference premium %
}

export interface SignalOut {
  score: number            // -1..1
  dir: -1 | 0 | 1
  note: string
}

export interface SignalSet {
  momentum: SignalOut       // 15m EMA cross + volume + OI
  meanRev: SignalOut        // 5m RSI(2) + BB
  spread: SignalOut         // cross-exchange / funding
  composite: number         // -1..1
  // ── extended v2 families (optional — older clients still work) ──
  liquiditySweep?: SignalOut    // SMC sweep + CHoCH reversal
  squeezeBreakout?: SignalOut   // TTM squeeze fire + volume
  orderBlock?: SignalOut        // OB proximity + premium/discount
  sessionBreakout?: SignalOut   // Asia range break in London/NY
  fundingFlip?: SignalOut       // healthy trend + neutral funding
  cascadeSnapback?: SignalOut   // liquidation cascade exhaustion
  vwapReversion?: SignalOut     // 2σ VWAP stretch fade
  regime?: { label: string; adx: number; bbWidthPctile: number; note: string }
  confluence?: {
    score: number
    dir: -1 | 0 | 1
    agreement: number
    regimeAligned: boolean
    stacks: Array<{ name: string; dir: -1 | 0 | 1; score: number; notes: string[] }>
    setups: Array<{ name: string; class: string; dir: -1 | 0 | 1; strength: number; note: string }>
  }
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
  source: 'llm' | 'llm-debate' | 'rules-fallback'
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
