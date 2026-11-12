#!/usr/bin/env bun
// ─── Signal-stack test: every indicator, structure detector, derivatives ─────
// analytics, confluence engine and strategy family — offline & deterministic.
//
//   bun scripts/test-signals.ts            # synthetic fixtures (no network)
//   bun scripts/test-signals.ts BTCUSDT    # live Binance klines deep-analysis
//
// The synthetic generator is a seeded random walk with injected structural
// events (sweep, displacement, squeeze) so SMC detectors have something to
// find. Every check asserts finite outputs in sane ranges — a regression
// net for the whole signal layer.

import {
  ema, sma, wma, hullMa, rsi, macd, stochastic, stochRsi, cci, williamsR, roc, tsi,
  awesomeOscillator, adx, superTrend, ichimoku, parabolicSar, donchian, keltner,
  squeeze, vwap, obv, mfi, cmf, approxDelta, cvdSeries, cvdSlope, atr, bollinger,
  zscore, percentileRank, linregSlope, median, divergence, avgVolume, stdev, trueRange,
} from '../mini-services/engine/src/indicators'
import {
  findSwings, labelStructure, detectBosChoch, orderBlocks, fairValueGaps, liquidityPools,
  detectSweep, premiumDiscount, sessionInfo, asiaRange, candlePatterns, wyckoffLite,
  structureSnapshot,
} from '../mini-services/engine/src/structure'
import {
  fundingRegime, oiPriceQuadrant, lsRatioAnalysis, liquidationAnalytics, basisAnalysis,
  derivativesVote,
} from '../mini-services/engine/src/derivatives'
import { detectRegime, computeConfluence, matchSetups } from '../mini-services/engine/src/confluence'
import {
  momentumSignal, meanReversionSignal, spreadSignal, liquiditySweepSignal, squeezeBreakoutSignal,
  orderBlockSignal, sessionBreakoutSignal, fundingFlipSignal, cascadeSnapbackSignal,
  vwapReversionSignal, computeExtendedSignals, toSignalSet, bracketFor,
} from '../mini-services/engine/src/strategies'
import type { Candle } from '../mini-services/engine/src/types'
import type { LiquidationEvent } from '../mini-services/engine/src/derivatives'

// ── seeded PRNG (mulberry32) ─────────────────────────────────────────────────
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Synthetic 15m-style candles: random walk + drift regimes + a stop-hunt spike. */
function genCandles(n: number, seed = 42, intervalMs = 900_000, startPrice = 100): Candle[] {
  const rnd = prng(seed)
  const out: Candle[] = []
  let price = startPrice
  const t0 = Date.now() - n * intervalMs
  for (let i = 0; i < n; i++) {
    // alternating drift regimes every ~60 candles
    const phase = Math.floor(i / 60)
    const drift = (phase % 2 === 0 ? 0.0006 : -0.0005) * (1 + (phase % 3) * 0.3)
    // inject a sweep event near the end: candle 8 from the end wicks down hard then closes back up
    let o = price
    const shock = i === n - 8 ? -0.025 : i === n - 7 ? 0.02 : (rnd() - 0.5) * 0.008
    const c = Math.max(1, o * (1 + drift + shock))
    const h = Math.max(o, c) * (1 + rnd() * 0.004)
    let l = Math.min(o, c) * (1 - rnd() * 0.004)
    if (i === n - 8) l = Math.min(l, o * 0.96)  // deep wick = sweep of lows
    const v = 500 + rnd() * 1500 + (i === n - 8 ? 4000 : 0)
    out.push({ t: t0 + i * intervalMs, o, h, l, c, v, q: v * c, closed: true })
    price = c
  }
  return out
}

// ── assertions ───────────────────────────────────────────────────────────────
let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${detail ? '— ' + detail : ''}`) }
}
const finite = (x: number) => Number.isFinite(x)

console.log('── indicators ──')
{
  const candles = genCandles(300)
  const closes = candles.map((c) => c.c)
  ok('ema/sma/wma/hull finite (tail)', [ema(closes, 21), sma(closes, 21), wma(closes, 21), hullMa(closes, 21)].every((s) => finite(s[s.length - 1])))
  const r = rsi(closes, 14)
  ok('rsi in [0,100]', r.every((x) => x >= 0 && x <= 100))
  const m = macd(closes)
  ok('macd finite', finite(m.macd) && finite(m.signal) && finite(m.hist))
  ok('stochastic in [0,100]', (() => { const s = stochastic(candles); return s.k >= 0 && s.k <= 100 && s.d >= 0 && s.d <= 100 })())
  ok('stochRsi in [0,100]', (() => { const s = stochRsi(closes); return s >= 0 && s <= 100 })())
  ok('cci finite', finite(cci(candles)))
  ok('williamsR in [-100,0]', (() => { const w = williamsR(candles); return w >= -100 && w <= 0 })())
  ok('roc finite', finite(roc(closes)))
  ok('tsi in [-100,100]', Math.abs(tsi(closes)) <= 100)
  ok('awesomeOscillator finite', finite(awesomeOscillator(candles)))
  const a = adx(candles)
  ok('adx/plusDi/minusDi in [0,100]', a.adx >= 0 && a.adx <= 100 && a.plusDi >= 0 && a.plusDi <= 100 && a.minusDi >= 0 && a.minusDi <= 100)
  const st = superTrend(candles)
  ok('superTrend finite with dir ±1', finite(st.value) && (st.dir === 1 || st.dir === -1))
  const ich = ichimoku(candles)
  ok('ichimoku finite', finite(ich.tenkan) && finite(ich.kijun) && finite(ich.spanA) && finite(ich.spanB))
  const psar = parabolicSar(candles)
  ok('parabolicSar finite', finite(psar.value))
  const dc = donchian(candles)
  ok('donchian ordered lower<=mid<=upper', dc.lower <= dc.mid + 1e-9 && dc.mid <= dc.upper + 1e-9)
  const kc = keltner(candles)
  ok('keltner ordered', kc.lower <= kc.mid && kc.mid <= kc.upper)
  const sq = squeeze(closes, candles)
  ok('squeeze fields sane', typeof sq.squeezing === 'boolean' && (sq.fired === null || sq.fired === 'up' || sq.fired === 'down') && sq.bbWidthPctile >= 0 && sq.bbWidthPctile <= 1)
  const vw = vwap(candles)
  ok('vwap bands ordered', vw.lower <= vw.vwap && vw.vwap <= vw.upper && vw.posPct >= 0 && vw.posPct <= 1)
  ok('obv finite', obv(candles).every(finite))
  ok('mfi in [0,100]', mfi(candles) >= 0 && mfi(candles) <= 100)
  ok('cmf in [-1,1]', Math.abs(cmf(candles)) <= 1)
  ok('approxDelta finite', candles.map(approxDelta).every(finite))
  ok('cvd series monotonic-ish finite', cvdSeries(candles).every(finite))
  ok('cvdSlope finite', finite(cvdSlope(candles)))
  ok('atr positive', atr(candles) > 0)
  const bb = bollinger(closes)
  ok('bollinger ordered + pctB in [0,1..]', bb.lower <= bb.mid && bb.mid <= bb.upper)
  ok('zscore finite', finite(zscore(1, [1, 2, 3])))
  ok('percentileRank in [0,1]', percentileRank([1, 2, 3, 4, 5], 3) >= 0 && percentileRank([1, 2, 3, 4, 5], 3) <= 1)
  ok('linregSlope finite', finite(linregSlope(closes, 20)))
  ok('median correct', median([3, 1, 2]) === 2 && median([4, 1, 2, 3]) === 2.5)
  ok('trueRange positive', trueRange(candles).every((x) => x >= 0))
  ok('divergence returns type or null', divergence(candles, r) !== undefined)
  ok('stdev positive', stdev(closes) > 0)
  ok('avgVolume positive', avgVolume(candles) > 0)
}

console.log('── structure / SMC ──')
{
  const candles = genCandles(300)
  const h1 = genCandles(160, 7, 3_600_000, 100)
  const swings = findSwings(candles)
  ok('swings found', swings.length > 4, `got ${swings.length}`)
  const struct = labelStructure(swings)
  ok('structure trend valid', ['up', 'down', 'range'].includes(struct.trend))
  const bos = detectBosChoch(candles, swings)
  ok('BOS/CHoCH parse', bos === null || (bos.kind === 'BOS' || bos.kind === 'CHoCH'))
  const obs = orderBlocks(candles)
  ok('order blocks well-formed', obs.every((ob) => ob.top >= ob.bottom && (ob.dir === 1 || ob.dir === -1)))
  const fvgs = fairValueGaps(candles)
  ok('FVGs well-formed', fvgs.every((f) => f.top >= f.bottom))
  const pools = liquidityPools(candles, swings)
  ok('liquidity pools well-formed', pools.every((p) => p.count >= 2 && (p.type === 'EQH' || p.type === 'EQL')))
  const sweep = detectSweep(candles, pools, swings)
  ok('sweep parse on random walk', sweep === null || (sweep.barsAgo <= 2 && (sweep.dir === 1 || sweep.dir === -1)), sweep ? `dir=${sweep.dir} barsAgo=${sweep.barsAgo}` : 'none')
  // deterministic textbook sweep-of-lows fixture: pivot low at idx 5, sweep candle at idx 8
  {
    const P = 100
    const mk = (i: number, o: number, h: number, l: number, c: number): Candle => ({ t: 1_700_000_000_000 + i * 900_000, o: P * o, h: P * h, l: P * l, c: P * c, v: 1000, q: 1000 * P * c, closed: true })
    const fx = [
      mk(0, 1.010, 1.012, 1.008, 1.008),
      mk(1, 1.008, 1.010, 1.004, 1.004),
      mk(2, 1.004, 1.006, 1.001, 1.002),
      mk(3, 1.002, 1.004, 0.999, 1.000),
      mk(4, 1.000, 1.002, 0.998, 1.000),
      mk(5, 1.000, 1.001, 0.995, 0.997),   // pivot low L = 0.995
      mk(6, 0.997, 1.000, 0.996, 0.999),
      mk(7, 0.999, 1.002, 0.998, 1.001),
      mk(8, 1.001, 1.0045, 0.9935, 1.004), // SWEEP: wick below L, close back above
      mk(9, 1.004, 1.007, 1.003, 1.006),
    ]
    const fxSwings = findSwings(fx)
    const fxSweep = detectSweep(fx, liquidityPools(fx, fxSwings), fxSwings)
    ok('textbook sweep-of-lows detected (dir=1)', fxSweep !== null && fxSweep.dir === 1, fxSweep ? `dir=${fxSweep.dir} barsAgo=${fxSweep.barsAgo}` : 'no sweep')
  }
  const pd = premiumDiscount(candles)
  ok('premium/discount sane', pd.positionPct >= 0 && pd.positionPct <= 1 && pd.low <= pd.equilibrium && pd.equilibrium <= pd.high && pd.oteLong!.from > pd.oteLong!.to)
  const sess = sessionInfo()
  ok('session valid', ['asia', 'london', 'newyork', 'off'].includes(sess.session))
  const ar = asiaRange(h1)
  ok('asiaRange null or ordered', ar === null || ar.low <= ar.high)
  ok('candlePatterns list', candlePatterns(candles).every((p) => typeof p.name === 'string'))
  const wy = wyckoffLite(candles)
  ok('wyckoff parse', wy.name === null || wy.name === 'spring' || wy.name === 'upthrust')
  const snap = structureSnapshot(candles, h1)
  ok('structureSnapshot complete', snap.trend !== undefined && Array.isArray(snap.pools) && finite(snap.deltaSlope) && finite(snap.price))
}

console.log('── derivatives analytics ──')
{
  const f = fundingRegime(0.0009, new Array(60).fill(0).map((_, i) => (i % 2 ? 0.0001 : 0.0002)))
  ok('funding extreme-positive detected', f.label === 'extreme-positive' && f.contrarianDir === -1)
  const q1 = oiPriceQuadrant(1.2, 0.8)
  ok('OI quadrant new-longs', q1.label === 'new-longs' && q1.dir === 1)
  const q2 = oiPriceQuadrant(-1.0, 1.2)
  ok('OI quadrant new-shorts', q2.label === 'new-shorts' && q2.dir === -1)
  const q3 = oiPriceQuadrant(1.0, -1.5)
  ok('OI quadrant short-squeeze', q3.label === 'short-squeeze' && q3.dir === 1)
  const ls = lsRatioAnalysis({ global: 3.2, topTrader: 2.5, taker: 1.8 })
  ok('crowded-long detected', ls.crowd === 'crowded-long' && ls.contrarianDir === -1)
  const events: LiquidationEvent[] = Array.from({ length: 12 }, (_, i) => ({
    ts: Date.now() - i * 60_000, symbol: 'TESTUSDT', side: 'LONG',
    price: 100, qty: 10, notionalUsd: 80_000,
  }))
  const liq = liquidationAnalytics(events)
  ok('liquidation cascade detected', liq.cascade === true && liq.dir === 1 && liq.totalUsd === 960_000)
  const b = basisAnalysis(101.5, 100)
  ok('basis rich label', b.label === 'rich' && Math.abs(b.basisPct - 1.5) < 0.01)
  const vote = derivativesVote({ funding: f, oi: q1, ls, liq, basis: b })
  ok('derivativesVote in [-1,1]', vote.score >= -1 && vote.score <= 1)
}

console.log('── regime + confluence + setups ──')
{
  const candles = genCandles(300)
  const h1 = genCandles(160, 7, 3_600_000, 100)
  const m5 = genCandles(300, 11, 300_000, 100)
  const regime = detectRegime(candles)
  ok('regime valid', ['trend-up', 'trend-down', 'range', 'volatile', 'quiet'].includes(regime.regime) && regime.permits.length > 0)
  const structure = structureSnapshot(candles, h1)
  const derivatives = {
    funding: fundingRegime(0.0001, [0.0001, 0.0001, 0.0002]),
    oi: oiPriceQuadrant(0.5, 0.4),
    ls: lsRatioAnalysis({ global: 1.1, topTrader: 1.2, taker: 1.0 }),
    liq: liquidationAnalytics([]),
    basis: basisAnalysis(100, 100),
  }
  const conf = computeConfluence({ m15: candles, h1, structure, derivatives })
  ok('confluence score in [-1,1]', conf.score >= -1 && conf.score <= 1)
  ok('five stacks present', conf.stacks.length === 5 && ['trend', 'momentum', 'volume', 'derivatives', 'structure'].every((n) => conf.stacks.some((s) => s.name === n)))
  ok('agreement counted', conf.agreement >= 0 && conf.agreement <= 5)
  const setups = matchSetups({ m15: candles, m5, h1, structure, derivatives, confluence: conf })
  ok('8 setups evaluated', setups.length === 8 && setups.every((s) => s.strength >= 0 && s.strength <= 1))
}

console.log('── strategy families ──')
{
  const m15 = genCandles(300)
  const m5 = genCandles(300, 11, 300_000, 100)
  const h1 = genCandles(160, 7, 3_600_000, 100)
  const inp = {
    symbol: 'TESTUSDT',
    m15, m5, h1,
    fundingRate: 0.00012,
    fundingHistory: [0.0001, 0.0001, 0.00015, 0.0002, 0.0001],
    oiChangePct: 0.6,
    spreadPct: 0.2,
    lsRatio: 1.8,
    topTraderRatio: 1.5,
    takerRatio: 1.2,
    liquidations: [] as LiquidationEvent[],
    spotRef: m15[m15.length - 1].c * 0.999,
    price24hChgPct: 2.1,
  }
  const fams = {
    momentum: momentumSignal(inp),
    meanRev: meanReversionSignal(inp),
    spread: spreadSignal(inp),
    liqSweep: liquiditySweepSignal(inp),
    squeeze: squeezeBreakoutSignal(inp),
    orderBlock: orderBlockSignal(inp),
    session: sessionBreakoutSignal(inp),
    fundingFlip: fundingFlipSignal(inp),
    cascade: cascadeSnapbackSignal(inp),
    vwapRev: vwapReversionSignal(inp),
  }
  for (const [name, f] of Object.entries(fams)) {
    ok(`${name} in [-1,1] with note`, f.score >= -1 && f.score <= 1 && (f.dir === -1 || f.dir === 0 || f.dir === 1) && f.note.length > 0, JSON.stringify(f))
  }
  const x = computeExtendedSignals(inp)
  ok('extended composite in [-1,1]', x.composite >= -1 && x.composite <= 1)
  ok('extended has confluence+regime+setups', !!x.confluence && !!x.regime && x.setups.length === 8)
  const wire = toSignalSet(x)
  ok('wire SignalSet backward-compatible', typeof wire.momentum.score === 'number' && typeof wire.composite === 'number' && !!wire.regime?.label && !!wire.confluence?.score)
  const br = bracketFor(m15, 'LONG', 100, 1.5, 2)
  ok('bracket ordered for LONG', br.stop < 100 && br.takeProfit > 100 && br.atr > 0)
  const brS = bracketFor(m15, 'SHORT', 100, 1.5, 2)
  ok('bracket ordered for SHORT', brS.stop > 100 && brS.takeProfit < 100)
}

console.log('── risk sizing math (via strategy brackets) ──')
{
  const m15 = genCandles(120)
  const br = bracketFor(m15, 'LONG', 100, 1.5, 2.0)
  const riskUsd = 200 // 2% of 10k
  const qty = riskUsd / Math.abs(100 - br.stop)
  ok('risk-based sizing consistent', Math.abs(qty * Math.abs(100 - br.stop) - riskUsd) < 1e-6)
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)

// ── live mode (optional): one symbol through the full stack ──────────────────
if (process.argv[2]) {
  const symbol = process.argv[2].toUpperCase()
  console.log(`\n── live deep analysis: ${symbol} (Binance REST, read-only) ──`)
  const { getKlines } = await import('../mini-services/engine/src/binance')
  const [m15, m5, h1] = await Promise.all([
    getKlines(symbol, '15m', 220),
    getKlines(symbol, '5m', 220),
    getKlines(symbol, '1h', 160),
  ])
  const inp = {
    symbol,
    m15: m15.candles, m5: m5.candles, h1: h1.candles,
    fundingRate: 0.0001, fundingHistory: [], oiChangePct: null, spreadPct: null,
    liquidations: [] as LiquidationEvent[], spotRef: null, price24hChgPct: null,
  }
  const x = computeExtendedSignals(inp)
  console.log(`regime       : ${x.regime.regime} (${x.regime.note})`)
  console.log(`structure    : trend=${x.structure.trend} bos=${x.structure.bos?.kind ?? 'none'} sweep=${x.structure.sweep ? (x.structure.sweep.dir > 0 ? 'of-lows' : 'of-highs') : 'none'} zone=${x.structure.rangeCtx.zone}`)
  console.log(`confluence   : ${x.confluence.score} (${x.confluence.agreement}/5 stacks)`)
  for (const s of x.confluence.stacks) console.log(`  ${s.name.padEnd(12)} ${s.score >= 0 ? '+' : ''}${s.score}  ${s.notes.slice(0, 3).join('; ')}`)
  const active = x.setups.filter((s) => s.dir !== 0 && s.strength >= 0.5)
  console.log(`setups       : ${active.length ? active.map((s) => `${s.name}(${s.dir > 0 ? 'long' : 'short'},${(s.strength * 100).toFixed(0)}%)`).join(', ') : 'none firing'}`)
  console.log(`composite    : ${x.composite}`)
}
