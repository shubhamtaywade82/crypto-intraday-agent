// ─── Confluence engine — regime gate, five-stack voting, setup library ───────
// The heart of the extended signal layer. Every strategy family feeds evidence
// into five stacks (trend / momentum / volume / derivatives / structure); the
// engine scores agreement, tags the market regime, and matches named setups
// from the intraday playbook. A trade needs ≥3 agreeing stacks in a regime
// that permits the setup class.

import type { Candle } from './types'
import {
  ema, rsi, macd, stochastic, adx, superTrend, vwap, obv, mfi, linregSlope,
  bollinger, squeeze, atr, cvdSlope, divergence, percentileRank, type AdxSnapshot,
} from './indicators'
import type { StructureSnapshot } from './structure'
import type { DerivativesContext, DerivativesVote } from './derivatives'
import { derivativesVote } from './derivatives'

// ── regime detection (HMM-lite: deterministic statistical classifier) ────────

export type Regime = 'trend-up' | 'trend-down' | 'range' | 'volatile' | 'quiet'

export interface RegimeInfo {
  regime: Regime
  adx: number
  bbWidthPctile: number
  note: string
  /** which setup classes are permitted in this regime */
  permits: Array<'trend' | 'reversion' | 'breakout' | 'sweep-reversal'>
}

/**
 * Regime classifier: ADX (trend strength) × BB-width percentile (volatility
 * state) × EMA slope (direction). Deterministic stand-in for an HMM — the
 * same features a hidden-state model would consume, without the fit risk.
 */
export function detectRegime(m15: Candle[]): RegimeInfo {
  const closed = m15.filter((c) => c.closed)
  if (closed.length < 60) {
    return { regime: 'quiet', adx: 0, bbWidthPctile: 0.5, note: 'insufficient history', permits: [] }
  }
  const closes = closed.map((c) => c.c)
  const adxSnap: AdxSnapshot = adx(closed, 14)
  const sq = squeeze(closes, closed, 100)
  const e50 = ema(closes, 50)
  const slope = linregSlope(e50.slice(-20), 20)
  const bb = bollinger(closes, 20, 2)
  let regime: Regime
  if (sq.bbWidthPctile > 0.85 && Math.abs(adxSnap.adx) > 25) regime = 'volatile'
  else if (adxSnap.adx >= 25) regime = slope > 0 ? 'trend-up' : 'trend-down'
  else if (sq.bbWidthPctile < 0.25) regime = 'quiet'
  else regime = 'range'
  const permits: RegimeInfo['permits'] =
    regime === 'trend-up' || regime === 'trend-down' ? ['trend', 'sweep-reversal', 'breakout']
    : regime === 'range' ? ['reversion', 'sweep-reversal', 'breakout']
    : regime === 'volatile' ? ['breakout', 'sweep-reversal']
    : ['reversion']
  const note = `${regime} (ADX ${adxSnap.adx.toFixed(0)}, BBw pct ${(sq.bbWidthPctile * 100).toFixed(0)}%, EMA50 slope ${(slope * 100).toFixed(3)}%/bar, width ${(bb.width * 100).toFixed(2)}%)`
  return { regime, adx: Number(adxSnap.adx.toFixed(1)), bbWidthPctile: Number(sq.bbWidthPctile.toFixed(2)), note, permits }
}

// ── five-stack voting ────────────────────────────────────────────────────────

export interface StackVote {
  name: 'trend' | 'momentum' | 'volume' | 'derivatives' | 'structure'
  dir: -1 | 0 | 1
  score: number        // -1..1
  notes: string[]
}

export interface StackInputs {
  m15: Candle[]
  h1: Candle[]
  structure: StructureSnapshot
  derivatives: DerivativesContext
}

function trendStack(inp: StackInputs): StackVote {
  const closed = inp.m15.filter((c) => c.closed)
  const h1 = inp.h1.filter((c) => c.closed)
  const notes: string[] = []
  let score = 0
  if (closed.length > 60) {
    const closes = closed.map((c) => c.c)
    const price = closes[closes.length - 1]
    const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50)
    const n = closes.length - 1
    if (e9[n] > e21[n]) { score += 0.25; notes.push('EMA9>21') } else { score -= 0.25; notes.push('EMA9<21') }
    if (e21[n] > e50[n]) { score += 0.2; notes.push('EMA21>50') } else { score -= 0.2; notes.push('EMA21<50') }
    const st = superTrend(closed, 10, 3)
    score += st.dir * 0.2
    notes.push(`SuperTrend ${st.dir > 0 ? 'up' : 'down'}`)
    const vw = vwap(closed, 96)
    if (price > vw.vwap) { score += 0.15; notes.push('above VWAP') } else { score -= 0.15; notes.push('below VWAP') }
    if (price > vw.upper) { score += 0.1; notes.push('>VWAP+1σ (stretched)') }
    if (price < vw.lower) { score -= 0.1; notes.push('<VWAP−1σ (stretched)') }
  }
  if (h1.length > 55) {
    const hc = h1.map((c) => c.c)
    const he = ema(hc, 50)
    const price = hc[hc.length - 1]
    if (price > he[he.length - 1]) { score += 0.2; notes.push('1h above EMA50') } else { score -= 0.2; notes.push('1h below EMA50') }
  }
  score = Math.max(-1, Math.min(1, score))
  return { name: 'trend', dir: score > 0.15 ? 1 : score < -0.15 ? -1 : 0, score: Number(score.toFixed(3)), notes }
}

function momentumStack(inp: StackInputs): StackVote {
  const closed = inp.m15.filter((c) => c.closed)
  const notes: string[] = []
  if (closed.length < 40) return { name: 'momentum', dir: 0, score: 0, notes: ['insufficient history'] }
  const closes = closed.map((c) => c.c)
  let score = 0
  const r14 = rsi(closes, 14)
  const r = r14[r14.length - 1]
  if (r > 55) { score += 0.25; notes.push(`RSI ${r.toFixed(0)} bullish`) }
  else if (r < 45) { score -= 0.25; notes.push(`RSI ${r.toFixed(0)} bearish`) }
  else notes.push(`RSI ${r.toFixed(0)} neutral`)
  const m = macd(closes)
  score += m.hist > 0 ? 0.2 : m.hist < 0 ? -0.2 : 0
  score += m.histSlope > 0 ? 0.1 : m.histSlope < 0 ? -0.1 : 0
  notes.push(`MACD hist ${m.hist >= 0 ? '+' : ''}${m.hist.toPrecision(3)} ${m.histSlope > 0 ? 'rising' : 'falling'}`)
  const st = stochastic(closed)
  if (st.k < 20) { score += 0.15; notes.push(`Stoch ${st.k.toFixed(0)} oversold`) }
  else if (st.k > 80) { score -= 0.15; notes.push(`Stoch ${st.k.toFixed(0)} overbought`) }
  const div = divergence(closed, r14)
  if (div.type === 'regular-bull') { score += 0.3 * div.strength; notes.push('RSI regular bullish divergence') }
  if (div.type === 'regular-bear') { score -= 0.3 * div.strength; notes.push('RSI regular bearish divergence') }
  if (div.type === 'hidden-bull') { score += 0.15; notes.push('hidden bullish divergence') }
  if (div.type === 'hidden-bear') { score -= 0.15; notes.push('hidden bearish divergence') }
  score = Math.max(-1, Math.min(1, score))
  return { name: 'momentum', dir: score > 0.15 ? 1 : score < -0.15 ? -1 : 0, score: Number(score.toFixed(3)), notes }
}

function volumeStack(inp: StackInputs): StackVote {
  const closed = inp.m15.filter((c) => c.closed)
  const notes: string[] = []
  if (closed.length < 40) return { name: 'volume', dir: 0, score: 0, notes: ['insufficient history'] }
  let score = 0
  const obvSlope = linregSlope(obv(closed).slice(-20), 20)
  score += Math.max(-0.3, Math.min(0.3, obvSlope * 10))
  notes.push(`OBV slope ${obvSlope >= 0 ? '+' : ''}${(obvSlope * 100).toFixed(2)}%/bar`)
  const m = mfi(closed, 14)
  if (m > 60) { score += 0.2; notes.push(`MFI ${m.toFixed(0)} inflow`) }
  else if (m < 40) { score -= 0.2; notes.push(`MFI ${m.toFixed(0)} outflow`) }
  const cvd = cvdSlope(closed, 20)
  score += Math.max(-0.3, Math.min(0.3, cvd))
  notes.push(`CVD slope ${cvd >= 0 ? '+' : ''}${cvd.toFixed(2)}`)
  const avgV = closed.slice(-21, -1).reduce((a, c) => a + c.v, 0) / 20 || 1
  const lastV = closed[closed.length - 1].v
  if (lastV > avgV * 1.5) { notes.push(`vol ×${(lastV / avgV).toFixed(1)} expansion`) }
  score = Math.max(-1, Math.min(1, score))
  return { name: 'volume', dir: score > 0.12 ? 1 : score < -0.12 ? -1 : 0, score: Number(score.toFixed(3)), notes }
}

function derivativesStack(vote: DerivativesVote): StackVote {
  return {
    name: 'derivatives',
    dir: vote.score > 0.15 ? 1 : vote.score < -0.15 ? -1 : 0,
    score: vote.score,
    notes: vote.notes.length ? vote.notes : ['no derivatives signal'],
  }
}

function structureStack(s: StructureSnapshot): StackVote {
  const notes: string[] = []
  let score = 0
  if (s.trend === 'up') { score += 0.25; notes.push('structure up (HH/HL)') }
  else if (s.trend === 'down') { score -= 0.25; notes.push('structure down (LH/LL)') }
  if (s.bos) {
    score += s.bos.dir * (s.bos.kind === 'CHoCH' ? 0.3 : 0.25)
    notes.push(`${s.bos.kind} ${s.bos.dir > 0 ? 'bullish' : 'bearish'} ${s.bos.barsAgo} bars ago`)
  }
  if (s.sweep) {
    score += s.sweep.dir * 0.25
    notes.push(`liquidity sweep ${s.sweep.dir > 0 ? 'of lows (bullish)' : 'of highs (bearish)'} ${s.sweep.barsAgo} bars ago`)
  }
  if (s.nearestOb && Math.abs(s.nearestOb.distPct) < 1.5) {
    score += s.nearestOb.dir * 0.2
    notes.push(`price at ${s.nearestOb.dir > 0 ? 'bullish' : 'bearish'} OB (${s.nearestOb.distPct.toFixed(2)}% away)`)
  }
  if (s.nearestFvg && Math.abs(s.nearestFvg.distPct) < 1) {
    score += s.nearestFvg.dir * 0.15
    notes.push(`near ${s.nearestFvg.dir > 0 ? 'bullish' : 'bearish'} FVG`)
  }
  if (s.wyckoff.name) {
    score += s.wyckoff.dir * 0.25
    notes.push(`Wyckoff ${s.wyckoff.name}`)
  }
  if (Math.abs(s.deltaSlope) > 0.05) {
    score += Math.max(-0.15, Math.min(0.15, s.deltaSlope))
    notes.push(`delta ${s.deltaSlope > 0 ? 'buy' : 'sell'} pressure`)
  }
  score = Math.max(-1, Math.min(1, score))
  return { name: 'structure', dir: score > 0.15 ? 1 : score < -0.15 ? -1 : 0, score: Number(score.toFixed(3)), notes }
}

// ── confluence score ─────────────────────────────────────────────────────────

export interface ConfluenceResult {
  score: number                       // -1..1
  dir: -1 | 0 | 1
  agreement: number                   // # stacks agreeing with the majority
  stacks: StackVote[]
  regime: RegimeInfo
  regimeAligned: boolean              // majority direction permitted by regime
  reasons: string[]
}

export function computeConfluence(inp: StackInputs): ConfluenceResult {
  const regime = detectRegime(inp.m15)
  const stacks = [
    trendStack(inp),
    momentumStack(inp),
    volumeStack(inp),
    derivativesStack(derivativesVote(inp.derivatives)),
    structureStack(inp.structure),
  ]
  const bull = stacks.filter((s) => s.dir === 1).length
  const bear = stacks.filter((s) => s.dir === -1).length
  const majority: -1 | 0 | 1 = bull > bear ? 1 : bear > bull ? -1 : 0
  const agreement = Math.max(bull, bear)
  // weighted score: mean of stack scores + agreement bonus when ≥3 agree
  const mean = stacks.reduce((a, s) => a + s.score, 0) / stacks.length
  let score = mean
  if (agreement >= 3 && majority !== 0) score += majority * 0.1
  if (agreement >= 4 && majority !== 0) score += majority * 0.1
  // conflict penalty: strong opposing stack (>0.5 magnitude against majority)
  if (majority !== 0) {
    for (const s of stacks) {
      if (s.dir !== 0 && s.dir !== majority && Math.abs(s.score) > 0.5) score -= majority * 0.08
    }
  }
  // regime gate: is the setup class permitted?
  const dirIsTrendish = majority !== 0
  const regimeAligned = !dirIsTrendish
    || (regime.permits.includes('trend') && Math.abs(mean) > 0.15)
    || (regime.permits.includes('reversion') && Math.abs(mean) <= 0.15)
    || regime.permits.includes('breakout')
    || regime.permits.includes('sweep-reversal')
  if (!regimeAligned) score *= 0.6
  score = Math.max(-1, Math.min(1, score))
  const reasons = [
    `regime ${regime.regime}`,
    ...stacks.filter((s) => s.dir !== 0).map((s) => `${s.name}:${s.dir > 0 ? '+' : ''}${s.score}`),
  ]
  return {
    score: Number(score.toFixed(3)),
    dir: score > 0.15 ? 1 : score < -0.15 ? -1 : 0,
    agreement,
    stacks,
    regime,
    regimeAligned,
    reasons,
  }
}

// ── named setup library (intraday playbook) ─────────────────────────────────

export interface SetupHit {
  name: string
  class: 'trend' | 'reversion' | 'breakout' | 'sweep-reversal'
  dir: -1 | 0 | 1
  strength: number        // 0..1
  note: string
}

interface SetupCtx {
  m15: Candle[]
  m5: Candle[]
  h1: Candle[]
  structure: StructureSnapshot
  derivatives: DerivativesContext
  confluence: ConfluenceResult
}

/** 1. London sweep & reverse — sweep of Asia range + reclaim + CHoCH up. */
function setupLondonSweep(ctx: SetupCtx): SetupHit {
  const s = ctx.structure
  const asia = s.rangeCtx
  const inLondon = s.session.session === 'london'
  const swept = s.sweep
  if (inLondon && swept && s.bos && s.bos.kind === 'CHoCH' && s.bos.dir === swept.dir) {
    return { name: 'london-sweep-reversal', class: 'sweep-reversal', dir: swept.dir, strength: 0.85, note: `London ${swept.dir > 0 ? 'sweep of lows' : 'sweep of highs'} + CHoCH confirms (${asia.zone} zone)` }
  }
  if (swept && s.bos && s.bos.kind === 'CHoCH' && s.bos.dir === swept.dir) {
    return { name: 'sweep-choch-reversal', class: 'sweep-reversal', dir: swept.dir, strength: 0.7, note: `sweep + CHoCH alignment (${s.session.session} session)` }
  }
  return { name: 'london-sweep-reversal', class: 'sweep-reversal', dir: 0, strength: 0, note: 'no sweep+CHoCH sequence' }
}

/** 2. VWAP 2σ mean reversion — stretched from VWAP in a range regime. */
function setupVwapReversion(ctx: SetupCtx): SetupHit {
  const closed = ctx.m15.filter((c) => c.closed)
  if (closed.length < 40) return { name: 'vwap-reversion', class: 'reversion', dir: 0, strength: 0, note: 'insufficient history' }
  const vw = vwap(closed, 96)
  const price = closed[closed.length - 1].c
  const regime = ctx.confluence.regime
  const r14 = rsi(closed.map((c) => c.c), 14)
  const r = r14[r14.length - 1]
  if (regime.regime === 'range' || regime.regime === 'quiet') {
    if (price < vw.lower - (vw.upper - vw.lower) * 0.2 && r < 40) {
      return { name: 'vwap-reversion', class: 'reversion', dir: 1, strength: 0.7, note: `price below VWAP−2σ, RSI ${r.toFixed(0)} — reversion target VWAP ${vw.vwap.toPrecision(6)}` }
    }
    if (price > vw.upper + (vw.upper - vw.lower) * 0.2 && r > 60) {
      return { name: 'vwap-reversion', class: 'reversion', dir: -1, strength: 0.7, note: `price above VWAP+2σ, RSI ${r.toFixed(0)} — reversion target VWAP ${vw.vwap.toPrecision(6)}` }
    }
  }
  return { name: 'vwap-reversion', class: 'reversion', dir: 0, strength: 0, note: 'not stretched from VWAP' }
}

/** 3. Squeeze breakout — BB-inside-KC coil, fired with impulse + volume. */
function setupSqueezeBreakout(ctx: SetupCtx): SetupHit {
  const closed = ctx.m15.filter((c) => c.closed)
  if (closed.length < 60) return { name: 'squeeze-breakout', class: 'breakout', dir: 0, strength: 0, note: 'insufficient history' }
  const closes = closed.map((c) => c.c)
  const sq = squeeze(closes, closed, 100)
  if (sq.fired) {
    const volAvg = closed.slice(-21, -1).reduce((a, c) => a + c.v, 0) / 20 || 1
    const vLast = closed[closed.length - 1].v
    const volOk = vLast > volAvg * 1.3
    return { name: 'squeeze-breakout', class: 'breakout', dir: sq.fired === 'up' ? 1 : -1, strength: volOk ? 0.8 : 0.55, note: `squeeze fired ${sq.fired}${volOk ? ' with volume expansion' : ' (weak volume)'}` }
  }
  if (sq.squeezing) {
    return { name: 'squeeze-breakout', class: 'breakout', dir: 0, strength: 0, note: `coiling (BBw pct ${(sq.bbWidthPctile * 100).toFixed(0)}) — breakout pending` }
  }
  return { name: 'squeeze-breakout', class: 'breakout', dir: 0, strength: 0, note: 'no coil' }
}

/** 4. OB + confluence tap — price taps a fresh OB aligned with regime/derivatives. */
function setupObTap(ctx: SetupCtx): SetupHit {
  const s = ctx.structure
  const ob = s.nearestOb
  if (ob && Math.abs(ob.distPct) < 1.2) {
    const aligned = ctx.confluence.stacks.find((x) => x.name === 'derivatives')
    const agree = (aligned?.dir ?? 0) === ob.dir || (ctx.confluence.regime.regime === 'trend-up' && ob.dir === 1) || (ctx.confluence.regime.regime === 'trend-down' && ob.dir === -1)
    const inDiscount = ob.dir === 1 && s.rangeCtx.positionPct < 0.5
    const inPremium = ob.dir === -1 && s.rangeCtx.positionPct > 0.5
    if (agree || inDiscount || inPremium) {
      return { name: 'ob-confluence-tap', class: 'trend', dir: ob.dir, strength: 0.65, note: `${ob.dir > 0 ? 'bullish' : 'bearish'} OB tap (${ob.distPct.toFixed(2)}%), ${s.rangeCtx.zone} zone, derivatives ${aligned?.dir === ob.dir ? 'aligned' : 'neutral'}` }
    }
    return { name: 'ob-confluence-tap', class: 'trend', dir: ob.dir, strength: 0.4, note: `OB tap but weak confluence (${s.rangeCtx.zone})` }
  }
  return { name: 'ob-confluence-tap', class: 'trend', dir: 0, strength: 0, note: 'no OB proximity' }
}

/** 5. Funding flip continuation — trend intact, funding resets toward neutral. */
function setupFundingFlip(ctx: SetupCtx): SetupHit {
  const trendStack = ctx.confluence.stacks.find((x) => x.name === 'trend')
  const f = ctx.derivatives.funding
  if (trendStack && Math.abs(trendStack.score) > 0.4 && f.label === 'neutral') {
    const dir = trendStack.dir || (trendStack.score > 0 ? 1 : -1)
    const oi = ctx.derivatives.oi
    if (oi.dir === dir || oi.dir === 0) {
      return { name: 'funding-flip-continuation', class: 'trend', dir, strength: 0.6, note: `trend stack ${trendStack.score}, funding neutral (${(f.current * 100).toFixed(4)}%) — not crowded, continuation room` }
    }
  }
  return { name: 'funding-flip-continuation', class: 'trend', dir: 0, strength: 0, note: 'no healthy-trend + neutral-funding combo' }
}

/** 6. Post-cascade snapback — liquidation cascade exhausts, structure reclaims. */
function setupCascadeSnapback(ctx: SetupCtx): SetupHit {
  const liq = ctx.derivatives.liq
  if (liq.cascade) {
    const reclaim = ctx.structure.bos && ctx.structure.bos.dir === liq.dir ? ' + BOS reclaim' : ''
    return { name: 'cascade-snapback', class: 'sweep-reversal', dir: liq.dir, strength: reclaim ? 0.8 : 0.6, note: `${liq.note}${reclaim}` }
  }
  return { name: 'cascade-snapback', class: 'sweep-reversal', dir: 0, strength: 0, note: 'no liquidation cascade' }
}

/** 7. NY continuation — London trend holds a 50% retrace into the NY kill zone. */
function setupNyContinuation(ctx: SetupCtx): SetupHit {
  const s = ctx.structure
  const trendStack = ctx.confluence.stacks.find((x) => x.name === 'trend')
  if (s.session.session === 'newyork' && trendStack && trendStack.dir !== 0) {
    const range = s.rangeCtx
    const midRetrace = range.positionPct > 0.35 && range.positionPct < 0.65
    if (midRetrace) {
      return { name: 'ny-continuation', class: 'trend', dir: trendStack.dir, strength: 0.55, note: `NY session, trend ${trendStack.dir > 0 ? 'up' : 'down'}, price at mid-range retrace (${(range.positionPct * 100).toFixed(0)}%)` }
    }
  }
  return { name: 'ny-continuation', class: 'trend', dir: 0, strength: 0, note: 'no NY continuation window' }
}

/** 8. Breaker retest — swept OB flips polarity, price retests it. */
function setupBreakerRetest(ctx: SetupCtx): SetupHit {
  const s = ctx.structure
  const ob = s.nearestOb
  const swept = s.sweep
  if (ob && swept && swept.barsAgo <= 6 && ob.dir === swept.dir) {
    return { name: 'breaker-retest', class: 'sweep-reversal', dir: swept.dir, strength: 0.6, note: `sweep ${swept.barsAgo} bars ago, retesting ${ob.dir > 0 ? 'bullish' : 'bearish'} breaker zone` }
  }
  return { name: 'breaker-retest', class: 'sweep-reversal', dir: 0, strength: 0, note: 'no breaker sequence' }
}

/** Evaluate the full playbook for one symbol. */
export function matchSetups(ctx: SetupCtx): SetupHit[] {
  return [
    setupLondonSweep(ctx),
    setupVwapReversion(ctx),
    setupSqueezeBreakout(ctx),
    setupObTap(ctx),
    setupFundingFlip(ctx),
    setupCascadeSnapback(ctx),
    setupNyContinuation(ctx),
    setupBreakerRetest(ctx),
  ]
}
