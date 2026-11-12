// ─── Engine configuration & risk limits ─────────────────────────────────────

export const CONFIG = {
  port: Number(process.env.ENGINE_PORT || process.env.PORT || 3151),

  // Ollama local LLM
  ollamaBase: process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'minicpm5:2b',

  // Paper account
  initialEquity: 10_000,        // USDT virtual capital
  takerFeePct: 0.0005,          // 0.05% taker fee (Binance USDⓈ-M standard tier)
  slippagePct: 0.0002,          // 0.02% simulated slippage

  // Risk limits (full-auto guardrails)
  riskPerTradePct: 0.02,        // max 2% equity risked per trade (stop-distance based)
  dailyLossCutoffPct: 0.03,     // halt new entries after -3% day
  maxPositions: 3,              // max concurrent open positions
  minConfidence: 0.60,          // LLM confidence floor to enter
  maxLeverage: 5,               // notional / equity cap per position
  cooldownAfterLossMin: 30,     // per-symbol cooldown after a stop-out
  atrStopMult: 1.5,             // stop distance = 1.5 × ATR(14)
  tpRewardRisk: 2.0,            // take-profit = 2 × stop distance
  minHoldBeforeReviewMin: 30,   // LLM supervisor may not exit before this; stops/targets decide first
  maxPositionAgeMin: 240,       // intraday: force "eod" flatten after 4h

  // v2 risk extensions
  sizingMode: (process.env.SIZING_MODE as 'fixed-fractional' | 'quarter-kelly' | 'vol-target') || 'fixed-fractional',
  kellyWindow: 50,              // trades used by the live Kelly estimator
  kellyMinTrades: 20,           // below this count, quarter-Kelly falls back
  volTargetAtrPct: 0.004,       // baseline ATR% (0.4%/15m) for vol-target scaling
  maxConsecutiveLosses: 4,      // circuit breaker: halt after N losses in a row
  trailingStopEnabled: true,    // chandelier trailing (checks every 5s heartbeat)
  trailingStopAtrMult: 3.0,     // trail distance = 3 × ATR(14)
  trailBreakevenAtR: 1.0,       // move stop to breakeven once +1R in profit

  // v2 agent architecture
  agentMode: (process.env.AGENT_MODE as 'single' | 'debate') || 'single',  // 'debate' = bull/bear/judge pipeline
  debateTimeoutMs: 90_000,      // whole-debate budget before falling back
  extendedSignals: process.env.EXTENDED_SIGNALS !== '0',   // 10-family + confluence stack

  // v2 derivatives data
  fetchLsRatios: process.env.FETCH_LS_RATIOS !== '0',       // long/short ratio polling
  liquidationWindowMs: 3600_000,                            // rolling liquidation window (1h)
  liquidationBaselineUsd: 250_000,                          // cascade threshold baseline

  // Agent cadence
  scanIntervalSec: 60,          // one agent cycle per minute
  symbolsRefreshMin: 5,         // refresh top-10 universe
  symbolUniverseSize: 10,
  minQuoteVolumeUsd: 100_000_000, // liquid majors only; thin coins gap through stops
  maxAbsChangePct: 8,           // skip coins already in a 24h news-driven move
  alwaysInclude: ['BTCUSDT', 'ETHUSDT'],
  klinesBootstrap: 220,         // candles of history per timeframe
  compositeThreshold: 0.25,     // min |composite| to become an LLM candidate
  maxLlmCandidates: 4,          // candidates per LLM call

  // Data sources
  binanceRestBase: 'https://fapi.binance.com',
  binanceSpotFallbackBase: 'https://data-api.binance.vision', // public mirror, softer limits
  binanceWsBase: 'wss://fstream.binance.com/market/stream',
  coindcxBases: ['https://api.coindcx.com', 'https://public.coindcx.com'],
  coingeckoSimple: 'https://api.coingecko.com/api/v3/simple/price',
  restRetries: 3,
  restBackoffMs: 1500,

  // Persistence
  dataDir: 'mini-services/engine/data',
} as const
