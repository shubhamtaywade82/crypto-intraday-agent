// ─── Engine orchestrator — wires data, strategies, agent, paper account ─────

import { CONFIG } from './config'
import { BinanceWs, getKlines, getOpenInterestHist, getExchangeInfoSymbols, restStatus } from './binance'
import * as dcx from './coindcx'
import { computeSignals, bracketFor } from './strategies'
import { PaperEngine } from './paper'
import { RiskManager } from './risk'
import { weighCandidates, journal, reviewPosition, type Candidate, type AgentVerdict } from './agent'
import { log, bus, recentLogs, recentDecisions } from './store'
import type { Candle, EngineStatus, TickerRow } from './types'

export class TradingEngine {
  paper = new PaperEngine()
  risk = new RiskManager(() => this.paper.account)

  // live data maps
  tickers = new Map<string, { price: number; changePct: number; high: number; low: number; quoteVolume: number }>()
  marks = new Map<string, { mark: number; fundingRate: number; nextFundingMs: number }>()
  candles = new Map<string, { '5m': Candle[]; '15m': Candle[] }>()
  oiHist = new Map<string, { ts: number; oi: number; oiValue: number }[]>()
  dcxPrices = new Map<string, number>()       // CoinDCX futures price per Binance symbol
  spotInr = new Map<string, number>()          // CoinDCX spot INR
  scanRows = new Map<string, TickerRow>()      // last computed dashboard rows

  ws!: BinanceWs
  symbols: string[] = []
  private perpetuals = new Set<string>()
  private lastUniverseRefresh = 0
  private bootstrapped = new Set<string>()
  private noDataSymbols = new Set<string>()

  status: EngineStatus = {
    running: false,
    mode: 'paper',
    cycle: 0,
    lastScanTs: null,
    nextScanTs: null,
    scanIntervalSec: CONFIG.scanIntervalSec,
    wsConnected: false,
    binanceRest: 'ok',
    coindcx: 'down',
    usdtInr: 0,
    usdtInrSource: '',
    symbols: [],
    startedAt: Date.now(),
  }

  private scanTimer: any = null
  private tickerFlushTimer: any = null
  private lastTickerEmit = 0
  private reviewCounter = 0

  // ── lifecycle ────────────────────────────────────────────────────────────
  async start() {
    log('info', 'ENGINE', 'starting intraday engine (paper mode)…')
    this.risk.newDay(this.paper.account.balance)
    dcx.refreshFx().then(() => { this.status.usdtInr = dcx.fx().usdtInr; this.status.usdtInrSource = dcx.fx().usdtInrSource })

    this.ws = new BinanceWs({
      onStatus: (c) => {
        this.status.wsConnected = c
        bus.emit('status', this.status)
      },
      onTicker: (t) => { this.tickers.set(t.symbol, t) },
      onMarkPrice: (m) => { this.marks.set(m.symbol, m) },
      onKline: (symbol, interval, candle) => {
        const store = this.candles.get(symbol)
        if (!store) return
        const arr = store[interval]
        if (!arr.length) { arr.push(candle); return }
        const last = arr[arr.length - 1]
        if (candle.t === last.t) arr[arr.length - 1] = candle
        else if (candle.t > last.t) {
          arr.push(candle)
          if (arr.length > CONFIG.klinesBootstrap + 60) arr.splice(0, arr.length - (CONFIG.klinesBootstrap + 60))
        }
        bus.emit('kline', { symbol, interval, candle })
      },
    })
    this.ws.start()
    // aggregate stream powers the universe + ticker rows
    this.ws.subscribe(['!ticker@arr'])

    // tickers need a few seconds of !ticker@arr before the universe can rank
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 1_500 : 2_500))
      await this.refreshUniverse()
      if (this.symbols.length >= CONFIG.symbolUniverseSize) break
    }
    await this.bootstrapHistory()

    // CoinDCX health probe in background
    dcx.ensureHealth().then((ok) => {
      this.status.coindcx = dcx.coindcxStatus()
      log(ok ? 'info' : 'warn', 'COINDCX', ok
        ? 'live CoinDCX market data connected'
        : `CoinDCX unreachable from this network (${dcx.coindcxStatus()}) — spread column degrades to derived INR reference`)
      bus.emit('status', this.status)
    })

    // periodic ticker emit to socket clients (1s)
    this.tickerFlushTimer = setInterval(() => this.emitTickersThrottled(), 1_000)

    // position management heartbeat (5s): TP/SL + equity
    setInterval(() => {
      const prices = this.currentPrices()
      this.paper.markToMarket(prices)
      this.paper.checkBrackets(prices, CONFIG.maxPositionAgeMin * 60_000)
      this.paper.pushEquityPoint()
      const { halted, reason } = this.risk.refresh(this.paper.account.equity)
      if (halted && reason && this.paper.account.positions.length === 0) {
        // log halt once
        if ((this as any)._haltLogged !== reason) { log('warn', 'RISK', reason); (this as any)._haltLogged = reason }
      }
      bus.emit('account', this.accountSnapshot())
    }, 5_000)

    // UTC day rollover
    setInterval(() => {
      const now = new Date()
      if (now.getUTCHours() === 0 && now.getUTCMinutes() < 1) {
        this.risk.newDay(this.paper.account.equity)
        log('info', 'RISK', 'new UTC day — daily loss cutoff reset')
      }
    }, 60_000)

    this.status.running = true
    this.status.nextScanTs = Date.now() + 5_000
    this.scanTimer = setInterval(() => this.agentCycle(), CONFIG.scanIntervalSec * 1_000)
    setTimeout(() => this.agentCycle(), 5_000) // first cycle soon after boot
    log('info', 'ENGINE', `engine live — agent loop every ${CONFIG.scanIntervalSec}s, universe [${this.symbols.join(', ')}]`)
    bus.emit('status', this.status)
  }

  stop() {
    if (this.scanTimer) clearInterval(this.scanTimer)
    this.scanTimer = null
    this.status.running = false
    this.status.nextScanTs = null
    log('info', 'ENGINE', 'agent loop stopped by user')
    bus.emit('status', this.status)
  }

  // ── universe & history ───────────────────────────────────────────────────
  async refreshUniverse() {
    if (!this.perpetuals.size) this.perpetuals = await getExchangeInfoSymbols()
    const rows = [...this.tickers.values()]
      .filter((t) => this.perpetuals.has(t.symbol) && t.quoteVolume > 5_000_000 && !this.noDataSymbols.has(t.symbol))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, CONFIG.symbolUniverseSize)
      .map((t) => t.symbol)
    const set = new Set([...CONFIG.alwaysInclude, ...rows])
    // keep symbols with open positions even if they fell out of top-N
    for (const p of this.paper.account.positions) set.add(p.symbol)
    const before = this.symbols.join(',')
    this.symbols = [...set]
    this.status.symbols = this.symbols
    this.lastUniverseRefresh = Date.now()

    // subscribe WS topics for the universe
    const topics: string[] = []
    for (const s of this.symbols) {
      topics.push(`${s.toLowerCase()}@kline_5m`, `${s.toLowerCase()}@kline_15m`, `${s.toLowerCase()}@markPrice@1s`)
    }
    this.ws.subscribe(topics)
    if (before !== this.symbols.join(',')) {
      log('info', 'ENGINE', `universe refreshed (${this.symbols.length} symbols): ${this.symbols.join(', ')}`)
      bus.emit('status', this.status)
    }
  }

  async bootstrapHistory() {
    const failed: string[] = []
    for (const s of this.symbols) {
      if (this.bootstrapped.has(s)) continue
      this.candles.set(s, { '5m': [], '15m': [] })
      try {
        const [m15, m5] = await Promise.all([
          getKlines(s, '15m'),
          getKlines(s, '5m'),
        ])
        this.candles.set(s, { '15m': m15.candles, '5m': m5.candles })
        this.bootstrapped.add(s)
      } catch (e: any) {
        log('warn', 'BOOT', `history bootstrap failed for ${s}: ${String(e?.message || e).slice(0, 90)}`)
        this.candles.delete(s)
        failed.push(s)
      }
    }
    // futures-only symbols absent from the spot mirror have no history — drop them
    if (failed.length) {
      this.noDataSymbols = new Set([...this.noDataSymbols, ...failed])
      this.symbols = this.symbols.filter((s) => !failed.includes(s))
      this.status.symbols = this.symbols
      log('info', 'ENGINE', `dropped ${failed.join(', ')} from universe (no history source)`)
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  currentPrices(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [s, t] of this.tickers) out[s] = t.price
    for (const [s, m] of this.marks) if (!out[s]) out[s] = m.mark
    return out
  }

  oiChangePct(symbol: string): number | null {
    const hist = this.oiHist.get(symbol)
    if (!hist || hist.length < 2) return null
    const a = hist[hist.length - 2].oi
    const b = hist[hist.length - 1].oi
    return a ? ((b - a) / a) * 100 : null
  }

  private emitTickersThrottled() {
    bus.emit('tickers', this.buildTickerRows(false))
  }

  /** Build the dashboard rows, optionally recomputing signals (scan mode). */
  buildTickerRows(withSignals: boolean): TickerRow[] {
    const rows: TickerRow[] = []
    const fxr = dcx.fx()
    for (const s of this.symbols) {
      const t = this.tickers.get(s)
      const m = this.marks.get(s)
      const price = t?.price ?? m?.mark ?? 0
      if (!price) continue
      const store = this.candles.get(s)
      const dcxPx = this.dcxPrices.get(s) ?? null
      const spreadPct = dcxPx ? ((dcxPx - price) / price) * 100 : null
      const inrFromDcx = this.spotInr.get(s)
      const inr = inrFromDcx ?? (fxr.usdtInr ? price * fxr.usdtInr : null)

      let signals: TickerRow['signals'] = null
      if (withSignals && store && store['15m'].length > 25 && store['5m'].length > 25) {
        signals = computeSignals({
          symbol: s,
          m15: store['15m'],
          m5: store['5m'],
          fundingRate: m?.fundingRate ?? 0,
          oiChangePct: this.oiChangePct(s),
          spreadPct,
        })
      } else if (this.scanRows.has(s)) {
        // reuse the last scan's signals on the throttled 1s path
        signals = this.scanRows.get(s)!.signals
      }
      rows.push({
        symbol: s,
        price,
        changePct: t?.changePct ?? 0,
        high: t?.high ?? price,
        low: t?.low ?? price,
        quoteVolume: t?.quoteVolume ?? 0,
        fundingRate: m?.fundingRate ?? 0,
        nextFundingMs: m?.nextFundingMs ?? 0,
        oiChangePct: this.oiChangePct(s),
        spreadPct,
        inrPrice: inr,
        inrSource: inrFromDcx ? 'coindcx' : fxr.usdtInr ? 'derived' : null,
        signals,
      })
    }
    return rows.sort((a, b) => b.quoteVolume - a.quoteVolume)
  }

  accountSnapshot() {
    const prices = this.currentPrices()
    const acc = this.paper.account
    const positions = acc.positions.map((p) => {
      const px = prices[p.symbol] ?? p.entry
      const pnl = (p.side === 'LONG' ? px - p.entry : p.entry - px) * p.qty
      return { ...p, mark: px, unrealized: Number(pnl.toFixed(4)), pnlPct: Number(((pnl / (p.entry * p.qty)) * 100).toFixed(3)) }
    })
    return {
      balance: Number(acc.balance.toFixed(2)),
      equity: Number(acc.equity.toFixed(2)),
      initialEquity: acc.initialEquity,
      totalPnl: Number((acc.equity - acc.initialEquity).toFixed(2)),
      dailyPnl: Number(this.risk.state.dailyPnl.toFixed(2)),
      dailyStartEquity: Number(this.risk.state.dailyStartEquity.toFixed(2)),
      positions,
      tradeCount: acc.trades.length,
      winCount: acc.trades.filter((t) => t.pnl > 0).length,
      lossCount: acc.trades.filter((t) => t.pnl <= 0).length,
      equityCurve: acc.equityCurve.slice(-180),
    }
  }

  // ── the agent cycle ──────────────────────────────────────────────────────
  async agentCycle(): Promise<{ cycle: number; candidates: number; verdicts: AgentVerdict[]; source: string }> {
    const cycle = ++this.status.cycle
    this.status.lastScanTs = Date.now()
    this.status.nextScanTs = Date.now() + CONFIG.scanIntervalSec * 1_000
    this.status.binanceRest = restStatus()
    this.status.coindcx = dcx.coindcxStatus()

    try {
      // 1. refresh universe periodically (or when under-sized — e.g. early boot)
      if (Date.now() - this.lastUniverseRefresh > CONFIG.symbolsRefreshMin * 60_000
          || this.symbols.length < CONFIG.symbolUniverseSize) {
        await this.refreshUniverse()
        await this.bootstrapHistory()
      }

      // 2. refresh OI history + CoinDCX prices (background-ish, sequential to be gentle)
      const oiJobs = this.symbols.slice(0, 12).map((s) => getOpenInterestHist(s, '15m', 4).then((h) => { if (h.length) this.oiHist.set(s, h) }))
      await Promise.allSettled(oiJobs)
      const fxr = await dcx.refreshFx()
      this.status.usdtInr = fxr
      this.status.usdtInrSource = dcx.fx().usdtInrSource
      if (await dcx.ensureHealth()) {
        const prices = await dcx.spotInrPrices(this.symbols)
        for (const [k, v] of Object.entries(prices)) this.spotInr.set(k, v)
        const futJobs = this.symbols.map(async (s) => {
          const p = await dcx.futuresPrice(s)
          if (p) this.dcxPrices.set(s, p)
        })
        await Promise.allSettled(futJobs)
      }

      // 3. compute signals
      const rows = this.buildTickerRows(true)
      for (const r of rows) this.scanRows.set(r.symbol, r)
      bus.emit('tickers', rows)

      // 4. pre-filter candidates for the LLM
      const candidates: Candidate[] = rows
        .filter((r) => r.signals && Math.abs(r.signals.composite) >= CONFIG.compositeThreshold && !this.paper.hasPosition(r.symbol))
        .sort((a, b) => Math.abs(b.signals!.composite) - Math.abs(a.signals!.composite))
        .slice(0, CONFIG.maxLlmCandidates)
        .map((r) => ({
          symbol: r.symbol,
          price: r.price,
          composite: r.signals!.composite,
          signals: r.signals!,
          fundingRate: r.fundingRate,
          oiChangePct: r.oiChangePct,
          spreadPct: r.spreadPct,
          inrPrice: r.inrPrice,
          changePct: r.changePct,
        }))

      log('info', 'SCAN', `cycle ${cycle}: ${rows.length} symbols scanned, ${candidates.length} candidate(s) ${candidates.map((c) => `${c.symbol}(${c.composite})`).join(' ')}`)

      // 5. LLM confluence
      const prices = this.currentPrices()
      const { verdicts, source, summary } = await weighCandidates(candidates, {
        equity: this.paper.account.equity || this.paper.account.balance,
        balance: this.paper.account.balance,
        openPositions: this.paper.account.positions.map((p) => ({
          symbol: p.symbol, side: p.side, entry: p.entry,
          pnlPct: ((prices[p.symbol] ?? p.entry) - p.entry) / p.entry * (p.side === 'LONG' ? 1 : -1),
        })),
        dailyPnlPct: this.risk.state.dailyStartEquity ? this.risk.state.dailyPnl / this.risk.state.dailyStartEquity : 0,
      })

      // 6. execute risk-gated entries
      const executed: string[] = []
      const skipped: string[] = []
      for (const v of verdicts) {
        if (v.action === 'HOLD') { skipped.push(`${v.symbol}:hold`); continue }
        const side = v.action === 'BUY' ? 'LONG' : 'SHORT'
        const store = this.candles.get(v.symbol)
        if (!store || store['15m'].length < 25) { skipped.push(`${v.symbol}:no-history`); continue }
        const entry = prices[v.symbol]
        if (!entry) { skipped.push(`${v.symbol}:no-price`); continue }
        const { stop, takeProfit } = bracketFor(store['15m'], side, entry, CONFIG.atrStopMult, CONFIG.tpRewardRisk)
        const plan = this.risk.evaluate({ symbol: v.symbol, side, entry, stop, confidence: v.confidence })
        if (!plan.ok) {
          skipped.push(`${v.symbol}:${plan.reason}`)
          log('info', 'RISK', `rejected ${v.action} ${v.symbol} — ${plan.reason}`)
          continue
        }
        const pos = this.paper.open({
          symbol: v.symbol, side, qty: plan.qty, price: entry, stop, takeProfit,
          confidence: v.confidence, rationale: v.reason,
          strategy: source === 'llm' ? 'llm-confluence' : 'rules-fallback',
          riskUsd: plan.riskUsd,
        })
        executed.push(`${v.symbol}:${pos.side}`)
        bus.emit('account', this.accountSnapshot())
      }

      // 7. supervise open positions every 3rd cycle (staggered)
      if (++this.reviewCounter % 3 === 0) {
        for (const p of this.paper.account.positions) {
          const row = this.scanRows.get(p.symbol)
          if (!row) continue
          const { exit, reason } = await reviewPosition(p, row)
          if (exit) {
            const px = prices[p.symbol] ?? row.price
            this.paper.close(p.id, px, 'agent-exit')
            log('llm', 'AGENT', `supervisor EXIT ${p.symbol}: ${reason}`)
          }
        }
      }

      journal({
        cycle,
        candidates: verdicts.map((v) => ({ symbol: v.symbol, action: v.action, confidence: v.confidence, reason: v.reason })),
        executed,
        skipped,
        source,
        summary,
      })
      bus.emit('account', this.accountSnapshot())
      return { cycle, candidates: candidates.length, verdicts, source }
    } catch (e: any) {
      log('error', 'SCAN', `cycle ${cycle} failed: ${String(e?.message || e).slice(0, 160)}`)
      return { cycle, candidates: 0, verdicts: [], source: 'error' }
    }
  }

  // ── manual actions (UI / CLI / MCP) ──────────────────────────────────────
  manualOrder(input: { symbol: string; side: 'LONG' | 'SHORT'; qty?: number; confidence?: number }): { ok: boolean; detail: string } {
    const symbol = input.symbol.toUpperCase()
    const price = this.currentPrices()[symbol]
    if (!price) return { ok: false, detail: `no live price for ${symbol}` }
    const store = this.candles.get(symbol)
    if (!store || store['15m'].length < 25) return { ok: false, detail: `no candle history for ${symbol} yet` }
    const side = input.side
    const { stop, takeProfit } = bracketFor(store['15m'], side, price, CONFIG.atrStopMult, CONFIG.tpRewardRisk)
    let qty = input.qty
    let riskUsd = 0
    if (!qty) {
      const plan = this.risk.evaluate({ symbol, side, entry: price, stop, confidence: input.confidence ?? 1 })
      if (!plan.ok) return { ok: false, detail: plan.reason }
      qty = plan.qty
      riskUsd = plan.riskUsd
    }
    this.paper.open({
      symbol, side, qty, price, stop, takeProfit,
      confidence: input.confidence ?? 1,
      rationale: 'manual order (dashboard/CLI/MCP)',
      strategy: 'manual',
      riskUsd,
    })
    bus.emit('account', this.accountSnapshot())
    return { ok: true, detail: `opened ${side} ${symbol} qty=${qty} @~${price.toFixed(4)}` }
  }

  closePosition(symbol: string): { ok: boolean; detail: string } {
    const s = symbol.toUpperCase()
    const pos = this.paper.position(s)
    if (!pos) return { ok: false, detail: `no open position in ${s}` }
    const price = this.currentPrices()[s] ?? pos.entry
    const t = this.paper.close(pos.id, price, 'manual')
    bus.emit('account', this.accountSnapshot())
    return { ok: true, detail: `closed ${s} @ ${t?.exit.toFixed(4)} PnL ${t?.pnl.toFixed(2)}` }
  }

  resetPaper() {
    this.paper.reset()
    this.risk.newDay(CONFIG.initialEquity)
    bus.emit('account', this.accountSnapshot())
    return { ok: true, detail: 'paper account reset to 10,000 USDT' }
  }

  snapshot() {
    return {
      status: { ...this.status, symbols: this.symbols },
      tickers: this.buildTickerRows(false),
      account: this.accountSnapshot(),
      logs: recentLogs(120),
      decisions: recentDecisions(20),
      risk: {
        ...this.risk.state,
        cooldownSymbols: Object.entries(this.risk.state.cooldownUntil)
          .filter(([, until]) => until > Date.now())
          .map(([sym, until]) => ({ symbol: sym, minutesLeft: Math.ceil((until - Date.now()) / 60_000) })),
      },
    }
  }
}
