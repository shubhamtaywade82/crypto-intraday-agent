// ─── Technical indicators (pure functions, no deps) ──────────────────────────

import type { Candle } from './types'

export function ema(values: number[], period: number): number[] {
  const out: number[] = []
  const k = 2 / (period + 1)
  let prev: number | null = null
  for (const v of values) {
    prev = prev === null ? v : v * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

export function rsi(values: number[], period: number): number[] {
  const out: number[] = []
  let avgGain = 0
  let avgLoss = 0
  for (let i = 0; i < values.length; i++) {
    if (i === 0) { out.push(50); continue }
    const ch = values[i] - values[i - 1]
    const gain = Math.max(0, ch)
    const loss = Math.max(0, -ch)
    if (i <= period) {
      avgGain = (avgGain * (i - 1) + gain) / i
      avgLoss = (avgLoss * (i - 1) + loss) / i
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs))
  }
  return out
}

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0
  let sum = 0
  let n = 0
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    const c = candles[i]
    const prev = candles[i - 1]
    const tr = Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c))
    sum += tr
    n++
  }
  return n ? sum / n : 0
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const v = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(v)
}

export interface BollingerSnapshot {
  mid: number
  upper: number
  lower: number
  width: number
  pctB: number // 0 = at lower band, 1 = at upper band
}

export function bollinger(closes: number[], period = 20, mult = 2): BollingerSnapshot {
  const win = closes.slice(-period)
  const mid = win.reduce((a, b) => a + b, 0) / (win.length || 1)
  const sd = stdev(win)
  const upper = mid + mult * sd
  const lower = mid - mult * sd
  const last = closes[closes.length - 1] ?? mid
  return {
    mid, upper, lower,
    width: mid ? (upper - lower) / mid : 0,
    pctB: upper > lower ? (last - lower) / (upper - lower) : 0.5,
  }
}

/** Average quote volume over last n candles (excluding current forming candle). */
export function avgVolume(candles: Candle[], n = 20): number {
  const closed = candles.filter((c) => c.closed).slice(-n)
  if (!closed.length) return 0
  return closed.reduce((a, c) => a + c.v, 0) / closed.length
}
