// Client-side mirror of the engine's types (dashboard consumption)

export type Side = 'LONG' | 'SHORT'

export interface SignalSet {
  momentum: { score: number; dir: -1 | 0 | 1; note: string }
  meanRev: { score: number; dir: -1 | 0 | 1; note: string }
  spread: { score: number; dir: -1 | 0 | 1; note: string }
  composite: number
}

export interface TickerRow {
  symbol: string
  price: number
  changePct: number
  high: number
  low: number
  quoteVolume: number
  fundingRate: number
  nextFundingMs: number
  oiChangePct: number | null
  spreadPct: number | null
  inrPrice: number | null
  inrSource: 'coindcx' | 'derived' | null
  signals: SignalSet | null
}

export interface LivePosition {
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
  mark: number
  unrealized: number
  pnlPct: number
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
  closeReason: string
  rationale: string
  strategy: string
}

export interface AccountSnapshot {
  balance: number
  equity: number
  initialEquity: number
  totalPnl: number
  dailyPnl: number
  dailyStartEquity: number
  positions: LivePosition[]
  tradeCount: number
  winCount: number
  lossCount: number
  equityCurve: Array<{ ts: number; equity: number }>
}

export interface EngineStatus {
  running: boolean
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

export interface LogEntry {
  ts: number
  level: 'info' | 'trade' | 'warn' | 'error' | 'llm'
  tag: string
  msg: string
}

export interface RiskSnapshot {
  dailyStartEquity: number
  dailyPnl: number
  dailyLossCutoffPct: number
  riskPerTradePct: number
  maxPositions: number
  minConfidence: number
  maxLeverage: number
  cooldownUntil: Record<string, number>
  haltedReason: string | null
  cooldownSymbols?: Array<{ symbol: string; minutesLeft: number }>
}

export interface LlmDecision {
  ts: number
  cycle: number
  candidates: Array<{ symbol: string; action: string; confidence: number; reason: string }>
  executed: string[]
  skipped: string[]
  source: 'llm' | 'rules-fallback' | string
  summary: string
}

export interface Snapshot {
  status: EngineStatus
  tickers: TickerRow[]
  account: AccountSnapshot
  logs: LogEntry[]
  decisions: LlmDecision[]
  risk: RiskSnapshot
  telegram?: TelegramSafeConfig
}

// ── Telegram notifier (powered by @nemesis-oss/tg-format) ───────────────────
export type TelegramEvent = 'boot' | 'agent' | 'entry' | 'exit' | 'risk_halt' | 'scan_digest'

export interface TelegramSafeConfig {
  enabled: boolean
  hasToken: boolean
  tokenMasked: string
  chatId: string
  events: Record<TelegramEvent, boolean>
  minIntervalMs: number
}

export interface Candle {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
  q: number
  closed: boolean
}

export const ENGINE_REST = (path: string) => {
  const port = process.env.NEXT_PUBLIC_ENGINE_PORT || '3151'
  return `${path}${path.includes('?') ? '&' : '?'}XTransformPort=${port}`
}
