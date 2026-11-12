// ─── Technical indicators (pure functions, no deps) ──────────────────────────
// Full intraday TA library: trend, momentum, volatility, volume, order-flow
// approximation, statistics and divergence detection. Every function is pure
// and defensive — bad inputs yield zeros/empty arrays, never throws.

import type { Candle } from './types'

// ── basics ───────────────────────────────────────────────────────────────────

export function sma(values: number[], period: number): number[] {
  const out: number[] = []
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    out.push(i >= period - 1 ? sum / period : NaN)
  }
  return out
}

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

export function wma(values: number[], period: number): number[] {
  const out: number[] = []
  const denom = (period * (period + 1)) / 2
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(NaN); continue }
    let w = 0
    for (let j = 0; j < period; j++) w += values[i - period + 1 + j] * (j + 1)
    out.push(w / denom)
  }
  return out
}

/** Hull moving average — very low lag, good for fast trend flips. */
export function hullMa(values: number[], period = 21): number[] {
  const half = Math.max(2, Math.floor(period / 2))
  const w1 = wma(values, half)
  const w2 = wma(values, period)
  const raw = values.map((_, i) => (isNaN(w1[i]) || isNaN(w2[i]) ? NaN : 2 * w1[i] - w2[i]))
  return wma(raw.map((v) => (isNaN(v) ? 0 : v)), Math.max(2, Math.floor(Math.sqrt(period))))
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

export function trueRange(candles: Candle[]): number[] {
  const out: number[] = []
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { out.push(candles[i].h - candles[i].l); continue }
    const c = candles[i]
    const p = candles[i - 1]
    out.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)))
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

// ── momentum ─────────────────────────────────────────────────────────────────

export interface MacdSnapshot { macd: number; signal: number; hist: number; histSlope: number }

export function macd(closes: number[], fast = 12, slow = 26, signal = 9): MacdSnapshot {
  if (closes.length < slow + signal) return { macd: 0, signal: 0, hist: 0, histSlope: 0 }
  const ef = ema(closes, fast)
  const es = ema(closes, slow)
  const line = closes.map((_, i) => ef[i] - es[i])
  const sig = ema(line, signal)
  const n = closes.length - 1
  const hist = line[n] - sig[n]
  const histPrev = line[n - 1] - sig[n - 1]
  return { macd: line[n], signal: sig[n], hist, histSlope: hist - histPrev }
}

export interface StochSnapshot { k: number; d: number }

export function stochastic(candles: Candle[], kPeriod = 14, dPeriod = 3): StochSnapshot {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < kPeriod + dPeriod) return { k: 50, d: 50 }
  const ks: number[] = []
  for (let i = kPeriod - 1; i < closed.length; i++) {
    const win = closed.slice(i - kPeriod + 1, i + 1)
    const hh = Math.max(...win.map((c) => c.h))
    const ll = Math.min(...win.map((c) => c.l))
    const c = closed[i].c
    ks.push(hh === ll ? 50 : ((c - ll) / (hh - ll)) * 100)
  }
  const k = ks[ks.length - 1]
  const d = ks.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod
  return { k, d }
}

/** Stochastic of the RSI — timing tool for pullback entries within a trend. */
export function stochRsi(closes: number[], rsiPeriod = 14, stochPeriod = 14): number {
  const r = rsi(closes, rsiPeriod)
  const win = r.slice(-stochPeriod)
  const hi = Math.max(...win)
  const lo = Math.min(...win)
  const last = r[r.length - 1] ?? 50
  return hi === lo ? 50 : ((last - lo) / (hi - lo)) * 100
}

export function cci(candles: Candle[], period = 20): number {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < period) return 0
  const win = closed.slice(-period)
  const tp = win.map((c) => (c.h + c.l + c.c) / 3)
  const mean = tp.reduce((a, b) => a + b, 0) / period
  const md = tp.reduce((a, b) => a + Math.abs(b - mean), 0) / period
  const last = tp[tp.length - 1]
  return md === 0 ? 0 : (last - mean) / (0.015 * md)
}

export function williamsR(candles: Candle[], period = 14): number {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < period) return -50
  const win = closed.slice(-period)
  const hh = Math.max(...win.map((c) => c.h))
  const ll = Math.min(...win.map((c) => c.l))
  const c = win[win.length - 1].c
  return hh === ll ? -50 : ((hh - c) / (hh - ll)) * -100
}

export function roc(closes: number[], period = 12): number {
  if (closes.length <= period) return 0
  const a = closes[closes.length - 1 - period]
  const b = closes[closes.length - 1]
  return a ? ((b - a) / a) * 100 : 0
}

/** True Strength Index — double-smoothed momentum, low noise. */
export function tsi(closes: number[], long = 25, short = 13): number {
  if (closes.length < long + short + 2) return 0
  const m: number[] = [0]
  for (let i = 1; i < closes.length; i++) m.push(closes[i] - closes[i - 1])
  const f = ema(m, long)
  const f2 = ema(f, short)
  const abs = m.map(Math.abs)
  const af = ema(abs, long)
  const af2 = ema(af, short)
  const d = af2[af2.length - 1]
  return d === 0 ? 0 : (f2[f2.length - 1] / d) * 100
}

export function awesomeOscillator(candles: Candle[], fast = 5, slow = 34): number {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < slow) return 0
  const hl = closed.map((c) => (c.h + c.l) / 2)
  const f = sma(hl, fast)
  const s = sma(hl, slow)
  const n = hl.length - 1
  return (f[n] ?? 0) - (s[n] ?? 0)
}

// ── trend systems ────────────────────────────────────────────────────────────

export interface AdxSnapshot { adx: number; plusDi: number; minusDi: number }

export function adx(candles: Candle[], period = 14): AdxSnapshot {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < period * 2) return { adx: 0, plusDi: 0, minusDi: 0 }
  let plusDm = 0
  let minusDm = 0
  let trSum = 0
  const adxs: number[] = []
  let prevPlus = 0
  let prevMinus = 0
  let prevTr = 0
  for (let i = 1; i < closed.length; i++) {
    const up = closed[i].h - closed[i - 1].h
    const dn = closed[i - 1].l - closed[i].l
    const pdm = up > dn && up > 0 ? up : 0
    const mdm = dn > up && dn > 0 ? dn : 0
    const tr = Math.max(closed[i].h - closed[i].l, Math.abs(closed[i].h - closed[i - 1].c), Math.abs(closed[i].l - closed[i - 1].c))
    if (i <= period) {
      plusDm += pdm
      minusDm += mdm
      trSum += tr
      prevPlus = plusDm
      prevMinus = minusDm
      prevTr = trSum
    } else {
      prevPlus = prevPlus - prevPlus / period + pdm
      prevMinus = prevMinus - prevMinus / period + mdm
      prevTr = prevTr - prevTr / period + tr
    }
    if (i >= period) {
      const plusDi = prevTr ? (prevPlus / prevTr) * 100 : 0
      const minusDi = prevTr ? (prevMinus / prevTr) * 100 : 0
      const dx = plusDi + minusDi ? (Math.abs(plusDi - minusDi) / (plusDi + minusDi)) * 100 : 0
      adxs.push(dx)
    }
  }
  const last = adxs.slice(-period)
  return {
    adx: last.length ? last.reduce((a, b) => a + b, 0) / last.length : 0,
    plusDi: prevTr ? (prevPlus / prevTr) * 100 : 0,
    minusDi: prevTr ? (prevMinus / prevTr) * 100 : 0,
  }
}

export interface SuperTrendPoint { value: number; dir: 1 | -1 } // dir 1 = uptrend

export function superTrend(candles: Candle[], period = 10, mult = 3): SuperTrendPoint {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < period + 2) return { value: closed.length ? closed[closed.length - 1].c : 0, dir: 1 }
  const trs = trueRange(closed)
  let atrV = trs.slice(0, period).reduce((a, b) => a + b, 0) / period
  let dir: 1 | -1 = 1
  let st = closed[period].c
  let upper = 0
  let lower = 0
  for (let i = period; i < closed.length; i++) {
    atrV = (atrV * (period - 1) + trs[i]) / period
    const mid = (closed[i].h + closed[i].l) / 2
    const bu = mid + mult * atrV
    const bl = mid - mult * atrV
    const prevClose = closed[i - 1].c
    upper = bu < upper || prevClose > upper || upper === 0 ? bu : upper
    lower = bl > lower || prevClose < lower || lower === 0 ? bl : lower
    if (closed[i].c > upper) dir = 1
    else if (closed[i].c < lower) dir = -1
    st = dir === 1 ? lower : upper
  }
  return { value: st, dir }
}

export interface IchimokuSnapshot { tenkan: number; kijun: number; spanA: number; spanB: number; priceAboveCloud: boolean | null }

export function ichimoku(candles: Candle[], tenkanP = 9, kijunP = 26, spanBP = 52): IchimokuSnapshot {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < spanBP) return { tenkan: 0, kijun: 0, spanA: 0, spanB: 0, priceAboveCloud: null }
  const mid = (p: number) => {
    const win = closed.slice(-p)
    return (Math.max(...win.map((c) => c.h)) + Math.min(...win.map((c) => c.l))) / 2
  }
  const tenkan = mid(tenkanP)
  const kijun = mid(kijunP)
  const spanA = (tenkan + kijun) / 2
  const spanB = mid(spanBP)
  const price = closed[closed.length - 1].c
  return { tenkan, kijun, spanA, spanB, priceAboveCloud: price > Math.max(spanA, spanB) ? true : price < Math.min(spanA, spanB) ? false : null }
}

export function parabolicSar(candles: Candle[], afStep = 0.02, afMax = 0.2): { value: number; dir: 1 | -1 } {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < 5) return { value: closed.length ? closed[closed.length - 1].c : 0, dir: 1 }
  let dir: 1 | -1 = closed[1].c >= closed[0].c ? 1 : -1
  let ep = dir === 1 ? closed[0].h : closed[0].l
  let sar = dir === 1 ? closed[0].l : closed[0].h
  let af = afStep
  for (let i = 1; i < closed.length; i++) {
    sar = sar + af * (ep - sar)
    if (dir === 1) {
      if (closed[i].l < sar) { dir = -1; sar = ep; ep = closed[i].l; af = afStep }
      else if (closed[i].h > ep) { ep = closed[i].h; af = Math.min(afMax, af + afStep) }
    } else {
      if (closed[i].h > sar) { dir = 1; sar = ep; ep = closed[i].h; af = afStep }
      else if (closed[i].l < ep) { ep = closed[i].l; af = Math.min(afMax, af + afStep) }
    }
  }
  return { value: sar, dir }
}

// ── volatility channels ──────────────────────────────────────────────────────

export interface DonchianSnapshot { upper: number; lower: number; mid: number; posPct: number }

export function donchian(candles: Candle[], period = 20): DonchianSnapshot {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < period) return { upper: 0, lower: 0, mid: 0, posPct: 0.5 }
  const win = closed.slice(-period)
  const upper = Math.max(...win.map((c) => c.h))
  const lower = Math.min(...win.map((c) => c.l))
  const price = closed[closed.length - 1].c
  return { upper, lower, mid: (upper + lower) / 2, posPct: upper === lower ? 0.5 : (price - lower) / (upper - lower) }
}

export interface KeltnerSnapshot { upper: number; mid: number; lower: number }

export function keltner(candles: Candle[], period = 20, mult = 2, atrPeriod = 10): KeltnerSnapshot {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < period) return { upper: 0, mid: 0, lower: 0 }
  const closes = closed.map((c) => c.c)
  const mid = closes.slice(-period).reduce((a, b) => a + b, 0) / period
  const a = atr(closed, atrPeriod)
  return { upper: mid + mult * a, mid, lower: mid - mult * a }
}

export interface SqueezeSnapshot {
  squeezing: boolean          // BB inside Keltner — coiled market
  fired: 'up' | 'down' | null // squeeze released with directional impulse
  bbWidth: number
  bbWidthPctile: number       // 0..1 within lookback
}

/** TTM-style squeeze: Bollinger Bands collapse inside Keltner Channels. */
export function squeeze(closes: number[], candles: Candle[], lookback = 100): SqueezeSnapshot {
  if (closes.length < 60) return { squeezing: false, fired: null, bbWidth: 0, bbWidthPctile: 0.5 }
  const bb = bollinger(closes, 20, 2)
  const kc = keltner(candles, 20, 2, 10)
  const squeezingNow = bb.upper < kc.upper && bb.lower > kc.lower
  // previous bar squeeze state for "fired" detection
  const closesPrev = closes.slice(0, -1)
  const candlesPrev = candles.slice(0, -1)
  let wasSqueezing = false
  if (closesPrev.length >= 60) {
    const bbP = bollinger(closesPrev, 20, 2)
    const kcP = keltner(candlesPrev, 20, 2, 10)
    wasSqueezing = bbP.upper < kcP.upper && bbP.lower > kcP.lower
  }
  const last = closes[closes.length - 1]
  const prev = closes[closes.length - 2] ?? last
  const fired: 'up' | 'down' | null = wasSqueezing && !squeezingNow ? (last > prev ? 'up' : last < prev ? 'down' : null) : null
  // bandwidth percentile over lookback
  const widths: number[] = []
  for (let i = Math.max(20, closes.length - lookback); i <= closes.length; i++) {
    const w = closes.slice(Math.max(0, i - 20), i)
    if (w.length === 20) {
      const m = w.reduce((a, b) => a + b, 0) / 20
      const sd = stdev(w)
      if (m) widths.push((2 * 2 * sd) / m)
    }
  }
  const pctile = widths.length ? widths.filter((w) => w <= bb.width).length / widths.length : 0.5
  return { squeezing: squeezingNow, fired, bbWidth: bb.width, bbWidthPctile: pctile }
}

// ── VWAP ─────────────────────────────────────────────────────────────────────

export interface VwapSnapshot { vwap: number; upper: number; lower: number; posPct: number }

/** Rolling VWAP + 1σ bands from candle quote/base volume (approximation). */
export function vwap(candles: Candle[], n = 96): VwapSnapshot {
  const closed = candles.filter((c) => c.closed).slice(-n)
  if (!closed.length) return { vwap: 0, upper: 0, lower: 0, posPct: 0.5 }
  let pv = 0
  let vv = 0
  for (const c of closed) {
    const typical = (c.h + c.l + c.c) / 3
    const vol = c.q && c.c ? c.q / c.c : c.v // prefer quote volume converted to base
    pv += typical * vol
    vv += vol
  }
  const v = vv ? pv / vv : closed[closed.length - 1].c
  // volume-weighted stdev of price around vwap
  let sv = 0
  for (const c of closed) {
    const typical = (c.h + c.l + c.c) / 3
    const vol = c.q && c.c ? c.q / c.c : c.v
    sv += vol * (typical - v) ** 2
  }
  const sd = vv ? Math.sqrt(sv / vv) : 0
  const price = closed[closed.length - 1].c
  return { vwap: v, upper: v + sd, lower: v - sd, posPct: sd ? Math.min(1, Math.max(0, (price - (v - sd)) / (2 * sd))) : 0.5 }
}

// ── volume & order-flow approximation ────────────────────────────────────────

export function obv(candles: Candle[]): number[] {
  const out: number[] = [0]
  for (let i = 1; i < candles.length; i++) {
    const dir = candles[i].c > candles[i - 1].c ? 1 : candles[i].c < candles[i - 1].c ? -1 : 0
    out.push(out[i - 1] + dir * candles[i].v)
  }
  return out
}

export function mfi(candles: Candle[], period = 14): number {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < period + 1) return 50
  let pos = 0
  let neg = 0
  for (let i = closed.length - period; i < closed.length; i++) {
    const tp = (closed[i].h + closed[i].l + closed[i].c) / 3
    const prevTp = (closed[i - 1].h + closed[i - 1].l + closed[i - 1].c) / 3
    const flow = tp * closed[i].v
    if (tp > prevTp) pos += flow
    else if (tp < prevTp) neg += flow
  }
  return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg)
}

/** Chaikin Money Flow — close-location-value weighted volume flow. */
export function cmf(candles: Candle[], period = 20): number {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < period) return 0
  const win = closed.slice(-period)
  let mfv = 0
  let vol = 0
  for (const c of win) {
    const range = c.h - c.l
    const mfm = range ? ((2 * c.c - c.l - c.h) / range) : 0
    mfv += mfm * c.v
    vol += c.v
  }
  return vol ? mfv / vol : 0
}

/**
 * Per-candle volume-delta approximation (no L2 tape available):
 * buy-volume share estimated from where the close sits inside the bar range.
 */
export function approxDelta(c: Candle): number {
  const range = c.h - c.l
  if (!range || !c.v) return 0
  const buyShare = (2 * c.c - c.l - c.h) / range + 1 // 0..2, 1 = neutral
  return c.v * (buyShare - 1)
}

/** Cumulative Volume Delta approximation series. */
export function cvdSeries(candles: Candle[]): number[] {
  const out: number[] = []
  let acc = 0
  for (const c of candles) {
    acc += approxDelta(c)
    out.push(acc)
  }
  return out
}

/** CVD slope over the last n candles (positive = aggressive buying). */
export function cvdSlope(candles: Candle[], n = 20): number {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < n) return 0
  const cvd = cvdSeries(closed)
  const a = cvd[cvd.length - n]
  const b = cvd[cvd.length - 1]
  const avgVol = closed.slice(-n).reduce((s, c) => s + c.v, 0) / n
  return avgVol ? (b - a) / avgVol : 0
}

// ── statistics ───────────────────────────────────────────────────────────────

export function zscore(value: number, window: number[]): number {
  if (window.length < 2) return 0
  const mean = window.reduce((a, b) => a + b, 0) / window.length
  const sd = stdev(window)
  return sd ? (value - mean) / sd : 0
}

export function percentileRank(window: number[], value: number): number {
  if (!window.length) return 0.5
  return window.filter((w) => w <= value).length / window.length
}

/** Least-squares slope of the last n points (normalized by mean). */
export function linregSlope(values: number[], n = 20): number {
  if (values.length < n || n < 2) return 0
  const win = values.slice(-n)
  const meanX = (n - 1) / 2
  const meanY = win.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (win[i] - meanY)
    den += (i - meanX) ** 2
  }
  const slope = den ? num / den : 0
  return meanY ? (slope / Math.abs(meanY)) : 0
}

export function highest(values: number[]): number {
  return values.length ? Math.max(...values) : 0
}

export function lowest(values: number[]): number {
  return values.length ? Math.min(...values) : 0
}

/** Median — ignores non-finite entries; empty → 0. */
export function median(values: number[]): number {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!clean.length) return 0
  const mid = Math.floor(clean.length / 2)
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2
}

// ── divergence detection ─────────────────────────────────────────────────────

export interface DivergenceResult { type: 'regular-bull' | 'regular-bear' | 'hidden-bull' | 'hidden-bear' | null; strength: number }

/**
 * Regular + hidden divergence between price and an oscillator over the last
 * two pivot pairs. Price pivots are fractal (2-2) swing highs/lows.
 */
export function divergence(candles: Candle[], osc: number[]): DivergenceResult {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < 30 || osc.length < closed.length) return { type: null, strength: 0 }
  const o = osc.slice(osc.length - closed.length)
  // find last two pivot highs and pivot lows (left/right = 2)
  const pivotHighs: number[] = []
  const pivotLows: number[] = []
  for (let i = 2; i < closed.length - 2; i++) {
    if (closed[i].h > closed[i - 1].h && closed[i].h > closed[i - 2].h &&
        closed[i].h > closed[i + 1].h && closed[i].h > closed[i + 2].h) pivotHighs.push(i)
    if (closed[i].l < closed[i - 1].l && closed[i].l < closed[i - 2].l &&
        closed[i].l < closed[i + 1].l && closed[i].l < closed[i + 2].l) pivotLows.push(i)
  }
  const check = (pivots: number[], kind: 'high' | 'low'): DivergenceResult => {
    if (pivots.length < 2) return { type: null, strength: 0 }
    const [a, b] = pivots.slice(-2)
    const priceA = kind === 'high' ? closed[a].h : closed[a].l
    const priceB = kind === 'high' ? closed[b].h : closed[b].l
    const oscA = o[a]
    const oscB = o[b]
    const priceDiff = priceB - priceA
    const oscDiff = oscB - oscA
    const rel = Math.abs(priceA) ? priceDiff / priceA : 0
    if (Math.abs(rel) < 0.001) return { type: null, strength: 0 }
    if (kind === 'low') {
      if (priceDiff < 0 && oscDiff > 0) return { type: 'regular-bull', strength: Math.min(1, Math.abs(oscDiff) / 20) }
      if (priceDiff > 0 && oscDiff < 0) return { type: 'hidden-bear', strength: Math.min(1, Math.abs(oscDiff) / 20) }
    } else {
      if (priceDiff > 0 && oscDiff < 0) return { type: 'regular-bear', strength: Math.min(1, Math.abs(oscDiff) / 20) }
      if (priceDiff < 0 && oscDiff > 0) return { type: 'hidden-bull', strength: Math.min(1, Math.abs(oscDiff) / 20) }
    }
    return { type: null, strength: 0 }
  }
  const bull = check(pivotLows, 'low')
  if (bull.type) return bull
  return check(pivotHighs, 'high')
}
