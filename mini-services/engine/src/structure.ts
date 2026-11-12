// ─── Market structure & Smart-Money Concepts (SMC/ICT) ───────────────────────
// Pure functions over candle arrays:
//   • swing pivots + HH/HL/LH/LL labelling + trend state
//   • BOS (break of structure) / CHoCH (change of character)
//   • order blocks (displacement-filtered), fair value gaps / imbalances
//   • equal highs/lows (liquidity pools) + liquidity sweeps / stop hunts
//   • premium/discount dealing range + OTE (62–79% retracement zone)
//   • session model (Asia range → London manipulation → NY distribution)
//   • candlestick patterns (engulfing, pin bar, doji, inside bar, stars)
//   • Wyckoff-lite spring / upthrust detection

import type { Candle } from './types'
import { atr, approxDelta } from './indicators'

// ── swing pivots & structure ─────────────────────────────────────────────────

export interface Swing {
  index: number
  t: number
  price: number
  type: 'high' | 'low'
}

export function findSwings(candles: Candle[], left = 2, right = 2): Swing[] {
  const closed = candles.filter((c) => c.closed)
  const out: Swing[] = []
  for (let i = left; i < closed.length - right; i++) {
    let isHigh = true
    let isLow = true
    for (let j = 1; j <= Math.max(left, right); j++) {
      if (j <= left) {
        if (closed[i].h <= closed[i - j].h) isHigh = false
        if (closed[i].l >= closed[i - j].l) isLow = false
      }
      if (j <= right) {
        if (closed[i].h <= closed[i + j].h) isHigh = false
        if (closed[i].l >= closed[i + j].l) isLow = false
      }
    }
    if (isHigh) out.push({ index: i, t: closed[i].t, price: closed[i].h, type: 'high' })
    if (isLow) out.push({ index: i, t: closed[i].t, price: closed[i].l, type: 'low' })
  }
  return out
}

export interface StructureState {
  trend: 'up' | 'down' | 'range'
  labels: string[]            // e.g. ['HH','HL','HH'] most recent last
  lastHigh: Swing | null
  lastLow: Swing | null
}

/** Label swing sequence as HH/HL/LH/LL and derive the structural trend. */
export function labelStructure(swings: Swing[]): StructureState {
  const highs = swings.filter((s) => s.type === 'high')
  const lows = swings.filter((s) => s.type === 'low')
  const labels: string[] = []
  if (highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price) labels.push('HH')
  else if (highs.length >= 2) labels.push('LH')
  if (lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price) labels.push('HL')
  else if (lows.length >= 2) labels.push('LL')
  const hh = labels.includes('HH')
  const hl = labels.includes('HL')
  const lh = labels.includes('LH')
  const ll = labels.includes('LL')
  let trend: StructureState['trend'] = 'range'
  if (hh && hl && !ll) trend = 'up'
  else if (lh && ll && !hh) trend = 'down'
  return { trend, labels, lastHigh: highs[highs.length - 1] ?? null, lastLow: lows[lows.length - 1] ?? null }
}

export interface BosEvent {
  kind: 'BOS' | 'CHoCH'
  dir: 1 | -1              // 1 = bullish break, -1 = bearish break
  level: number
  ts: number
  barsAgo: number
}

/**
 * Detect the most recent break of structure:
 *   BOS   — close beyond the last swing in the direction of the trend (continuation)
 *   CHoCH — close beyond the last swing against the trend (first reversal hint)
 */
export function detectBosChoch(candles: Candle[], swings: Swing[]): BosEvent | null {
  const closed = candles.filter((c) => c.closed)
  if (!closed.length || !swings.length) return null
  const struct = labelStructure(swings)
  const last = closed[closed.length - 1]
  if (!struct.lastHigh && !struct.lastLow) return null
  const barsAgo = (target: number) => closed.length - 1 - target
  if (struct.lastHigh && last.c > struct.lastHigh.price) {
    const kind = struct.trend === 'down' ? 'CHoCH' : 'BOS'
    return { kind, dir: 1, level: struct.lastHigh.price, ts: struct.lastHigh.t, barsAgo: barsAgo(struct.lastHigh.index) }
  }
  if (struct.lastLow && last.c < struct.lastLow.price) {
    const kind = struct.trend === 'up' ? 'CHoCH' : 'BOS'
    return { kind, dir: -1, level: struct.lastLow.price, ts: struct.lastLow.t, barsAgo: barsAgo(struct.lastLow.index) }
  }
  return null
}

// ── order blocks & fair value gaps ───────────────────────────────────────────

export interface OrderBlock {
  dir: 1 | -1               // 1 = bullish OB (demand), -1 = bearish OB (supply)
  top: number
  bottom: number
  ts: number
  distPct: number           // distance of current price from OB midpoint (%)
  mitigated: boolean        // price has returned into the block since
}

/**
 * Order block = last opposing candle before a displacement leg
 * (body ≥ 1.6× average body). Returns nearest unmitigated blocks.
 */
export function orderBlocks(candles: Candle[], lookback = 60, max = 4): OrderBlock[] {
  const closed = candles.filter((c) => c.closed).slice(-lookback)
  if (closed.length < 20) return []
  const bodies = closed.map((c) => Math.abs(c.c - c.o))
  const avgBody = bodies.reduce((a, b) => a + b, 0) / bodies.length
  const price = closed[closed.length - 1].c
  const out: OrderBlock[] = []
  for (let i = 1; i < closed.length - 1; i++) {
    const body = Math.abs(closed[i + 1].c - closed[i + 1].o)
    if (body < avgBody * 1.6) continue
    const bullish = closed[i + 1].c > closed[i + 1].o
    const obCandle = closed[i]
    // OB must oppose the displacement direction
    if (bullish === obCandle.c > obCandle.o) continue
    const top = Math.max(obCandle.o, obCandle.c, obCandle.h)
    const bottom = Math.min(obCandle.o, obCandle.c, obCandle.l)
    // mitigation: any later candle traded back through the block
    let mitigated = false
    for (let j = i + 2; j < closed.length; j++) {
      if (closed[j].l <= top && closed[j].h >= bottom) { mitigated = true; break }
    }
    const mid = (top + bottom) / 2
    out.push({
      dir: bullish ? 1 : -1,
      top, bottom, ts: obCandle.t, mitigated,
      distPct: mid ? ((price - mid) / mid) * 100 : 0,
    })
  }
  return out.filter((ob) => !ob.mitigated).slice(-max)
}

export interface FairValueGap {
  dir: 1 | -1               // 1 = bullish imbalance (gap up)
  top: number
  bottom: number
  ts: number
  distPct: number
  filled: boolean
}

/**
 * Fair value gap / imbalance: candle[i].high < candle[i+2].low (bullish) or
 * candle[i].low > candle[i+2].high (bearish). Unfilled gaps act as magnets.
 */
export function fairValueGaps(candles: Candle[], lookback = 60, max = 4): FairValueGap[] {
  const closed = candles.filter((c) => c.closed).slice(-lookback)
  if (closed.length < 10) return []
  const price = closed[closed.length - 1].c
  const out: FairValueGap[] = []
  for (let i = 0; i + 2 < closed.length; i++) {
    const a = closed[i]
    const c = closed[i + 2]
    let dir: 1 | -1 | 0 = 0
    let top = 0
    let bottom = 0
    if (a.h < c.l) { dir = 1; top = c.l; bottom = a.h }        // bullish gap
    else if (a.l > c.h) { dir = -1; top = a.l; bottom = c.h }  // bearish gap
    if (!dir) continue
    // filled when any later candle wicks fully through it
    let filled = false
    for (let j = i + 2; j < closed.length; j++) {
      if (dir === 1 && closed[j].l <= bottom) { filled = true; break }
      if (dir === -1 && closed[j].h >= top) { filled = true; break }
    }
    const mid = (top + bottom) / 2
    out.push({ dir, top, bottom, ts: closed[i + 1].t, distPct: mid ? ((price - mid) / mid) * 100 : 0, filled })
  }
  return out.filter((f) => !f.filled).slice(-max)
}

// ── liquidity: equal highs/lows + sweeps ─────────────────────────────────────

export interface LiquidityPool {
  type: 'EQH' | 'EQL'
  level: number
  count: number
  swept: boolean
}

/** Equal highs/lows: swing extremes clustered within tol×ATR — resting liquidity. */
export function liquidityPools(candles: Candle[], swings: Swing[], tolAtr = 0.25): LiquidityPool[] {
  if (!swings.length) return []
  const a = atr(candles, 14)
  const tol = a * tolAtr || candles[candles.length - 1]?.c * 0.0005 || 0
  const cluster = (list: Swing[], type: 'EQH' | 'EQL'): LiquidityPool[] => {
    const out: LiquidityPool[] = []
    const sorted = [...list].sort((x, y) => x.price - y.price)
    let group: Swing[] = []
    for (const s of sorted) {
      if (!group.length || Math.abs(s.price - group[group.length - 1].price) <= tol) group.push(s)
      else { if (group.length >= 2) out.push({ type, level: group[group.length - 1].price, count: group.length, swept: false }); group = [s] }
    }
    if (group.length >= 2) out.push({ type, level: group[group.length - 1].price, count: group.length, swept: false })
    return out
  }
  return [...cluster(swings.filter((s) => s.type === 'high'), 'EQH'), ...cluster(swings.filter((s) => s.type === 'low'), 'EQL')]
}

export interface SweepEvent {
  dir: 1 | -1               // 1 = sell-side liquidity swept (bullish reversal fuel)
  level: number
  ts: number
  barsAgo: number
}

/**
 * Liquidity sweep / stop hunt: candle wicks through an EQH/EQL (or fresh swing
 * extreme) but closes back on the other side. Swept liquidity often precedes
 * reversal legs — the classic "Judas swing".
 */
export function detectSweep(candles: Candle[], pools: LiquidityPool[], swings: Swing[]): SweepEvent | null {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < 5) return null
  const recent = closed.slice(-3)
  const levels = [
    ...pools.map((p) => ({ level: p.level, type: p.type as 'EQH' | 'EQL' })),
    ...swings.slice(-6).map((s) => ({ level: s.price, type: (s.type === 'high' ? 'EQH' : 'EQL') as 'EQH' | 'EQL' })),
  ]
  for (let li = 0; li < levels.length; li++) {
    const { level, type } = levels[li]
    for (let ci = 0; ci < recent.length; ci++) {
      const c = recent[ci]
      const idx = closed.length - recent.length + ci
      if (type === 'EQL' && c.l < level && c.c > level) {
        return { dir: 1, level, ts: c.t, barsAgo: closed.length - 1 - idx }
      }
      if (type === 'EQH' && c.h > level && c.c < level) {
        return { dir: -1, level, ts: c.t, barsAgo: closed.length - 1 - idx }
      }
    }
  }
  return null
}

// ── premium / discount + OTE ─────────────────────────────────────────────────

export interface RangeContext {
  high: number
  low: number
  equilibrium: number
  positionPct: number          // 0 = range low, 1 = range high
  zone: 'discount' | 'equilibrium' | 'premium'
  oteLong: { from: number; to: number } | null  // 62–79% retracement zone for longs
  oteShort: { from: number; to: number } | null
}

/**
 * Dealing-range premium/discount map with the ICT Optimal Trade Entry zone
 * (0.62–0.79 retracement of the impulse leg).
 */
export function premiumDiscount(candles: Candle[], lookback = 96): RangeContext {
  const closed = candles.filter((c) => c.closed).slice(-lookback)
  if (closed.length < 20) return { high: 0, low: 0, equilibrium: 0, positionPct: 0.5, zone: 'equilibrium', oteLong: null, oteShort: null }
  const high = Math.max(...closed.map((c) => c.h))
  const low = Math.min(...closed.map((c) => c.l))
  const eq = (high + low) / 2
  const price = closed[closed.length - 1].c
  const pos = high === low ? 0.5 : (price - low) / (high - low)
  const fib = (f: number) => high - (high - low) * f
  return {
    high, low, equilibrium: eq, positionPct: pos,
    zone: pos < 0.4 ? 'discount' : pos > 0.6 ? 'premium' : 'equilibrium',
    // OTE for longs sits at 62–79% retracement of a down-leg (i.e. 0.21–0.38 of range from the low)
    oteLong: { from: fib(0.21), to: fib(0.38) },
    // OTE for shorts mirrors at 0.62–0.79 of the range from the low
    oteShort: { from: fib(0.62), to: fib(0.79) },
  }
}

// ── session model (UTC) ──────────────────────────────────────────────────────

export interface SessionInfo {
  session: 'asia' | 'london' | 'newyork' | 'off'
  killZone: 'london-kz' | 'ny-kz' | null
  note: string
}

/**
 * Session/kill-zone clock (UTC):
 *   Asia 00–08 (accumulation), London 07–16 (manipulation/expansion,
 *   kill zone 07–10), New York 12–21 (distribution, kill zone 12–15).
 */
export function sessionInfo(now = new Date()): SessionInfo {
  const h = now.getUTCHours() + now.getUTCMinutes() / 60
  if (h >= 7 && h < 12) return { session: 'london', killZone: h < 10 ? 'london-kz' : null, note: 'London session — expansion/manipulation window' }
  if (h >= 12 && h < 16) return { session: 'newyork', killZone: h < 15 ? 'ny-kz' : null, note: 'New York session — distribution window' }
  if (h >= 16 && h < 21) return { session: 'newyork', killZone: null, note: 'NY afternoon — trend continuation or reversal' }
  if (h >= 0 && h < 7) return { session: 'asia', killZone: null, note: 'Asia session — range accumulation' }
  return { session: 'off', killZone: null, note: 'off-hours — thin liquidity, wider spreads' }
}

/** Asia range (00:00–07:00 UTC) from 1h candles — the London breakout reference. */
export function asiaRange(h1: Candle[]): { high: number; low: number } | null {
  const closed = h1.filter((c) => c.closed)
  const today = new Date()
  const dayStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const dayEnd = dayStart + 7 * 3600_000
  const win = closed.filter((c) => c.t >= dayStart && c.t < dayEnd)
  if (win.length < 3) return null
  return { high: Math.max(...win.map((c) => c.h)), low: Math.min(...win.map((c) => c.l)) }
}

// ── candlestick patterns ─────────────────────────────────────────────────────

export interface PatternHit { name: string; dir: 1 | -1 | 0; note: string }

export function candlePatterns(candles: Candle[]): PatternHit[] {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < 3) return []
  const c = closed[closed.length - 1]
  const p = closed[closed.length - 2]
  const p2 = closed[closed.length - 3]
  const body = Math.abs(c.c - c.o)
  const range = c.h - c.l || body || 1e-12
  const hits: PatternHit[] = []
  const bodyP = Math.abs(p.c - p.o)

  if (c.c > c.o && p.c < p.o && c.c >= p.o && c.o <= p.c && body > bodyP) hits.push({ name: 'bullish-engulfing', dir: 1, note: 'bulls absorbed prior bar' })
  if (c.c < c.o && p.c > p.o && c.o >= p.c && c.c <= p.o && body > bodyP) hits.push({ name: 'bearish-engulfing', dir: -1, note: 'bears absorbed prior bar' })
  const upperWick = c.h - Math.max(c.o, c.c)
  const lowerWick = Math.min(c.o, c.c) - c.l
  if (lowerWick > body * 2 && upperWick < body && body / range < 0.4) hits.push({ name: 'pin-bar-low', dir: 1, note: 'long lower wick — demand rejection' })
  if (upperWick > body * 2 && lowerWick < body && body / range < 0.4) hits.push({ name: 'pin-bar-high', dir: -1, note: 'long upper wick — supply rejection' })
  if (body / range < 0.1) hits.push({ name: 'doji', dir: 0, note: 'indecision' })
  if (c.h < p.h && c.l > p.l) hits.push({ name: 'inside-bar', dir: 0, note: 'compression — breakout fuel' })
  if (p2.c < p2.o && body > 0 && c.c > c.o && p2.c < p.c && p.o < p.c) hits.push({ name: 'morning-star', dir: 1, note: '3-bar bullish reversal' })
  if (p2.c > p2.o && body > 0 && c.c < c.o && p2.c > p.c && p.o > p.c) hits.push({ name: 'evening-star', dir: -1, note: '3-bar bearish reversal' })
  return hits
}

// ── Wyckoff-lite ─────────────────────────────────────────────────────────────

export interface WyckoffEvent { name: 'spring' | 'upthrust' | null; dir: 1 | -1 | 0; note: string }

/**
 * Spring (sweep of range low + close back inside, often on falling volume) or
 * upthrust (sweep of range high + reject) — Wyckoff phase-C tells.
 */
export function wyckoffLite(candles: Candle[], lookback = 40): WyckoffEvent {
  const closed = candles.filter((c) => c.closed).slice(-lookback)
  if (closed.length < 15) return { name: null, dir: 0, note: 'insufficient history' }
  const c = closed[closed.length - 1]
  const win = closed.slice(0, -1)
  const high = Math.max(...win.map((x) => x.h))
  const low = Math.min(...win.map((x) => x.l))
  const volAvg = win.reduce((a, x) => a + x.v, 0) / win.length
  const volFalling = c.v < volAvg
  if (c.l < low && c.c > low) return { name: 'spring', dir: 1, note: `spring below ${low.toPrecision(6)} reclaimed${volFalling ? ' on falling volume' : ''}` }
  if (c.h > high && c.c < high) return { name: 'upthrust', dir: -1, note: `upthrust above ${high.toPrecision(6)} rejected${volFalling ? ' on falling volume' : ''}` }
  return { name: null, dir: 0, note: 'no phase-C tell' }
}

// ── aggregate snapshot ───────────────────────────────────────────────────────

export interface StructureSnapshot {
  trend: 'up' | 'down' | 'range'
  labels: string[]
  bos: BosEvent | null
  nearestOb: OrderBlock | null
  nearestFvg: FairValueGap | null
  sweep: SweepEvent | null
  pools: LiquidityPool[]
  rangeCtx: RangeContext
  session: SessionInfo
  patterns: PatternHit[]
  wyckoff: WyckoffEvent
  deltaSlope: number             // normalized approx-delta slope (order-flow proxy)
  price: number
}

export function structureSnapshot(m15: Candle[], h1: Candle[] = []): StructureSnapshot {
  const swings = findSwings(m15)
  const struct = labelStructure(swings)
  const pools = liquidityPools(m15, swings)
  const obs = orderBlocks(m15)
  const fvgs = fairValueGaps(m15)
  const recent = m15.filter((c) => c.closed).slice(-20)
  const delta = recent.map(approxDelta)
  const deltaSlope = delta.length >= 2 ? (delta[delta.length - 1] - delta[0]) / (recent.reduce((a, c) => a + c.v, 0) || 1) : 0
  const price = m15.length ? m15[m15.length - 1].c : 0
  const nearest = <T extends { distPct: number }>(list: T[]) =>
    list.length ? list.reduce((a, b) => (Math.abs(b.distPct) < Math.abs(a.distPct) ? b : a)) : null
  return {
    trend: struct.trend,
    labels: struct.labels,
    bos: detectBosChoch(m15, swings),
    nearestOb: nearest(obs),
    nearestFvg: nearest(fvgs),
    sweep: detectSweep(m15, pools, swings),
    pools,
    rangeCtx: premiumDiscount(m15),
    session: sessionInfo(),
    patterns: candlePatterns(m15),
    wyckoff: wyckoffLite(m15),
    deltaSlope,
    price,
  }
}
