// ─── Intraday strategy layer ─────────────────────────────────────────────────
// 1. Momentum breakout  — 15m: EMA(9/21) alignment + volume expansion + OI drift
// 2. Mean reversion     — 5m:  RSI(2) extreme + Bollinger band pierce
// 3. Cross-exchange     — Binance perp vs CoinDCX premium + funding extremes
// Composite score ∈ [-1, 1] feeds the LLM confluence layer.

import type { Candle, SignalSet } from './types'
import { ema, rsi, atr, bollinger, avgVolume } from './indicators'

export interface StrategyInputs {
  symbol: string
  m15: Candle[]
  m5: Candle[]
  fundingRate: number
  oiChangePct: number | null   // last 15m change
  spreadPct: number | null     // coindcx premium vs binance
}

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

export function computeSignals(inp: StrategyInputs): SignalSet {
  const momentum = momentumSignal(inp)
  const meanRev = meanReversionSignal(inp)
  const spread = spreadSignal(inp)
  // weighted confluence: trend gets the biggest say, MR second, spread as filter/tilt
  const composite =
    momentum.score * 0.45 +
    meanRev.score * 0.30 +
    spread.score * 0.25
  return { momentum, meanRev, spread, composite: Number(composite.toFixed(3)) }
}

/** ATR-based bracket prices for an entry */
export function bracketFor(candles: Candle[], side: 'LONG' | 'SHORT', entry: number, atrMult: number, rr: number) {
  const a = atr(candles.filter((c) => c.closed), 14)
  const distance = (a > 0 ? a : entry * 0.004) * atrMult
  const stop = side === 'LONG' ? entry - distance : entry + distance
  const takeProfit = side === 'LONG' ? entry + distance * rr : entry - distance * rr
  return { stop, takeProfit, atr: a, distance }
}
