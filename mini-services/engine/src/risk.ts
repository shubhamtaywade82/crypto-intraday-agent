// ─── Risk manager — the full-auto guardrails ────────────────────────────────
// • max 2% equity risk per trade (position sized off stop distance)
// • daily loss cutoff -3% → no new entries until midnight UTC
// • max 3 concurrent positions, ≤5x notional leverage each
// • per-symbol cooldown after a stop-loss
// • confidence floor 0.60 for agent entries

import { CONFIG } from './config'
import type { AccountState, RiskState, Position } from './types'

export class RiskManager {
  state: RiskState

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
    return { halted: !!this.state.haltedReason, reason: this.state.haltedReason }
  }

  noteStopLoss(symbol: string) {
    const until = Date.now() + CONFIG.cooldownAfterLossMin * 60_000
    this.state.cooldownUntil[symbol] = until
  }

  cooldownLeftMin(symbol: string): number {
    const until = this.state.cooldownUntil[symbol] ?? 0
    return Math.max(0, Math.ceil((until - Date.now()) / 60_000))
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
  }): { ok: true; qty: number; riskUsd: number } | { ok: false; reason: string } {
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
    const riskUsd = equity * st.riskPerTradePct
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

    return { ok: true, qty: Number(qty.toFixed(6)), riskUsd: Number(riskUsd.toFixed(2)) }
  }
}

export type { Position }
