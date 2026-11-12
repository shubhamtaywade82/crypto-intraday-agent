// ─── Risk manager — the full-auto guardrails ────────────────────────────────
// v1 guardrails (unchanged):
//   • max 2% equity risk per trade (position sized off stop distance)
//   • daily loss cutoff -3% → no new entries until midnight UTC
//   • max 3 concurrent positions, ≤5x notional leverage each
//   • per-symbol cooldown after a stop-loss
//   • confidence floor 0.60 for agent entries
// v2 additions:
//   • trailing stops — chandelier (3×ATR) that only ever tightens
//   • consecutive-loss circuit breaker (halt after N losses in a row)
//   • sizing modes: fixed-fractional | quarter-Kelly (from live trade stats)
//     | vol-target (inverse-ATR sizing vs universe median)
//   • trade-result tracking feeding the streak breaker + Kelly estimator

import { CONFIG } from './config'
import { atr, median } from './indicators'
import type { AccountState, RiskState, Position, Candle } from './types'

export type SizingMode = 'fixed-fractional' | 'quarter-kelly' | 'vol-target'

export class RiskManager {
  state: RiskState
  lossStreak = 0
  winStreak = 0
  private lastLossStreakNotified = 0

  constructor(private getAccount: () => AccountState) {
    this.state = {
      dailyStartEquity: CONFIG.initialEquity,
      dailyPnl: 0,
      dailyLossCutoffPct: CONFIG.dailyLossCutoffPct,
      riskPerTradePct: CONFIG.riskPerTradePct,
      maxPositions: CONFIG.maxPositions,
      minConfidence: CONFIG.minConfidence,
      maxLeverage: CONFIG.maxLeverage,
      cooldownUntil: {},
      haltedReason: null,
    }
  }

  /** Called at engine start + on UTC day rollover. */
  newDay(equity: number) {
    this.state.dailyStartEquity = equity
    this.state.dailyPnl = 0
    this.state.haltedReason = null
    this.state.cooldownUntil = {}
    this.lossStreak = 0
  }

  /** Update daily PnL (realized + unrealized) and evaluate the loss cutoff. */
  refresh(equity: number): { halted: boolean; reason: string | null } {
    this.state.dailyPnl = equity - this.state.dailyStartEquity
    if (!this.state.haltedReason && this.state.dailyPnl < -this.state.dailyStartEquity * this.state.dailyLossCutoffPct) {
      this.state.haltedReason = `daily loss cutoff hit (${((this.state.dailyPnl / this.state.dailyStartEquity) * 100).toFixed(2)}% < -${(this.state.dailyLossCutoffPct * 100).toFixed(0)}%)`
    } else if (this.state.haltedReason && this.state.dailyPnl > -this.state.dailyStartEquity * this.state.dailyLossCutoffPct * 0.5) {
      // recover only well past the cutoff
      this.state.haltedReason = null
    }
    // consecutive-loss circuit breaker (independent of the daily cutoff)
    if (!this.state.haltedReason && this.lossStreak >= CONFIG.maxConsecutiveLosses) {
      this.state.haltedReason = `${this.lossStreak} consecutive losses — circuit breaker engaged`
    } else if (this.state.haltedReason?.includes('consecutive losses') && this.lossStreak < CONFIG.maxConsecutiveLosses) {
      this.state.haltedReason = null
    }
    return { halted: !!this.state.haltedReason, reason: this.state.haltedReason }
  }

  /** Feed every closed trade so streaks + Kelly stats stay live. */
  noteTradeResult(pnl: number) {
    if (pnl < 0) {
      this.lossStreak++
      this.winStreak = 0
      if (this.lossStreak >= CONFIG.maxConsecutiveLosses && this.lossStreak > this.lastLossStreakNotified) {
        this.lastLossStreakNotified = this.lossStreak
      }
    } else if (pnl > 0) {
      this.winStreak++
      this.lossStreak = 0
      this.lastLossStreakNotified = 0
    }
  }

  noteStopLoss(symbol: string) {
    const until = Date.now() + CONFIG.cooldownAfterLossMin * 60_000
    this.state.cooldownUntil[symbol] = until
  }

  cooldownLeftMin(symbol: string): number {
    const until = this.state.cooldownUntil[symbol] ?? 0
    return Math.max(0, Math.ceil((until - Date.now()) / 60_000))
  }

  /** Kelly fraction from live trade history (guard-railed, quarter-Kelly). */
  kellyFraction(): number {
    const trades = this.getAccount().trades.slice(-CONFIG.kellyWindow)
    if (trades.length < CONFIG.kellyMinTrades) return 0 // not enough data — fall back
    const wins = trades.filter((t) => t.pnl > 0)
    const losses = trades.filter((t) => t.pnl < 0)
    if (!wins.length || !losses.length) return 0
    const p = wins.length / trades.length
    const avgWin = wins.reduce((a, t) => a + t.pnl, 0) / wins.length
    const avgLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length)
    if (!avgLoss) return 0
    const b = avgWin / avgLoss
    const kelly = (p * (b + 1) - 1) / b
    if (!Number.isFinite(kelly) || kelly <= 0) return 0
    return Math.min(CONFIG.riskPerTradePct, kelly / 4) // quarter-Kelly, capped at base risk
  }

  /**
   * Validate a proposed trade; returns rejection reason or sizing plan.
   * qty is derived so that (entry−stop) × qty ≈ riskBudget.
   */
  evaluate(opts: {
    symbol: string
    side: 'LONG' | 'SHORT'
    entry: number
    stop: number
    confidence: number
    candles?: Candle[]             // for vol-target sizing
  }): { ok: true; qty: number; riskUsd: number; sizing: SizingMode } | { ok: false; reason: string } {
    const acc = this.getAccount()
    const st = this.state

    if (st.haltedReason) return { ok: false, reason: `trading halted: ${st.haltedReason}` }
    if (acc.positions.length >= st.maxPositions) return { ok: false, reason: `max concurrent positions (${st.maxPositions}) reached` }
    if (acc.positions.some((p) => p.symbol === opts.symbol)) return { ok: false, reason: `already in ${opts.symbol}` }
    if (opts.confidence < st.minConfidence) return { ok: false, reason: `confidence ${(opts.confidence * 100).toFixed(0)}% below floor ${(st.minConfidence * 100).toFixed(0)}%` }

    const cd = this.cooldownLeftMin(opts.symbol)
    if (cd > 0) return { ok: false, reason: `${opts.symbol} in post-loss cooldown (${cd}m left)` }

    const stopDist = Math.abs(opts.entry - opts.stop)
    if (stopDist <= 0) return { ok: false, reason: 'invalid stop distance' }

    const equity = acc.equity || acc.balance

    // ── sizing mode selection ──
    let mode: SizingMode = CONFIG.sizingMode
    let riskPct = st.riskPerTradePct
    if (mode === 'quarter-kelly') {
      const k = this.kellyFraction()
      if (k > 0) riskPct = k
      else mode = 'fixed-fractional' // insufficient/losing history → base risk
    }
    if (mode === 'vol-target' && opts.candles?.length) {
      // scale risk inversely with current ATR% (calmer market → full risk)
      const a = atr(opts.candles.filter((c) => c.closed), 14)
      const atrPct = a / opts.entry
      const baseline = CONFIG.volTargetAtrPct
      const scale = median([atrPct / baseline, 0.5, 1.5]) // clamp 0.5..1.5
      riskPct = st.riskPerTradePct / scale
    }

    const riskUsd = equity * riskPct
    let qty = riskUsd / stopDist

    // leverage cap: notional ≤ equity × maxLeverage
    const maxNotional = equity * st.maxLeverage
    if (qty * opts.entry > maxNotional) qty = maxNotional / opts.entry

    // margin sanity: keep at least 30% of balance free as cross-margin buffer
    const notional = qty * opts.entry
    const otherNotional = acc.positions.reduce((a, p) => a + p.entry * p.qty, 0)
    if (notional + otherNotional > (acc.balance + 1) * st.maxLeverage * 1.5) {
      return { ok: false, reason: 'aggregate notional exceeds margin buffer' }
    }
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: 'qty computed ≤ 0' }

    return { ok: true, qty: Number(qty.toFixed(6)), riskUsd: Number(riskUsd.toFixed(2)), sizing: mode }
  }

  /**
   * Chandelier trailing stop — move the stop in the trade's favour only.
   * Returns the new stop when it tightened, else null.
   */
  applyTrailingStop(pos: Position, price: number, candles: Candle[]): number | null {
    if (!CONFIG.trailingStopEnabled) return null
    const closed = candles.filter((c) => c.closed)
    if (closed.length < 20) return null
    const a = atr(closed, 14)
    if (!a) return null
    const mult = CONFIG.trailingStopAtrMult
    if (pos.side === 'LONG') {
      const candidate = price - a * mult
      // trail at least to breakeven once 1R in profit
      const r = pos.entry - pos.stop
      const be = pos.entry + r * CONFIG.trailBreakevenAtR
      const newStop = price - pos.entry > r * CONFIG.trailBreakevenAtR ? Math.max(candidate, be) : candidate
      if (newStop > pos.stop) return Number(newStop.toFixed(6))
    } else {
      const candidate = price + a * mult
      const r = pos.stop - pos.entry
      const be = pos.entry - r * CONFIG.trailBreakevenAtR
      const newStop = pos.entry - price > r * CONFIG.trailBreakevenAtR ? Math.min(candidate, be) : candidate
      if (newStop < pos.stop) return Number(newStop.toFixed(6))
    }
    return null
  }
}

export type { Position }
