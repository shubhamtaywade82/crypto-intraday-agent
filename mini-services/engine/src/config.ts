// ─── Engine configuration & risk limits ─────────────────────────────────────

export const CONFIG = {
  port: Number(process.env.ENGINE_PORT || process.env.PORT || 3005),

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
  maxPositionAgeMin: 240,       // intraday: force "eod" flatten after 4h

  // Agent cadence
  scanIntervalSec: 60,          // one agent cycle per minute
  symbolsRefreshMin: 5,         // refresh top-10 universe
  symbolUniverseSize: 10,
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
