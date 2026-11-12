# Intraday Playbook — Signals, Confluence & the Agentic Stack

The complete reference for everything the engine computes. This is the "what and why" behind every number the agent sees; the "where" is `mini-services/engine/src/`.

---

## 1. The signal taxonomy

### 1.1 Technical indicators (`src/indicators.ts`)

| Category | Indicators |
|---|---|
| **Trend** | EMA (9/21/50/200), SMA, WMA, Hull MA, VWAP + 1σ bands (rolling, volume-weighted), SuperTrend (10, 3), Ichimoku (cloud position), ADX/DMI (trend strength filter), Parabolic SAR |
| **Momentum** | RSI(2) & RSI(14) with regular + hidden divergence, MACD (hist + slope), Stochastic, StochRSI, CCI, Williams %R, ROC, TSI, Awesome Oscillator |
| **Volatility** | ATR(14), Bollinger Bands (width, %B, bandwidth percentile), Keltner Channels, Donchian Channels, TTM squeeze (BB-inside-KC + fire direction) |
| **Volume / order-flow proxy** | OBV (slope), MFI, CMF, volume expansion ratio, approx volume-delta (close position in bar range), CVD slope |
| **Statistics** | z-score, percentile rank, linear-regression slope, median, stdev |

Divergence detection finds the last two fractal pivot pairs and classifies regular/hidden bull/bear divergence between price and any oscillator.

### 1.2 Market structure & SMC/ICT (`src/structure.ts`)

- **Swings & structure** — fractal pivots (2-2), HH/HL/LH/LL labelling, structural trend
- **BOS / CHoCH** — break of structure (continuation) vs change of character (first reversal tell)
- **Order blocks** — last opposing candle before a displacement leg (body ≥ 1.6× average), mitigation tracking, nearest-OB distance
- **Fair value gaps** — 3-candle imbalances, filled/unfilled tracking (unfilled gaps act as magnets)
- **Liquidity** — equal highs/lows (EQH/EQL clusters within 0.25×ATR), liquidity sweeps / stop hunts (wick through a level, close back inside), Wyckoff-lite spring / upthrust
- **Premium/discount** — dealing range, equilibrium (50%), OTE zones (62–79% retracement)
- **Sessions (UTC)** — Asia 00–08 (accumulation) → London 07–16, kill zone 07–10 (manipulation) → NY 12–21, kill zone 12–15 (distribution); Asia-range construction for London breakout reference
- **Candlestick patterns** — engulfing, pin bars, doji, inside bars, morning/evening stars

### 1.3 Perpetual-futures derivatives (`src/derivatives.ts`)

The crypto-native edge layer:

- **Funding regime** — current rate z-scored + percentile-ranked against settled history (8h cadence); labels: extreme-positive / rich / neutral / cheap / extreme-negative with contrarian direction
- **OI/price quadrant** — `price↑+OI↑` new longs (healthy trend), `price↓+OI↑` new shorts, `price↑+OI↓` short squeeze (fuel depleting), `price↓+OI↓` long unwind (capitulation)
- **Long/short ratios** — global accounts, top-trader positions, taker buy/sell; crowd positioning is contrarian at extremes (crowded-long ↔ fade longs)
- **Liquidations** — rolling 1h window from the `!forceOrder@arr` all-market stream; one-sided clusters above baseline = cascade signature → snapback bias opposite the wiped side
- **Basis** — perp vs spot reference premium (rich/warm/neutral/soft/discount)

---

## 2. The ten strategy families (`src/strategies.ts`)

Every family emits `{score ∈ [-1,1], dir ∈ {-1,0,1}, note}`:

| # | Family | Core logic |
|---|---|---|
| 1 | `momentum` | 15m EMA9/21 alignment + fresh cross + volume expansion + OI drift |
| 2 | `meanRev` | 5m RSI(2) <10/>90 + Bollinger pierce, volatility floor |
| 3 | `spread` | funding crowding + Binance-vs-CoinDCX premium (cross-exchange sentiment) |
| 4 | `liquiditySweep` | sweep of EQH/EQL or swing + CHoCH confirmation (+ Wyckoff spring/upthrust bonus), freshness decay |
| 5 | `squeezeBreakout` | TTM squeeze fires with volume expansion + OI confirmation |
| 6 | `orderBlock` | price taps a fresh (unmitigated) OB, boosted in discount/premium alignment, FVG/candle confluence |
| 7 | `sessionBreakout` | Asia-range break during London/NY with volume + OI; failed breaks flip to fade |
| 8 | `fundingFlip` | healthy trend (SuperTrend + MACD agree) while funding is neutral/cheap — continuation room |
| 9 | `cascadeSnapback` | liquidation cascade + BOS reclaim + reversal candle + OI reset |
| 10 | `vwapReversion` | ±1.8σ stretch from rolling VWAP with RSI agreement → fade to VWAP |

---

## 3. The confluence engine (`src/confluence.ts`)

### 3.1 Regime gate (HMM-lite)

`detectRegime` classifies 15m data into **trend-up / trend-down / range / volatile / quiet** using ADX (≥25 = trending), BB-width percentile (<0.25 = quiet, >0.85 = volatile), and EMA50 slope for direction. Each regime permits only matching setup classes — mean-reversion never fires in a strong trend, breakout setups require expansion states.

### 3.2 Five-stack voting

| Stack | Voters |
|---|---|
| **trend** | EMA9/21, EMA21/50, SuperTrend, VWAP position ±1σ, 1h EMA50 (HTF bias) |
| **momentum** | RSI(14) zones, MACD hist + slope, Stochastic extremes, RSI divergences |
| **volume** | OBV slope, MFI, CVD slope, volume expansion |
| **derivatives** | funding regime (contrarian), OI quadrant, L/S ratios (contrarian), liquidation cascade, basis |
| **structure** | structural trend, BOS/CHoCH, sweeps, OB/FVG proximity, Wyckoff, delta pressure |

The composite = `0.55 × family blend + 0.45 × confluence score`, with agreement bonuses (≥3 stacks = +0.1, ≥4 = +0.2), conflict penalties for strong opposing stacks (>0.5 against the majority), a 0.6× regime-misalignment dampener, and a setup boost (up to +0.1) when a named playbook setup fires in the composite direction. **A trade needs ≥3 agreeing stacks in a regime that permits the setup class.**

---

## 4. The setup library (named playbook entries)

Evaluated every scan via `matchSetups`:

1. **london-sweep-reversal** — London session: sweep of Asia range + CHoCH confirms (0.85)
2. **sweep-choch-reversal** — sweep + CHoCH in any session (0.70)
3. **vwap-reversion** — range regime, ±2σ stretch from VWAP with RSI agreement (0.70)
4. **squeeze-breakout** — coil fires with volume expansion (0.80) / weak volume (0.55)
5. **ob-confluence-tap** — OB tap with derivatives/regime/zone confluence (0.65)
6. **funding-flip-continuation** — trend stack >0.4 + neutral funding + OI not opposing (0.60)
7. **cascade-snapback** — liquidation cascade + BOS reclaim (0.80) / without reclaim (0.60)
8. **ny-continuation** — NY session, trend intact, mid-range retrace (0.55)
9. **breaker-retest** — sweep ≤6 bars ago + retest of the flipped OB zone (0.60)

---

## 5. The agentic AI layer (`src/agent.ts`)

### 5.1 Modes (`AGENT_MODE` env)

- **`single`** (default) — one structured LLM call (local Ollama, JSON-constrained, temperature 0.2) weighing all ten families + regime + confluence + active setups. Works with small local models (minicpm5:2b).
- **`debate`** — adversarial three-call pipeline: **BULL analyst** argues the long case → **BEAR analyst** argues the short case → **JUDGE** weighs signals + both arguments and emits verdicts. Reduces single-call bias. Falls back to single-call on failure, and to rule-based composite on LLM outage — the loop never stalls.

### 5.2 Guardrails

- Strict-JSON responses, every candidate must appear exactly once; missing symbols default to HOLD
- Confidence clamped to [0, 0.95]; 0.80+ requires ≥3-stack confluence (per prompt rules)
- Rule-based fallback uses the confluence-blended composite + setup boost
- Position supervisor re-reviews open positions every 3rd cycle, with confluence-stack and opposing-setup context; exits only on clear thesis invalidation

### 5.3 Decision journal

Every cycle's candidates, verdicts, executions, skips and the source (`llm` / `llm-debate` / `rules-fallback`) land in the journal (UI / CLI / MCP all read it).

---

## 6. Risk framework (`src/risk.ts`)

**Hard limits (deterministic code, never the LLM):**

- 2% equity risk per trade, position sized off stop distance
- −3% daily loss cutoff → entries halted until UTC midnight or recovery
- Max 3 concurrent positions, ≤5× notional leverage, 30% margin buffer check
- Per-symbol 30-min cooldown after a stop-out
- Confidence floor 0.60; ATR bracket (SL = 1.5×ATR, TP = 2R) checked every 5s; 4h intraday max hold

**v2 extensions:**

- **Chandelier trailing stop** (3×ATR, checks every 5s, only ever tightens; breakeven move at +1R) — `trailingStopEnabled`
- **Consecutive-loss circuit breaker** — halt after 4 losses in a row (`maxConsecutiveLosses`)
- **Sizing modes** (`SIZING_MODE`): `fixed-fractional` (default) · `quarter-kelly` (live Kelly estimate from the last 50 trades, quartered and capped at base risk, falls back when history <20 trades or edge ≤0) · `vol-target` (risk scaled inversely with ATR%, clamped 0.5–1.5×)

---

## 7. Data feeds

| Feed | Source | Cadence |
|---|---|---|
| Tickers, 5m/15m/**1h** klines, mark price + funding | `fstream.binance.com` WS | realtime |
| **Liquidations** | `!forceOrder@arr` WS stream | realtime, 1h rolling window per symbol |
| OI history | `/futures/data/openInterestHist` | every cycle (top 12 symbols) |
| **Global / top-trader / taker L/S ratios** | `/futures/data/globalLongShortAccountRatio`, `topLongShortPositionRatio`, `takerlongshortRatio` | every 4 cycles (top 8) |
| **Funding-rate history** | `/fapi/v1/fundingRate` (settled, 100 points) | every 20 cycles (top 10) |
| CoinDCX perp + spot INR | `api.coindcx.com` (Cloudflare-sensitive) | every cycle |
| USDT/INR fx | CoinGecko | every cycle |

REST bans degrade gracefully: kline bootstrap falls back to the public spot mirror; ratio/funding fetches return nulls and the analytics label themselves "unavailable" instead of throwing.

---

## 8. Surfaces

- **REST** `GET /engine/analysis/:SYMBOL` — the full deep-analysis payload (every indicator, structure snapshot, derivatives context, regime, stacks, setups, composite)
- **CLI** `bun cli/agent-cli.ts analyze BTCUSDT` — human-readable deep analysis
- **MCP** `deep_analysis` tool — same payload for Claude Desktop / Cursor / Claude Code
- **Snapshot** — tickers now carry `lsRatio`, `topTraderRatio`, `takerRatio`, `liqLongUsd/ShortUsd`, `liqCascade`; risk carries `lossStreak`, `sizingMode`, `trailingStop`

## 9. Environment switches

| Var | Default | Effect |
|---|---|---|
| `AGENT_MODE` | `single` | `debate` = bull/bear/judge pipeline |
| `SIZING_MODE` | `fixed-fractional` | `quarter-kelly` / `vol-target` |
| `EXTENDED_SIGNALS` | `1` | `0` = fall back to the v1 three-family composite |
| `FETCH_LS_RATIOS` | `1` | `0` = skip long/short ratio polling |

## 10. Testing & extending

```bash
bun scripts/test-signals.ts            # 77 offline assertions across the whole stack
bun scripts/test-signals.ts BTCUSDT    # live deep analysis against Binance REST
```

To add a strategy family: implement `(inp: StrategyInputs) => SignalOut` in `strategies.ts`, add it to `computeExtendedSignals` + the family blend, mirror it in `toSignalSet` + `SignalSet` (optional field) + the agent prompt. To add a setup: a `SetupHit`-returning function in `confluence.ts` registered in `matchSetups`. Regression net: extend `scripts/test-signals.ts` — every new path needs a deterministic fixture.

## 11. Roadmap (deliberately not in this repo yet)

- True HMM regime fitting + GARCH vol forecasting (the current regime gate is the deterministic stand-in)
- XGBoost/LightGBM meta-labeling over the engineered features (needs a feature store + walk-forward validation harness)
- LLM news/sentiment agent with tool access (currently the LLM only weighs quantified signals)
- Volume-profile POC/VAH/VAL from trade-level data; footprint delta from L2 tape
- Options-derived implied vol for the squeeze/regime layers
