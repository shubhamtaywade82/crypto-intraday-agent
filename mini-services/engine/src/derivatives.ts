// ─── Perpetual-futures derivatives analytics ─────────────────────────────────
// The crypto-native alpha layer: funding-rate regimes, OI/price quadrant
// matrix, long/short ratio extremes, liquidation-cascade detection and
// perp-vs-spot basis. All functions are pure — data is fetched in binance.ts
// and passed in.

import { zscore, percentileRank } from './indicators'

// ── funding regime ───────────────────────────────────────────────────────────

export interface FundingRegime {
  current: number                 // e.g. 0.0001 = 0.01% per 8h
  z: number                       // z-score vs recent funding history
  pctile: number                  // percentile within history (0..1)
  annualizedPct: number           // ≈ current × 3 × 365
  label: 'extreme-positive' | 'rich' | 'neutral' | 'cheap' | 'extreme-negative'
  contrarianDir: -1 | 0 | 1       // fade crowded side at extremes
  note: string
}

/**
 * Funding regime from history of settled funding rates (8h cadence).
 * Extreme positive funding = crowded longs (bearish contrarian), and vice versa.
 */
export function fundingRegime(current: number, history: number[]): FundingRegime {
  const z = zscore(current, history)
  const pct = percentileRank(history, current)
  const annualized = current * 3 * 365 * 100
  let label: FundingRegime['label'] = 'neutral'
  let contrarianDir: -1 | 0 | 1 = 0
  if (current >= 0.0005 || z >= 2) { label = 'extreme-positive'; contrarianDir = -1 }
  else if (current >= 0.00025) { label = 'rich'; contrarianDir = -1 }
  else if (current <= -0.0005 || z <= -2) { label = 'extreme-negative'; contrarianDir = 1 }
  else if (current <= -0.00025) { label = 'cheap'; contrarianDir = 1 }
  return {
    current,
    z: Number(z.toFixed(2)),
    pctile: Number(pct.toFixed(2)),
    annualizedPct: Number(annualized.toFixed(1)),
    label,
    contrarianDir,
    note: `funding ${(current * 100).toFixed(4)}%/8h (z=${z.toFixed(1)}, pct ${(pct * 100).toFixed(0)}%) → ${label}`,
  }
}

// ── OI / price quadrant ──────────────────────────────────────────────────────

export interface OiQuadrant {
  label: 'new-longs' | 'new-shorts' | 'short-squeeze' | 'long-unwind' | 'flat' | 'unknown'
  dir: -1 | 0 | 1                 // directional tilt for signal blending
  note: string
}

/**
 * Open-interest × price quadrant:
 *   price↑ + OI↑ → new longs (healthy trend continuation, bullish)
 *   price↓ + OI↑ → new shorts (bearish momentum, bearish)
 *   price↑ + OI↓ → short squeeze / short covering (fuel exhausting, mildly bullish)
 *   price↓ + OI↓ → long unwind (capitulation, can snap back violently)
 */
export function oiPriceQuadrant(priceChgPct: number | null, oiChgPct: number | null): OiQuadrant {
  if (priceChgPct === null || oiChgPct === null) return { label: 'unknown', dir: 0, note: 'OI data unavailable' }
  const p = priceChgPct
  const o = oiChgPct
  if (Math.abs(o) < 0.15 && Math.abs(p) < 0.15) return { label: 'flat', dir: 0, note: `OI ${o.toFixed(2)}% / px ${p.toFixed(2)}% — flat` }
  if (p > 0 && o > 0) return { label: 'new-longs', dir: 1, note: `price +${p.toFixed(2)}% with OI +${o.toFixed(2)}% — new longs, trend supported` }
  if (p < 0 && o > 0) return { label: 'new-shorts', dir: -1, note: `price ${p.toFixed(2)}% with OI +${o.toFixed(2)}% — new shorts, momentum real` }
  if (p > 0 && o < 0) return { label: 'short-squeeze', dir: 1, note: `price +${p.toFixed(2)}% on OI ${o.toFixed(2)}% — short covering, fuel depleting` }
  return { label: 'long-unwind', dir: -1, note: `price ${p.toFixed(2)}% on OI ${o.toFixed(2)}% — long unwind / capitulation` }
}

// ── long/short ratio ─────────────────────────────────────────────────────────

export interface LsRatioInput {
  global?: number | null          // global accounts long/short ratio
  topTrader?: number | null       // top-trader position ratio
  taker?: number | null           // taker buy/sell volume ratio
}

export interface LsAnalysis {
  crowd: 'crowded-long' | 'long-lean' | 'balanced' | 'short-lean' | 'crowded-short'
  contrarianDir: -1 | 0 | 1
  score: number                   // -1..1 (contrarian tilt)
  note: string
}

/**
 * Crowd positioning from Binance long/short ratios — contrarian at extremes.
 * When retail is 80% long, there is nobody left to buy and a long squeeze is
 * cheap; the mirror image applies to crowded shorts.
 */
export function lsRatioAnalysis(input: LsRatioInput): LsAnalysis {
  const vals: string[] = []
  let score = 0
  const add = (name: string, v: number | null | undefined) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return
    vals.push(`${name}=${v.toFixed(2)}`)
    // ratio > 2 → crowd heavily long; < 0.5 → heavily short
    score += Math.max(-0.5, Math.min(0.5, -(v - 1) / 2)) // contrarian sign flip
  }
  add('global', input.global)
  add('top', input.topTrader)
  add('taker', input.taker)
  score = Math.max(-1, Math.min(1, score))
  let crowd: LsAnalysis['crowd'] = 'balanced'
  if (score <= -0.5) crowd = 'crowded-long'
  else if (score <= -0.2) crowd = 'long-lean'
  else if (score >= 0.5) crowd = 'crowded-short'
  else if (score >= 0.2) crowd = 'short-lean'
  const dir: -1 | 0 | 1 = score <= -0.5 ? -1 : score >= 0.5 ? 1 : 0
  return {
    crowd,
    contrarianDir: dir,
    score: Number(score.toFixed(3)),
    note: vals.length ? `${vals.join(' ')} → ${crowd.replace('-', ' ')}` : 'ratio data unavailable',
  }
}

// ── liquidations ─────────────────────────────────────────────────────────────

export interface LiquidationEvent {
  ts: number
  symbol: string
  side: 'LONG' | 'SHORT'   // the side that got liquidated
  price: number
  qty: number
  notionalUsd: number
}

export interface LiquidationAnalytics {
  longUsd: number                 // liquidated long notional in window
  shortUsd: number
  netUsd: number                  // longUsd - shortUsd (negative = longs rekt)
  totalUsd: number
  cascade: boolean                // one-sided cluster → cascade signature
  dir: -1 | 0 | 1                 // post-cascade snapback bias (fade the wipe-out)
  intensity: number               // totalUsd vs baseline (0..1+)
  note: string
}

/**
 * Liquidation analytics over a rolling window (typically 1h).
 * A one-sided liquidation cluster (cascade) is exhaustion: after longs are
 * force-wiped, the snapback trade is up, and vice versa.
 */
export function liquidationAnalytics(events: LiquidationEvent[], baselineUsd = 250_000): LiquidationAnalytics {
  const longUsd = events.filter((e) => e.side === 'LONG').reduce((a, e) => a + e.notionalUsd, 0)
  const shortUsd = events.filter((e) => e.side === 'SHORT').reduce((a, e) => a + e.notionalUsd, 0)
  const totalUsd = longUsd + shortUsd
  const netUsd = longUsd - shortUsd
  const oneSided = totalUsd > 0 ? Math.abs(netUsd) / totalUsd : 0
  const cascade = totalUsd > baselineUsd * 2 && oneSided > 0.7
  // netUsd > 0 means more long notional liquidated → sell-side cascade → snapback bias is UP
  const dir: -1 | 0 | 1 = cascade ? (netUsd > 0 ? 1 : -1) : 0
  return {
    longUsd: Number(longUsd.toFixed(0)),
    shortUsd: Number(shortUsd.toFixed(0)),
    netUsd: Number(netUsd.toFixed(0)),
    totalUsd: Number(totalUsd.toFixed(0)),
    cascade,
    dir,
    intensity: Number(Math.min(1, totalUsd / (baselineUsd * 4)).toFixed(2)),
    note: cascade
      ? `LIQUIDATION CASCADE: ${netUsd > 0 ? 'longs' : 'shorts'} rekt $${(totalUsd / 1000).toFixed(0)}k — snapback watch`
      : totalUsd > 0
        ? `liqs 1h: $${(longUsd / 1000).toFixed(0)}k L / $${(shortUsd / 1000).toFixed(0)}k S`
        : 'no liquidations in window',
  }
}

// ── basis ────────────────────────────────────────────────────────────────────

export interface BasisAnalysis { basisPct: number; label: string; note: string }

/**
 * Perp-vs-spot basis (perp premium). Persistently rich basis = leveraged
 * demand; deep discount = deleveraging fear. Also flags forced-liquidation
 * wick risk when |basis| is large (mark price deviating from index).
 */
export function basisAnalysis(perpPrice: number, spotRef: number | null): BasisAnalysis {
  if (!spotRef || !perpPrice) return { basisPct: 0, label: 'n/a', note: 'spot reference unavailable' }
  const b = ((perpPrice - spotRef) / spotRef) * 100
  const label = b > 0.15 ? 'rich' : b > 0.05 ? 'warm' : b < -0.15 ? 'discount' : b < -0.05 ? 'soft' : 'neutral'
  return {
    basisPct: Number(b.toFixed(3)),
    label,
    note: `perp ${b >= 0 ? '+' : ''}${b.toFixed(3)}% vs spot (${label})`,
  }
}

// ── combined derivatives score ───────────────────────────────────────────────

export interface DerivativesContext {
  funding: FundingRegime
  oi: OiQuadrant
  ls: LsAnalysis
  liq: LiquidationAnalytics
  basis: BasisAnalysis
}

export interface DerivativesVote {
  score: number                   // -1..1 (positive = bullish evidence)
  notes: string[]
}

/**
 * Blend all derivatives signals into one vote. These inputs are the
 * crypto-native edge — they dominate when they agree with price action.
 */
export function derivativesVote(ctx: DerivativesContext): DerivativesVote {
  let score = 0
  const notes: string[] = []
  // funding extremes: contrarian weight
  if (ctx.funding.contrarianDir !== 0) {
    score += ctx.funding.contrarianDir * (ctx.funding.label.startsWith('extreme') ? 0.35 : 0.15)
    notes.push(ctx.funding.note)
  }
  // OI quadrant: trend-confirmation weight
  if (ctx.oi.dir !== 0) {
    score += ctx.oi.dir * 0.25
    notes.push(ctx.oi.note)
  }
  // crowd positioning
  if (ctx.ls.contrarianDir !== 0) {
    score += ctx.ls.contrarianDir * (Math.abs(ctx.ls.score) >= 0.5 ? 0.25 : 0.1)
    notes.push(ctx.ls.note)
  }
  // liquidation cascade snapback
  if (ctx.liq.cascade) {
    score += ctx.liq.dir * 0.35
    notes.push(ctx.liq.note)
  } else if (ctx.liq.intensity > 0.3) {
    score += ctx.liq.dir * 0.1
    notes.push(ctx.liq.note)
  }
  // basis tilt
  if (ctx.basis.label === 'discount') { score += 0.1; notes.push(ctx.basis.note) }
  if (ctx.basis.label === 'rich') { score -= 0.1; notes.push(ctx.basis.note) }
  return { score: Number(Math.max(-1, Math.min(1, score)).toFixed(3)), notes }
}
