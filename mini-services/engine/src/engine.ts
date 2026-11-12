// ─── Engine orchestrator — wires data, strategies, agent, paper account ─────

import { CONFIG } from './config'
import {
  BinanceWs, getKlines, getOpenInterestHist, getExchangeInfoSymbols, restStatus,
  getFundingRateHistory, getGlobalLongShortRatio, getTopTraderPositionRatio, getTakerLongShortRatio,
} from './binance'
import * as dcx from './coindcx'
import { computeSignals, computeExtendedSignals, toSignalSet, bracketFor } from './strategies'
import { PaperEngine } from './paper'
import { RiskManager } from './risk'
import { weighCandidates, journal, reviewPosition, type Candidate, type AgentVerdict } from './agent'
import { log, bus, recentLogs, recentDecisions } from './store'
import * as tg from './telegram'
import type { LiquidationEvent } from './derivatives'
import {
  rsi, macd, adx, superTrend, ichimoku, vwap, squeeze, stochastic, obv, mfi, ema,
  donchian, keltner, cci, williamsR, atr as atrOf, bollinger, cmf, cvdSlope, divergence,
} from './indicators'
import type { Candle, EngineStatus, TickerRow, ClosedTrade, Position } from './types'

export class TradingEngine {
  paper = new PaperEngine()
  risk = new RiskManager(() => this.paper.account)

  // live data maps
  tickers = new Map<string, { symbol: string; price: number; changePct: number; high: number; low: number; quoteVolume: number }>()
  marks = new Map<string, { mark: number; fundingRate: number; nextFundingMs: number }>()
  candles = new Map<string, { '5m': Candle[]; '15m': Candle[]; '1h': Candle[] }>()
  oiHist = new Map<string, { ts: number; oi: number; oiValue: number }[]>()
  dcxPrices = new Map<string, number>()       // CoinDCX futures price per Binance symbol
  spotInr = new Map<string, number>()          // CoinDCX spot INR
  scanRows = new Map<string, TickerRow>()      // last computed dashboard rows
  // ── v2 derivatives data ──
  liquidations = new Map<string, LiquidationEvent[]>()                          // rolling 1h liquidation window
  lsRatios = new Map<string, { global: number | null; top: number | null; taker: number | null; ts: number }>()
  fundingHist = new Map<string, number[]>()                                     // settled funding (8h) for z-scoring
  scanExtended = new Map<string, ReturnType<typeof computeExtendedSignals>>()    // full extended signal sets from the last scan

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
  private lastHaltReason: string | null = null
  private tgWired = false
  private isScanning = false

  // ── lifecycle ────────────────────────────────────────────────────────────
  async start() {
    log('info', 'ENGINE', 'starting intraday engine (paper mode)…')
    const utcMidnight = new Date().setUTCHours(0, 0, 0, 0)
    const realizedToday = this.paper.account.trades.filter((t) => t.closedAt >= utcMidnight).reduce((sum, t) => sum + t.pnl, 0)
    this.risk.restoreDay(this.paper.account.balance - realizedToday)
    this.wireTelegram()
    dcx.refreshFx().then(() => { this.status.usdtInr = dcx.fx().usdtInr; this.status.usdtInrSource = dcx.fx().usdtInrSource })

    this.ws = new BinanceWs({
      onStatus: (c) => {
        this.status.wsConnected = c
        bus.emit('status', this.status)
      },
      onTicker: (t) => { this.tickers.set(t.symbol, t) },
      onMarkPrice: (m) => { this.marks.set(m.symbol, m) },
      onLiquidation: (l) => { this.recordLiquidation(l) },
      onKline: (symbol, interval, candle) => {
        const store = this.candles.get(symbol)
        if (!store) return
        const arr = store[interval]
        if (!arr) return
        if (!arr.length) { arr.push(candle); return }
        const last = arr[arr.length - 1]
        if (candle.t === last.t) arr[arr.length - 1] = candle
        else if (candle.t > last.t) {
          arr.push(candle)
          const cap = CONFIG.klinesBootstrap + 60
          if (arr.length > cap) arr.splice(0, arr.length - cap)
        }
        bus.emit('kline', { symbol, interval, candle })
      },
    })
    this.ws.start()
    // aggregate stream powers the universe + ticker rows; forceOrder = liquidations
    this.ws.subscribe(['!ticker@arr', '!forceOrder@arr'])

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

    // position management heartbeat (5s): trailing stops, TP/SL + equity
    setInterval(() => {
      const prices = this.currentPrices()
      // v2: chandelier trailing stops — only ever tighten
      if (CONFIG.trailingStopEnabled) {
        for (const p of this.paper.account.positions) {
          const store = this.candles.get(p.symbol)
          const px = prices[p.symbol]
          if (!store || !px) continue
          const newStop = this.risk.applyTrailingStop(p, px, store['15m'])
          if (newStop !== null) {
            p.stop = newStop
            bus.emit('positions', this.paper.account.positions)
          }
        }
      }
      const closedNow = this.paper.checkBrackets(prices, CONFIG.maxPositionAgeMin * 60_000)
      // v2: feed the risk manager (loss streaks, Kelly stats, cooldowns)
      for (const t of closedNow) {
        this.risk.noteTradeResult(t.pnl)
        if (t.closeReason === 'stop-loss') this.risk.noteStopLoss(t.symbol)
      }
      this.paper.markToMarket(prices)
      this.paper.pushEquityPoint()
      const { halted, reason } = this.risk.refresh(this.paper.account.equity)
      if (halted && reason && this.paper.account.positions.length === 0) {
        // log + telegram halt once per reason
        if (this.lastHaltReason !== reason) {
          log('warn', 'RISK', reason)
          tg.notifyRiskHalt(reason, this.risk.state.dailyPnl, this.risk.state.dailyStartEquity)
          this.lastHaltReason = reason
        }
      } else if (this.lastHaltReason && !halted) {
        // recovered — clear so a future halt can notify again
        this.lastHaltReason = null
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
    tg.notifyBoot({
      cycle: this.status.cycle,
      symbols: this.symbols,
      scanIntervalSec: CONFIG.scanIntervalSec,
      equity: this.paper.account.equity,
    })
  }

  stop() {
    if (this.scanTimer) clearInterval(this.scanTimer)
    this.scanTimer = null
    this.status.running = false
    this.status.nextScanTs = null
    log('info', 'ENGINE', 'agent loop stopped by user')
    bus.emit('status', this.status)
    tg.notifyAgentStop()
  }

  /** Subscribe to bus events that drive Telegram notifications. Idempotent. */
  private wireTelegram() {
    if (this.tgWired) return
    this.tgWired = true
    bus.on('position:opened', (pos: Position) => tg.notifyEntry({
      symbol: pos.symbol, side: pos.side, qty: pos.qty, entry: pos.entry,
      stop: pos.stop, takeProfit: pos.takeProfit, confidence: pos.confidence,
      rationale: pos.rationale, strategy: pos.strategy, riskUsd: pos.riskUsd,
    }))
    bus.on('position:closed', (t: ClosedTrade) => tg.notifyExit({
      symbol: t.symbol, side: t.side, entry: t.entry, exit: t.exit, qty: t.qty,
      pnl: t.pnl, fees: t.fees, closeReason: t.closeReason, strategy: t.strategy,
      openedAt: t.openedAt, closedAt: t.closedAt, rationale: t.rationale,
    }))
  }

  // ── universe & history ───────────────────────────────────────────────────
  async refreshUniverse() {
    if (!this.perpetuals.size) this.perpetuals = await getExchangeInfoSymbols()
    const rows = [...this.tickers.values()]
      .filter((t) => this.perpetuals.has(t.symbol) && t.quoteVolume > CONFIG.minQuoteVolumeUsd && Math.abs(t.changePct) <= CONFIG.maxAbsChangePct && !this.noDataSymbols.has(t.symbol))
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
      topics.push(`${s.toLowerCase()}@kline_5m`, `${s.toLowerCase()}@kline_15m`, `${s.toLowerCase()}@kline_1h`, `${s.toLowerCase()}@markPrice@1s`)
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
      this.candles.set(s, { '5m': [], '15m': [], '1h': [] })
      try {
        const [m15, m5, h1] = await Promise.all([
          getKlines(s, '15m'),
          getKlines(s, '5m'),
          getKlines(s, '1h', 160),
        ])
        this.candles.set(s, { '15m': m15.candles, '5m': m5.candles, '1h': h1.candles })
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

  /** All-market liquidation stream → per-symbol rolling window. */
  private recordLiquidation(l: { symbol: string; side: 'LONG' | 'SHORT'; price: number; qty: number; notionalUsd: number; ts: number }) {
    const arr = this.liquidations.get(l.symbol) ?? []
    arr.push({ ts: l.ts, symbol: l.symbol, side: l.side, price: l.price, qty: l.qty, notionalUsd: l.notionalUsd })
    const cutoff = Date.now() - CONFIG.liquidationWindowMs
    while (arr.length && (arr[0].ts < cutoff || arr.length > 500)) arr.shift()
    this.liquidations.set(l.symbol, arr)
  }

  /** Strategy inputs for a symbol (shared by ticker rows + deep analysis). */
  private strategyInputs(symbol: string, price: number, spreadPct: number | null) {
    const store = this.candles.get(symbol)
    const m = this.marks.get(symbol)
    const ls = this.lsRatios.get(symbol)
    const liq = this.liquidations.get(symbol) ?? []
    const liqLong = liq.filter((e) => e.side === 'LONG').reduce((a, e) => a + e.notionalUsd, 0)
    const liqShort = liq.filter((e) => e.side === 'SHORT').reduce((a, e) => a + e.notionalUsd, 0)
    return {
      symbol,
      m15: store?.['15m'] ?? [],
      m5: store?.['5m'] ?? [],
      h1: store?.['1h'] ?? [],
      fundingRate: m?.fundingRate ?? 0,
      fundingHistory: this.fundingHist.get(symbol) ?? [],
      oiChangePct: this.oiChangePct(symbol),
      spreadPct,
      lsRatio: ls?.global ?? null,
      topTraderRatio: ls?.top ?? null,
      takerRatio: ls?.taker ?? null,
      liquidations: liq,
      spotRef: null,
      price24hChgPct: this.tickers.get(symbol)?.changePct ?? null,
      liqLongUsd: liqLong,
      liqShortUsd: liqShort,
    }
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
      const ls = this.lsRatios.get(s)
      const liq = this.liquidations.get(s) ?? []
      const liqLong = liq.filter((e) => e.side === 'LONG').reduce((a, e) => a + e.notionalUsd, 0)
      const liqShort = liq.filter((e) => e.side === 'SHORT').reduce((a, e) => a + e.notionalUsd, 0)

      let signals: TickerRow['signals'] = null
      if (withSignals && store && store['15m'].length > 25 && store['5m'].length > 25) {
        const inputs = this.strategyInputs(s, price, spreadPct)
        if (CONFIG.extendedSignals) {
          const x = computeExtendedSignals(inputs)
          this.scanExtended.set(s, x)   // stash the full set for candidate building
          signals = toSignalSet(x)
        } else {
          signals = computeSignals(inputs)
        }
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
        lsRatio: ls?.global ?? null,
        topTraderRatio: ls?.top ?? null,
        takerRatio: ls?.taker ?? null,
        liqLongUsd: Number(liqLong.toFixed(0)),
        liqShortUsd: Number(liqShort.toFixed(0)),
        liqCascade: liqLong + liqShort > CONFIG.liquidationBaselineUsd * 2
          && Math.abs(liqLong - liqShort) / (liqLong + liqShort || 1) > 0.7,
        basisPct: null,
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
    if (this.isScanning) {
      log('info', 'SCAN', 'scan pass already active — skipping overlap')
      return { cycle: this.status.cycle, candidates: 0, verdicts: [], source: 'skipped' }
    }
    this.isScanning = true
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

      // 2b. v2: long/short ratios (every 4 cycles ≈ 4 min — 15m data cadence)
      if (CONFIG.fetchLsRatios && cycle % 4 === 1) {
        const ratioJobs = this.symbols.slice(0, 8).map(async (s) => {
          const [g, top, taker] = await Promise.all([
            getGlobalLongShortRatio(s),
            getTopTraderPositionRatio(s),
            getTakerLongShortRatio(s),
          ])
          if (g !== null || top !== null || taker !== null) {
            this.lsRatios.set(s, { global: g, top, taker, ts: Date.now() })
          }
        })
        await Promise.allSettled(ratioJobs)
      }

      // 2c. v2: funding-rate history (every 20 cycles ≈ 20 min — funding settles 8h)
      if (cycle % 20 === 2) {
        const fundJobs = this.symbols.slice(0, 10).map(async (s) => {
          const hist = await getFundingRateHistory(s, 100)
          if (hist.length > 5) this.fundingHist.set(s, hist)
        })
        await Promise.allSettled(fundJobs)
      }

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
        .map((r) => {
          const ext = this.scanExtended.get(r.symbol)
          return {
            symbol: r.symbol,
            price: r.price,
            composite: r.signals!.composite,
            signals: r.signals!,
            fundingRate: r.fundingRate,
            oiChangePct: r.oiChangePct,
            spreadPct: r.spreadPct,
            inrPrice: r.inrPrice,
            changePct: r.changePct,
            regime: r.signals?.regime?.label,
            regimeNote: r.signals?.regime?.note,
            confluence: ext?.confluence,
            derivatives: ext?.derivatives,
            structureTrend: ext?.structure.trend,
            activeSetups: r.signals?.confluence?.setups.filter((x) => x.dir !== 0 && x.strength >= 0.55).map((x) => `${x.name}(dir=${x.dir > 0 ? 'long' : 'short'},str=${x.strength})`),
            liqNote: r.liqCascade ? `cascade: $${((r.liqLongUsd ?? 0) / 1000).toFixed(0)}k L / $${((r.liqShortUsd ?? 0) / 1000).toFixed(0)}k S rekt` : undefined,
          }
        })

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
        const plan = this.risk.evaluate({ symbol: v.symbol, side, entry, stop, confidence: v.confidence, candles: store['15m'] })
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
          const heldMin = (Date.now() - p.openedAt) / 60_000
          const isLosing = (p.side === 'LONG' ? row.price - p.entry : p.entry - row.price) < 0
          // winners run to take-profit; a 2B model must not cut them
          if (heldMin < CONFIG.minHoldBeforeReviewMin || !isLosing) continue
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
      // telegram scan digest (only when something actually executed — avoids spam on HOLD cycles)
      if (executed.length) {
        tg.notifyScanDigest({
          cycle, source,
          candidates: candidates.length,
          executed, skipped,
          summary: summary || 'no actionable setups',
        })
      }
      return { cycle, candidates: candidates.length, verdicts, source }
    } catch (e: any) {
      log('error', 'SCAN', `cycle ${cycle} failed: ${String(e?.message || e).slice(0, 160)}`)
      return { cycle, candidates: 0, verdicts: [], source: 'error' }
    } finally {
      this.isScanning = false
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

  /**
   * Deep single-symbol analysis for the UI / CLI / MCP `deep_analysis` tool:
   * every indicator family, structure snapshot, derivatives context, regime,
   * confluence stacks and named setups in one payload.
   */
  deepAnalysis(symbol: string) {
    const s = symbol.toUpperCase()
    const store = this.candles.get(s)
    const price = this.currentPrices()[s]
    if (!store || !price || store['15m'].length < 30) {
      return { ok: false as const, error: `no history for ${s} yet (bootstrapping or unknown symbol)` }
    }
    const dcxPx = this.dcxPrices.get(s) ?? null
    const spreadPct = dcxPx ? ((dcxPx - price) / price) * 100 : null
    const inputs = this.strategyInputs(s, price, spreadPct)
    const x = computeExtendedSignals(inputs)
    const closed15 = store['15m'].filter((c) => c.closed)
    const closes = closed15.map((c) => c.c)
    const rsiSeries = rsi(closes, 14)
    const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50)
    const n = closes.length - 1
    const indicators = {
      ema: { e9: e9[n] ?? null, e21: e21[n] ?? null, e50: e50[n] ?? null },
      rsi14: rsiSeries[rsiSeries.length - 1] ?? null,
      rsiDivergence: divergence(closed15, rsiSeries).type,
      macd: macd(closes),
      stoch: stochastic(closed15),
      cci: cci(closed15),
      williamsR: williamsR(closed15),
      adx: adx(closed15),
      superTrend: superTrend(closed15),
      ichimoku: ichimoku(closed15),
      vwap: vwap(closed15),
      bollinger: bollinger(closes),
      keltner: keltner(closed15),
      donchian: donchian(closed15),
      squeeze: squeeze(closes, closed15, 100),
      obvSlope: obv(closed15).length ? obv(closed15).slice(-20) : [],
      mfi: mfi(closed15),
      cmf: cmf(closed15),
      cvdSlope: cvdSlope(closed15),
      atr: atrOf(closed15),
    }
    return {
      ok: true as const,
      symbol: s,
      price,
      generatedAt: Date.now(),
      indicators,
      structure: x.structure,
      derivatives: x.derivatives,
      regime: x.regime,
      families: {
        momentum: x.momentum,
        meanRev: x.meanRev,
        spread: x.spread,
        liquiditySweep: x.liquiditySweep,
        squeezeBreakout: x.squeezeBreakout,
        orderBlock: x.orderBlock,
        sessionBreakout: x.sessionBreakout,
        fundingFlip: x.fundingFlip,
        cascadeSnapback: x.cascadeSnapback,
        vwapReversion: x.vwapReversion,
      },
      confluence: x.confluence,
      setups: x.setups,
      composite: x.composite,
      signalSet: toSignalSet(x),
    }
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
        lossStreak: this.risk.lossStreak,
        winStreak: this.risk.winStreak,
        sizingMode: CONFIG.sizingMode,
        trailingStop: CONFIG.trailingStopEnabled ? `${CONFIG.trailingStopAtrMult}×ATR` : 'off',
        cooldownSymbols: Object.entries(this.risk.state.cooldownUntil)
          .filter(([, until]) => until > Date.now())
          .map(([sym, until]) => ({ symbol: sym, minutesLeft: Math.ceil((until - Date.now()) / 60_000) })),
      },
      telegram: tg.getSafeConfig(),
    }
  }
}
