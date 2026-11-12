// ─── Intraday strategy layer — 10 families + confluence-blended composite ────
// v1 families (kept verbatim):
//   1. Momentum breakout  — 15m: EMA(9/21) alignment + volume expansion + OI drift
//   2. Mean reversion     — 5m:  RSI(2) extreme + Bollinger band pierce
//   3. Cross-exchange     — Binance perp vs CoinDCX premium + funding extremes
// v2 families (SMC/ICT + derivatives + sessions):
//   4. Liquidity sweep    — sweep of EQH/EQL + CHoCH confirmation (stop-hunt reversal)
//   5. Squeeze breakout   — TTM squeeze (BB inside KC) fires with volume expansion
//   6. Order block tap    — price returns to displacement OB in premium/discount
//   7. Session breakout   — Asia range break during London/NY with OI + volume
//   8. Funding flip       — healthy trend while funding resets to neutral
//   9. Cascade snapback   — liquidation cascade exhaustion + reclaim
//  10. VWAP reversion     — 2σ stretch from rolling VWAP in a range regime
// Composite score ∈ [-1, 1] blends family scores through the confluence engine
// (five stacks + regime gate) before hitting the LLM confluence layer.

import type { Candle, SignalOut } from './types'
import { ema, rsi, atr, bollinger, avgVolume, squeeze, vwap, superTrend, macd } from './indicators'
import {
  structureSnapshot, findSwings, labelStructure, detectBosChoch, liquidityPools,
  detectSweep, premiumDiscount, sessionInfo, asiaRange, type StructureSnapshot,
} from './structure'
import {
  fundingRegime, oiPriceQuadrant, lsRatioAnalysis, liquidationAnalytics, basisAnalysis,
  derivativesVote, type DerivativesContext, type LiquidationEvent,
} from './derivatives'
import { computeConfluence, matchSetups, type ConfluenceResult, type RegimeInfo, type SetupHit } from './confluence'

export interface StrategyInputs {
  symbol: string
  m15: Candle[]
  m5: Candle[]
  h1?: Candle[]                       // 1h candles (HTF bias) — optional
  fundingRate: number
  fundingHistory?: number[]           // settled funding history for z-scoring
  oiChangePct: number | null          // last 15m change
  spreadPct: number | null            // coindcx premium vs binance
  // ── v2 derivatives inputs ──
  lsRatio?: number | null             // global long/short account ratio
  topTraderRatio?: number | null      // top-trader position ratio
  takerRatio?: number | null          // taker buy/sell ratio
  liquidations?: LiquidationEvent[]   // rolling 1h liquidation window
  spotRef?: number | null             // spot reference price for basis
  price24hChgPct?: number | null      // 24h change for OI quadrant
}

// ── v1 families ──────────────────────────────────────────────────────────────

export function momentumSignal(inp: StrategyInputs) {
  const closes = inp.m15.filter((c) => c.closed).map((c) => c.c)
  if (closes.length < 25) return { score: 0, dir: 0 as -1 | 0 | 1, note: 'insufficient 15m history' }
  const e9 = ema(closes, 9)
  const e21 = ema(closes, 21)
  const last = closes.length - 1
  const emaGap = (e9[last] - e21[last]) / e21[last]          // relative gap
  const crossedUp = e9[last - 1] <= e21[last - 1] && e9[last] > e21[last]
  const crossedDn = e9[last - 1] >= e21[last - 1] && e9[last] < e21[last]
  const volAvg = avgVolume(inp.m15, 20)
  const volLast = inp.m15.filter((c) => c.closed).slice(-1)[0]?.v ?? 0
  const volSpike = volAvg ? volLast / volAvg : 1
  const oi = inp.oiChangePct ?? 0

  let score = 0
  let dir: -1 | 0 | 1 = 0
  const parts: string[] = []

  if (e9[last] > e21[last]) { score += 0.35; dir = 1 } else if (e9[last] < e21[last]) { score -= 0.35; dir = -1 }
  if (crossedUp) { score += 0.2; parts.push('fresh EMA9>21 cross') }
  if (crossedDn) { score -= 0.2; parts.push('fresh EMA9<21 cross') }
  if (volSpike >= 1.5) { parts.push(`vol×${volSpike.toFixed(1)}`); score += dir * 0.15 }
  if (oi > 0.3) { parts.push(`OI+${oi.toFixed(1)}%`); score += dir * 0.15 }
  if (oi < -0.3) { parts.push(`OI${oi.toFixed(1)}%`); score -= dir > 0 ? 0.1 : -0.1 }

  score = Math.max(-1, Math.min(1, score)) * (emaGap > 0 === dir > 0 ? 1 : 0.5)
  if (dir === 0) dir = emaGap >= 0 ? 1 : -1
  const note = `EMA gap ${(emaGap * 100).toFixed(2)}%, ${parts.join(' · ') || 'trend aligned'}`.trim()
  return { score: Number(score.toFixed(3)), dir, note }
}

export function meanReversionSignal(inp: StrategyInputs) {
  const closes = inp.m5.filter((c) => c.closed).map((c) => c.c)
  if (closes.length < 25) return { score: 0, dir: 0 as -1 | 0 | 1, note: 'insufficient 5m history' }
  const r2 = rsi(closes, 2)
  const lastRsi = r2[r2.length - 1]
  const bb = bollinger(closes, 20, 2)
  const last = closes[closes.length - 1]

  let score = 0
  let dir: -1 | 0 | 1 = 0
  const parts: string[] = []

  if (lastRsi < 10 && bb.pctB < 0.15) { score = 0.85; dir = 1; parts.push(`RSI2 ${lastRsi.toFixed(0)} oversold, %B ${bb.pctB.toFixed(2)}`) }
  else if (lastRsi > 90 && bb.pctB > 0.85) { score = -0.85; dir = -1; parts.push(`RSI2 ${lastRsi.toFixed(0)} overbought, %B ${bb.pctB.toFixed(2)}`) }
  else if (lastRsi < 25 && bb.pctB < 0.3) { score = 0.4; dir = 1; parts.push(`RSI2 ${lastRsi.toFixed(0)} soft oversold`) }
  else if (lastRsi > 75 && bb.pctB > 0.7) { score = -0.4; dir = -1; parts.push(`RSI2 ${lastRsi.toFixed(0)} soft overbought`) }
  else { parts.push(`RSI2 ${lastRsi.toFixed(0)} neutral`) }

  // require some volatility to mean-revert within
  if (bb.width < 0.0015) { score *= 0.4; parts.push('tight BB (low vol)') }
  void last
  return { score: Number(score.toFixed(3)), dir, note: parts.join(' · ') }
}

export function spreadSignal(inp: StrategyInputs) {
  let score = 0
  let dir: -1 | 0 | 1 = 0
  const parts: string[] = []
  const fr = inp.fundingRate
  const sp = inp.spreadPct

  // Funding extremes: very positive funding → crowded longs → short bias (and vice versa)
  if (fr >= 0.0005) { score -= 0.5; parts.push(`funding ${(fr * 100).toFixed(3)}% crowded long`) }
  else if (fr <= -0.0005) { score += 0.5; parts.push(`funding ${(fr * 100).toFixed(3)}% crowded short`) }

  // Cross-exchange premium: CoinDCX trading rich vs Binance → local euphoria (fade), cheap → local fear (buy)
  if (sp !== null) {
    if (sp >= 0.35) { score -= 0.3; parts.push(`CoinDCX +${sp.toFixed(2)}% premium`) }
    else if (sp <= -0.35) { score += 0.3; parts.push(`CoinDCX ${sp.toFixed(2)}% discount`) }
    else parts.push(`CoinDCX spread ${sp >= 0 ? '+' : ''}${sp.toFixed(2)}%`)
  } else {
    parts.push('spread n/a (CoinDCX unreachable)')
  }

  if (score > 0) dir = 1
  else if (score < 0) dir = -1
  return { score: Number(Math.max(-1, Math.min(1, score)).toFixed(3)), dir, note: parts.join(' · ') }
}

// ── v2 families ──────────────────────────────────────────────────────────────

/** 4. Liquidity sweep reversal — stop hunt through EQH/EQL, then CHoCH confirms. */
export function liquiditySweepSignal(inp: StrategyInputs, structure?: StructureSnapshot): SignalOut {
  const s = structure ?? structureSnapshot(inp.m15, inp.h1 ?? [])
  const sweep = s.sweep
  if (!sweep) return { score: 0, dir: 0, note: 'no liquidity sweep detected' }
  let score = sweep.dir * 0.5
  const parts = [`sweep ${sweep.dir > 0 ? 'of lows' : 'of highs'} ${sweep.barsAgo} bars ago`]
  if (s.bos && s.bos.dir === sweep.dir) {
    score += sweep.dir * 0.3
    parts.push(`${s.bos.kind} confirms`)
    if (s.wyckoff.name && s.wyckoff.dir === sweep.dir) { score += sweep.dir * 0.15; parts.push(`Wyckoff ${s.wyckoff.name}`) }
  }
  // freshness decay — a sweep older than 8 bars is stale
  if (sweep.barsAgo > 8) score *= 0.4
  return { score: Number(Math.max(-1, Math.min(1, score)).toFixed(3)), dir: sweep.dir, note: parts.join(' · ') }
}

/** 5. Squeeze breakout — Bollinger collapse inside Keltner, then impulse fire. */
export function squeezeBreakoutSignal(inp: StrategyInputs): SignalOut {
  const closed = inp.m15.filter((c) => c.closed)
  if (closed.length < 60) return { score: 0, dir: 0, note: 'insufficient history for squeeze' }
  const closes = closed.map((c) => c.c)
  const sq = squeeze(closes, closed, 100)
  if (sq.fired) {
    const dir = sq.fired === 'up' ? 1 : -1
    const volAvg = closed.slice(-21, -1).reduce((a, c) => a + c.v, 0) / 20 || 1
    const volLast = closed[closed.length - 1].v
    const volOk = volLast > volAvg * 1.3
    const oi = inp.oiChangePct
    let score = dir * (volOk ? 0.7 : 0.45)
    const parts = [`squeeze fired ${sq.fired}`, volOk ? `vol×${(volLast / volAvg).toFixed(1)}` : 'weak volume']
    if (oi !== null && Math.sign(oi) === dir && Math.abs(oi) > 0.2) { score += dir * 0.2; parts.push(`OI ${oi >= 0 ? '+' : ''}${oi.toFixed(1)}% confirms`) }
    return { score: Number(Math.max(-1, Math.min(1, score)).toFixed(3)), dir: dir as -1 | 0 | 1, note: parts.join(' · ') }
  }
  if (sq.squeezing) return { score: 0, dir: 0, note: `coiling — BB width pctile ${(sq.bbWidthPctile * 100).toFixed(0)}, breakout pending` }
  return { score: 0, dir: 0, note: 'no squeeze' }
}

/** 6. Order block tap — price returns into a displacement OB with range context. */
export function orderBlockSignal(inp: StrategyInputs, structure?: StructureSnapshot): SignalOut {
  const s = structure ?? structureSnapshot(inp.m15, inp.h1 ?? [])
  const ob = s.nearestOb
  if (!ob) return { score: 0, dir: 0, note: 'no fresh order block nearby' }
  if (Math.abs(ob.distPct) > 1.5) return { score: 0, dir: 0, note: `nearest OB ${ob.distPct.toFixed(2)}% away — not in tap range` }
  const parts = [`${ob.dir > 0 ? 'bullish' : 'bearish'} OB tap (${ob.distPct.toFixed(2)}%)`]
  let score = ob.dir * 0.45
  // premium/discount alignment: bullish OB in a discount zone is the textbook entry
  if (ob.dir === 1 && s.rangeCtx.positionPct < 0.45) { score += 0.2; parts.push('discount zone') }
  if (ob.dir === -1 && s.rangeCtx.positionPct > 0.55) { score += 0.2; parts.push('premium zone') }
  if (s.nearestFvg && s.nearestFvg.dir === ob.dir && Math.abs(s.nearestFvg.distPct) < 1) { score += ob.dir * 0.15; parts.push('FVG confluence') }
  if (s.patterns.some((p) => p.dir === ob.dir)) { score += ob.dir * 0.1; parts.push('candle confirm') }
  return { score: Number(Math.max(-1, Math.min(1, score)).toFixed(3)), dir: ob.dir, note: parts.join(' · ') }
}

/** 7. Session breakout — Asia range break during London/NY expansion. */
export function sessionBreakoutSignal(inp: StrategyInputs): SignalOut {
  const h1 = inp.h1 ?? []
  const ar = asiaRange(h1)
  const sess = sessionInfo()
  if (!ar || (sess.session !== 'london' && sess.session !== 'newyork')) {
    return { score: 0, dir: 0, note: ar ? `${sess.session} — no session breakout window` : 'no Asia range data' }
  }
  const closed = inp.m15.filter((c) => c.closed)
  if (!closed.length) return { score: 0, dir: 0, note: 'no candles' }
  const price = closed[closed.length - 1].c
  const breakUp = price > ar.high
  const breakDn = price < ar.low
  if (!breakUp && !breakDn) return { score: 0, dir: 0, note: `inside Asia range (${ar.low.toPrecision(6)}–${ar.high.toPrecision(6)})` }
  const dir = breakUp ? 1 : -1
  const parts = [`Asia range ${breakUp ? 'high' : 'low'} broken (${sess.session})`]
  let score = dir * 0.45
  const volAvg = avgVolume(inp.m15, 20) || 1
  const volLast = closed.slice(-1)[0]?.v ?? 0
  if (volLast > volAvg * 1.4) { score += dir * 0.2; parts.push(`vol×${(volLast / volAvg).toFixed(1)}`) }
  const oi = inp.oiChangePct
  if (oi !== null && Math.sign(oi) === dir && Math.abs(oi) > 0.2) { score += dir * 0.2; parts.push(`OI ${oi >= 0 ? '+' : ''}${oi.toFixed(1)}%`) }
  // failure check: 15m close back inside the range = failed breakout (fade)
  const prev = closed[closed.length - 2]?.c ?? price
  const failed = breakUp ? prev < ar.high && price < ar.high : prev > ar.low && price > ar.low
  if (failed) { score = -dir * 0.3; parts.push('failed break — fade risk') }
  return { score: Number(Math.max(-1, Math.min(1, score)).toFixed(3)), dir: failed ? (-dir as -1 | 1) : (dir as -1 | 1), note: parts.join(' · ') }
}

/** 8. Funding flip continuation — trend intact while funding resets to neutral. */
export function fundingFlipSignal(inp: StrategyInputs): SignalOut {
  const closed = inp.m15.filter((c) => c.closed)
  if (closed.length < 50) return { score: 0, dir: 0, note: 'insufficient history' }
  const closes = closed.map((c) => c.c)
  const st = superTrend(closed, 10, 3)
  const m = macd(closes)
  const hist = (st.dir > 0 ? 1 : -1) + (m.hist > 0 ? 0.5 : -0.5)
  const f = fundingRegime(inp.fundingRate, inp.fundingHistory ?? [])
  const parts: string[] = [`SuperTrend ${st.dir > 0 ? 'up' : 'down'}`, `MACD ${m.hist > 0 ? 'pos' : 'neg'}`, f.label]
  let score = 0
  let dir: -1 | 0 | 1 = 0
  // trend up + funding neutral/cheap (not crowded) → continuation long
  if (hist > 0.8 && (f.label === 'neutral' || f.label === 'cheap')) { score = 0.55; dir = 1; parts.push('healthy trend, funding not crowded') }
  else if (hist < -0.8 && (f.label === 'neutral' || f.label === 'rich')) { score = -0.55; dir = -1; parts.push('healthy downtrend, funding not crowded') }
  else { parts.push('trend/funding combo not aligned') }
  return { score, dir, note: parts.join(' · ') }
}

/** 9. Cascade snapback — liquidation cascade exhaustion + structural reclaim. */
export function cascadeSnapbackSignal(inp: StrategyInputs, structure?: StructureSnapshot): SignalOut {
  const liq = liquidationAnalytics(inp.liquidations ?? [])
  if (!liq.cascade) {
    if (liq.totalUsd > 0) return { score: 0, dir: 0, note: liq.note }
    return { score: 0, dir: 0, note: 'no liquidation data' }
  }
  const s = structure ?? structureSnapshot(inp.m15, inp.h1 ?? [])
  const parts = [liq.note]
  let score = liq.dir * 0.5
  if (s.bos && s.bos.dir === liq.dir) { score += liq.dir * 0.25; parts.push('BOS reclaim') }
  if (s.patterns.some((p) => p.dir === liq.dir)) { score += liq.dir * 0.15; parts.push('reversal candle') }
  if (inp.oiChangePct !== null && Math.sign(inp.oiChangePct) === liq.dir) { score += liq.dir * 0.1; parts.push(`OI reset ${inp.oiChangePct.toFixed(1)}%`) }
  return { score: Number(Math.max(-1, Math.min(1, score)).toFixed(3)), dir: liq.dir, note: parts.join(' · ') }
}

/** 10. VWAP reversion — price stretched 2σ from rolling VWAP in a range regime. */
export function vwapReversionSignal(inp: StrategyInputs): SignalOut {
  const closed = inp.m15.filter((c) => c.closed)
  if (closed.length < 40) return { score: 0, dir: 0, note: 'insufficient history' }
  const vw = vwap(closed, 96)
  const price = closed[closed.length - 1].c
  const band = vw.upper - vw.vwap
  if (!band) return { score: 0, dir: 0, note: 'degenerate VWAP band' }
  const stretch = (price - vw.vwap) / band // signed, in σ units
  const r14 = rsi(closed.map((c) => c.c), 14)
  const r = r14[r14.length - 1]
  if (stretch > 1.8 && r > 60) return { score: -0.6, dir: -1, note: `+${stretch.toFixed(1)}σ above VWAP, RSI ${r.toFixed(0)} — fade to ${vw.vwap.toPrecision(6)}` }
  if (stretch < -1.8 && r < 40) return { score: 0.6, dir: 1, note: `${stretch.toFixed(1)}σ below VWAP, RSI ${r.toFixed(0)} — fade to ${vw.vwap.toPrecision(6)}` }
  return { score: 0, dir: 0, note: `${stretch >= 0 ? '+' : ''}${stretch.toFixed(1)}σ from VWAP — not stretched` }
}

// ── composite with confluence engine ─────────────────────────────────────────

export interface ExtendedSignalSet {
  momentum: SignalOut
  meanRev: SignalOut
  spread: SignalOut
  liquiditySweep: SignalOut
  squeezeBreakout: SignalOut
  orderBlock: SignalOut
  sessionBreakout: SignalOut
  fundingFlip: SignalOut
  cascadeSnapback: SignalOut
  vwapReversion: SignalOut
  composite: number
  confluence: ConfluenceResult
  setups: SetupHit[]
  regime: RegimeInfo
  structure: StructureSnapshot
  derivatives: DerivativesContext
}

/** Build the derivatives context from raw strategy inputs. */
export function buildDerivativesContext(inp: StrategyInputs): DerivativesContext {
  const priceChg = inp.price24hChgPct ?? null
  return {
    funding: fundingRegime(inp.fundingRate, inp.fundingHistory ?? [inp.fundingRate]),
    oi: oiPriceQuadrant(priceChg, inp.oiChangePct),
    ls: lsRatioAnalysis({ global: inp.lsRatio ?? null, topTrader: inp.topTraderRatio ?? null, taker: inp.takerRatio ?? null }),
    liq: liquidationAnalytics(inp.liquidations ?? []),
    basis: basisAnalysis(inp.m15.length ? inp.m15[inp.m15.length - 1].c : 0, inp.spotRef ?? null),
  }
}

/**
 * Compute all ten families + confluence engine + regime + setup matches.
 * The composite blends the v1 family weighting with the confluence score and
 * boosts it when a named setup from the playbook fires in the same direction.
 */
export function computeExtendedSignals(inp: StrategyInputs): ExtendedSignalSet & { momentum: SignalOut; meanRev: SignalOut; spread: SignalOut; composite: number } {
  const structure = structureSnapshot(inp.m15, inp.h1 ?? [])
  const derivatives = buildDerivativesContext(inp)
  const confluence = computeConfluence({ m15: inp.m15, h1: inp.h1 ?? [], structure, derivatives })
  const setups = matchSetups({ m15: inp.m15, m5: inp.m5, h1: inp.h1 ?? [], structure, derivatives, confluence })

  const momentum = momentumSignal(inp)
  const meanRev = meanReversionSignal(inp)
  const spread = spreadSignal(inp)
  const liquiditySweep = liquiditySweepSignal(inp, structure)
  const squeezeBreakout = squeezeBreakoutSignal(inp)
  const orderBlock = orderBlockSignal(inp, structure)
  const sessionBreakout = sessionBreakoutSignal(inp)
  const fundingFlip = fundingFlipSignal(inp)
  const cascadeSnapback = cascadeSnapbackSignal(inp, structure)
  const vwapReversion = vwapReversionSignal(inp)

  // v1-style family blend across all ten (trend-led, MR/structure second)
  const familyBlend =
    momentum.score * 0.18 +
    meanRev.score * 0.10 +
    spread.score * 0.08 +
    liquiditySweep.score * 0.14 +
    squeezeBreakout.score * 0.12 +
    orderBlock.score * 0.10 +
    sessionBreakout.score * 0.08 +
    fundingFlip.score * 0.08 +
    cascadeSnapback.score * 0.06 +
    vwapReversion.score * 0.06

  // confluence engine vote gets the deciding weight
  let composite = familyBlend * 0.55 + confluence.score * 0.45

  // setup boost: strongest playbook setup firing with the composite direction
  const activeSetups = setups.filter((s) => s.dir !== 0 && s.strength >= 0.55)
  for (const s of activeSetups) {
    if (Math.sign(composite) === s.dir || (composite === 0 && s.dir !== 0)) {
      composite += s.dir * s.strength * 0.1
    }
  }
  composite = Math.max(-1, Math.min(1, composite))

  return {
    momentum,
    meanRev,
    spread,
    liquiditySweep,
    squeezeBreakout,
    orderBlock,
    sessionBreakout,
    fundingFlip,
    cascadeSnapback,
    vwapReversion,
    composite: Number(composite.toFixed(3)),
    confluence,
    setups,
    regime: confluence.regime,
    structure,
    derivatives,
  }
}

/** Legacy v1 entry point — kept so existing callers keep working. */
export function computeSignals(inp: StrategyInputs) {
  const momentum = momentumSignal(inp)
  const meanRev = meanReversionSignal(inp)
  const spread = spreadSignal(inp)
  // Counter-trend RSI(2) dip-buys lose in sustained dumps (INIT, ZEC); only take pullbacks with the trend.
  if (meanRev.dir !== momentum.dir) meanRev.score = 0
  const composite =
    momentum.score * 0.45 +
    meanRev.score * 0.30 +
    spread.score * 0.25
  return { momentum, meanRev, spread, composite: Number(composite.toFixed(3)) }
}

/** Map an ExtendedSignalSet onto the (backward-compatible) wire SignalSet. */
export function toSignalSet(x: ReturnType<typeof computeExtendedSignals>): import('./types').SignalSet {
  return {
    momentum: x.momentum,
    meanRev: x.meanRev,
    spread: x.spread,
    composite: x.composite,
    liquiditySweep: x.liquiditySweep,
    squeezeBreakout: x.squeezeBreakout,
    orderBlock: x.orderBlock,
    sessionBreakout: x.sessionBreakout,
    fundingFlip: x.fundingFlip,
    cascadeSnapback: x.cascadeSnapback,
    vwapReversion: x.vwapReversion,
    regime: {
      label: x.regime.regime,
      adx: x.regime.adx,
      bbWidthPctile: x.regime.bbWidthPctile,
      note: x.regime.note,
    },
    confluence: {
      score: x.confluence.score,
      dir: x.confluence.dir,
      agreement: x.confluence.agreement,
      regimeAligned: x.confluence.regimeAligned,
      stacks: x.confluence.stacks.map((s) => ({ name: s.name, dir: s.dir, score: s.score, notes: s.notes })),
      setups: x.setups.map((s) => ({ name: s.name, class: s.class, dir: s.dir, strength: s.strength, note: s.note })),
    },
  }
}

/** ATR-based bracket prices for an entry */
export function bracketFor(candles: Candle[], side: 'LONG' | 'SHORT', entry: number, atrMult: number, rr: number) {
  const a = atr(candles.filter((c) => c.closed), 14)
  const distance = (a > 0 ? a : entry * 0.004) * atrMult
  const stop = side === 'LONG' ? entry - distance : entry + distance
  const takeProfit = side === 'LONG' ? entry + distance * rr : entry - distance * rr
  return { stop, takeProfit, atr: a, distance }
}

// re-export SMC helpers for the analysis route / tests
export { findSwings, labelStructure, detectBosChoch, liquidityPools, detectSweep, premiumDiscount, sessionInfo, asiaRange, derivativesVote }
