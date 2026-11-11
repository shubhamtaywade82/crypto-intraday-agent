// ─── Paper trading engine (Binance USDⓈ-M semantics, zero risk) ─────────────
// Mirrors the binance-futures-paper-trading skill: in-memory state, fills at
// live prices, taker fee + slippage simulation, equity marked to last price.

import { CONFIG } from './config'
import { uid } from './util'
import { log, persistAccount, loadAccountPatch, bus } from './store'
import type { AccountState, ClosedTrade, Position, Side } from './types'

export class PaperEngine {
  account: AccountState

  constructor() {
    const patch = loadAccountPatch()
    this.account = {
      balance: patch?.balance ?? CONFIG.initialEquity,
      initialEquity: patch?.initialEquity ?? CONFIG.initialEquity,
      equity: 0,
      positions: (patch?.positions ?? []).map((p) => ({ ...p })),
      trades: (patch?.trades ?? []).map((t) => ({ ...t })),
      equityCurve: patch?.equityCurve ?? [{ ts: Date.now(), equity: patch?.balance ?? CONFIG.initialEquity }],
    }
    this.account.equity = this.account.balance
    log('info', 'PAPER', `account ready — balance ${this.account.balance.toFixed(2)} USDT, ${this.account.positions.length} open, ${this.account.trades.length} closed trades on record`)
  }

  /** Mark-to-market equity using latest prices. */
  markToMarket(prices: Record<string, number>): number {
    let unreal = 0
    for (const p of this.account.positions) {
      const px = prices[p.symbol]
      if (!px) continue
      unreal += (p.side === 'LONG' ? px - p.entry : p.entry - px) * p.qty
    }
    this.account.equity = this.account.balance + unreal
    return this.account.equity
  }

  pushEquityPoint() {
    const last = this.account.equityCurve[this.account.equityCurve.length - 1]
    if (!last || Date.now() - last.ts > 30_000) {
      this.account.equityCurve.push({ ts: Date.now(), equity: Number(this.account.equity.toFixed(2)) })
      if (this.account.equityCurve.length > 720) this.account.equityCurve.splice(0, this.account.equityCurve.length - 720)
      persistAccount(this.account)
    }
  }

  hasPosition(symbol: string) {
    return this.account.positions.some((p) => p.symbol === symbol)
  }

  position(symbol: string) {
    return this.account.positions.find((p) => p.symbol === symbol)
  }

  /**
   * Open a paper position at `price` (live). Sizing is done by the risk manager;
   * this method just executes, charges fees and registers the bracket.
   */
  open(opts: {
    symbol: string
    side: Side
    qty: number
    price: number
    stop: number
    takeProfit: number
    confidence: number
    rationale: string
    strategy: string
    riskUsd: number
  }): Position {
    const fill = opts.price * (opts.side === 'LONG' ? 1 + CONFIG.slippagePct : 1 - CONFIG.slippagePct)
    const notional = fill * opts.qty
    const fee = notional * CONFIG.takerFeePct
    this.account.balance -= fee

    const pos: Position = {
      id: uid('pos'),
      symbol: opts.symbol,
      side: opts.side,
      qty: opts.qty,
      entry: fill,
      stop: opts.stop,
      takeProfit: opts.takeProfit,
      openedAt: Date.now(),
      confidence: opts.confidence,
      rationale: opts.rationale,
      strategy: opts.strategy,
      riskUsd: opts.riskUsd,
    }
    this.account.positions.push(pos)
    log('trade', 'FILL', `OPEN ${opts.side} ${opts.symbol} qty=${opts.qty} @ ${fill.toFixed(4)} | SL ${opts.stop.toFixed(4)} TP ${opts.takeProfit.toFixed(4)} | fee ${fee.toFixed(3)} | ${opts.strategy} conf ${(opts.confidence * 100).toFixed(0)}%`)
    bus.emit('positions', this.account.positions)
    persistAccount(this.account)
    return pos
  }

  /** Close (whole or portion) at `price`, realize PnL. */
  close(posId: string, price: number, reason: ClosedTrade['closeReason']): ClosedTrade | null {
    const idx = this.account.positions.findIndex((p) => p.id === posId)
    if (idx === -1) return null
    const p = this.account.positions[idx]
    const fill = price * (p.side === 'LONG' ? 1 - CONFIG.slippagePct : 1 + CONFIG.slippagePct)
    const gross = (p.side === 'LONG' ? fill - p.entry : p.entry - fill) * p.qty
    const fee = fill * p.qty * CONFIG.takerFeePct
    const pnl = gross - fee
    this.account.balance += pnl
    const trade: ClosedTrade = {
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      entry: p.entry,
      exit: fill,
      pnl: Number(pnl.toFixed(4)),
      fees: Number(fee.toFixed(4)),
      openedAt: p.openedAt,
      closedAt: Date.now(),
      closeReason: reason,
      rationale: p.rationale,
      strategy: p.strategy,
    }
    this.account.trades.push(trade)
    this.account.positions.splice(idx, 1)
    log('trade', 'FILL', `CLOSE ${p.side} ${p.symbol} @ ${fill.toFixed(4)} → ${reason} | PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT`)
    bus.emit('positions', this.account.positions)
    bus.emit('trades', trade)
    persistAccount(this.account)
    return trade
  }

  /** Check TP/SL/EOD on every tick; returns closed trades this tick. */
  checkBrackets(prices: Record<string, number>, maxAgeMs: number): ClosedTrade[] {
    const closed: ClosedTrade[] = []
    for (const p of [...this.account.positions]) {
      const px = prices[p.symbol]
      if (!px) continue
      const hitTp = p.side === 'LONG' ? px >= p.takeProfit : px <= p.takeProfit
      const hitSl = p.side === 'LONG' ? px <= p.stop : px >= p.stop
      const tooOld = Date.now() - p.openedAt > maxAgeMs
      if (hitTp) { const t = this.close(p.id, p.takeProfit, 'take-profit'); if (t) closed.push(t) }
      else if (hitSl) { const t = this.close(p.id, p.stop, 'stop-loss'); if (t) closed.push(t) }
      else if (tooOld) { const t = this.close(p.id, px, 'eod'); if (t) closed.push(t) }
    }
    return closed
  }

  reset() {
    this.account = {
      balance: CONFIG.initialEquity,
      initialEquity: CONFIG.initialEquity,
      equity: CONFIG.initialEquity,
      positions: [],
      trades: [],
      equityCurve: [{ ts: Date.now(), equity: CONFIG.initialEquity }],
    }
    log('info', 'PAPER', `account reset to ${CONFIG.initialEquity} USDT`)
    bus.emit('positions', this.account.positions)
    persistAccount(this.account)
  }
}
