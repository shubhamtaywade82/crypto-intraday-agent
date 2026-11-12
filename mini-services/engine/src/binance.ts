// ─── Binance USDⓈ-M futures market data ──────────────────────────────────────
// Primary: combined WebSocket market stream (fstream.binance.com) — avoids the
// REST IP rate-bans observed from shared egress IPs.
// Secondary: REST fapi.binance.com with retries; when weight-banned (-1003) the
// kline bootstrap falls back to the public spot mirror data-api.binance.vision
// (clearly flagged) while true perp candles keep accumulating from WS.

import { CONFIG } from './config'
import { fetchJson, num, sleep } from './util'
import { log } from './store'
import type { Candle } from './types'

// ── REST layer ───────────────────────────────────────────────────────────────
export type RestHealth = 'ok' | 'degraded' | 'down'
let restHealth: RestHealth = 'ok'
let banUntil = 0
export const restStatus = () => restHealth

async function fapi<T>(path: string, qs = ''): Promise<T> {
  if (Date.now() < banUntil) throw new Error(`fapi rate-banned until ${banUntil}`)
  const t0 = Date.now()
  const data = await fetchJson<T>(`${CONFIG.binanceRestBase}${path}${qs ? '?' + qs : ''}`, {
    timeoutMs: 10_000,
    retries: CONFIG.restRetries,
    backoffMs: CONFIG.restBackoffMs,
  })
  restHealth = Date.now() - t0 > 3_000 ? 'degraded' : 'ok'
  return data
}

type RawKline = any[] // [openTime, o,h,l,c,v, closeTime, qv, trades, ...]

function toCandles(raw: RawKline[], closed: boolean): Candle[] {
  return raw.map((k) => ({
    t: num(k[0]),
    o: num(k[1]),
    h: num(k[2]),
    l: num(k[3]),
    c: num(k[4]),
    v: num(k[5]),
    q: num(k[7]),
    closed,
  }))
}

/**
 * Bootstrap candle history. Tries the perp REST endpoint first; on -1003 ban
 * falls back to the public spot mirror (values within ~0.1% of perp — the WS
 * perp stream replaces the tail as live candles close).
 */
export async function getKlines(
  symbol: string,
  interval: '5m' | '15m' | '1h',
  limit: number = CONFIG.klinesBootstrap,
): Promise<{ candles: Candle[]; source: 'perp-rest' | 'spot-mirror' }> {
  const qs = `symbol=${symbol}&interval=${interval}&limit=${limit}`
  try {
    const raw = await fapi<RawKline[]>('/fapi/v1/klines', qs)
    return { candles: toCandles(raw.slice(0, -1), true).concat(raw.length ? [toCandles([raw[raw.length - 1]], false)[0]] : []), source: 'perp-rest' }
  } catch (e: any) {
    if (String(e?.message || e).includes('-1003') || /banned|429|418/.test(String(e?.message || e))) {
      banUntil = Date.now() + 10 * 60_000 // assume 10 min ban window
      restHealth = 'degraded'
    } else {
      restHealth = 'down'
    }
    // spot mirror fallback
    const raw = await fetchJson<RawKline[]>(`${CONFIG.binanceSpotFallbackBase}/api/v3/klines?${qs}`, {
      timeoutMs: 10_000, retries: 2,
    })
    log('warn', 'BINANCE', `klines ${symbol} ${interval}: perp REST unavailable (${String(e?.message || e).slice(0, 80)}), using spot mirror`)
    return { candles: toCandles(raw, true), source: 'spot-mirror' }
  }
}

export async function getOpenInterestHist(symbol: string, period = '15m', limit = 8) {
  try {
    const raw = await fetchJson<any[]>(
      `${CONFIG.binanceRestBase}/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`,
      { timeoutMs: 10_000, retries: 2 },
    )
    return raw.map((r) => ({ ts: num(r.timestamp), oi: num(r.sumOpenInterest), oiValue: num(r.sumOpenInterestValue) }))
  } catch {
    return []
  }
}

/** Settled funding-rate history (8h cadence) for regime z-scoring. */
export async function getFundingRateHistory(symbol: string, limit = 100): Promise<number[]> {
  try {
    const raw = await fetchJson<any[]>(
      `${CONFIG.binanceRestBase}/fapi/v1/fundingRate?symbol=${symbol}&limit=${limit}`,
      { timeoutMs: 10_000, retries: 2 },
    )
    return raw.map((r) => num(r.fundingRate)).filter((v: number) => Number.isFinite(v))
  } catch {
    return []
  }
}

/** Global accounts long/short ratio (crowd positioning). */
export async function getGlobalLongShortRatio(symbol: string, period = '15m', limit = 2): Promise<number | null> {
  try {
    const raw = await fetchJson<any[]>(
      `${CONFIG.binanceRestBase}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=${period}&limit=${limit}`,
      { timeoutMs: 10_000, retries: 1 },
    )
    const last = raw[raw.length - 1]
    return last ? num(last.longShortRatio) : null
  } catch {
    return null
  }
}

/** Top-trader position long/short ratio (smart-money proxy). */
export async function getTopTraderPositionRatio(symbol: string, period = '15m', limit = 2): Promise<number | null> {
  try {
    const raw = await fetchJson<any[]>(
      `${CONFIG.binanceRestBase}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=${period}&limit=${limit}`,
      { timeoutMs: 10_000, retries: 1 },
    )
    const last = raw[raw.length - 1]
    return last ? num(last.longShortRatio) : null
  } catch {
    return null
  }
}

/** Taker buy/sell volume ratio (aggressor flow). */
export async function getTakerLongShortRatio(symbol: string, period = '15m', limit = 2): Promise<number | null> {
  try {
    const raw = await fetchJson<any[]>(
      `${CONFIG.binanceRestBase}/futures/data/takerlongshortRatio?symbol=${symbol}&period=${period}&limit=${limit}`,
      { timeoutMs: 10_000, retries: 1 },
    )
    const last = raw[raw.length - 1]
    return last ? num(last.buySellRatio) : null
  } catch {
    return null
  }
}

export async function getExchangeInfoSymbols(): Promise<Set<string>> {
  try {
    const info = await fetchJson<any>(`${CONFIG.binanceRestBase}/fapi/v1/exchangeInfo`, {
      timeoutMs: 15_000, retries: 3, backoffMs: 2_000,
    })
    const set = new Set<string>()
    for (const s of info.symbols || []) {
      if (s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING') set.add(s.symbol)
    }
    return set
  } catch {
    // conservative fallback list of liquid perps
    return new Set([
      'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT',
      'LINKUSDT','TONUSDT','TRXUSDT','DOTUSDT','LTCUSDT','NEARUSDT','SUIUSDT',
    ])
  }
}

// ── WebSocket layer ──────────────────────────────────────────────────────────
export interface WsState {
  connected: boolean
  lastMsgTs: number
  subscriptions: Set<string>
}

export interface WsHandlers {
  onTicker?: (t: { symbol: string; price: number; changePct: number; high: number; low: number; quoteVolume: number }) => void
  onKline?: (symbol: string, interval: '5m' | '15m' | '1h', candle: Candle) => void
  onMarkPrice?: (m: { symbol: string; mark: number; fundingRate: number; nextFundingMs: number }) => void
  onLiquidation?: (l: { symbol: string; side: 'LONG' | 'SHORT'; price: number; qty: number; notionalUsd: number; ts: number }) => void
  onStatus?: (connected: boolean) => void
}

export class BinanceWs {
  private ws: WebSocket | null = null
  private topics = new Set<string>()
  private reconnectTimer: any = null
  private pingTimer: any = null
  readonly state: WsState = { connected: false, lastMsgTs: 0, subscriptions: new Set() }

  constructor(private handlers: WsHandlers) {}

  subscribe(topics: string[]) {
    let changed = false
    for (const t of topics) {
      if (!this.topics.has(t)) { this.topics.add(t); changed = true }
    }
    if (changed && this.ws && this.state.connected) this.sendSubscribe()
  }

  private sendSubscribe() {
    const list = [...this.topics]
    if (!list.length || !this.ws) return
    this.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: list, id: Date.now() }))
    this.state.subscriptions = new Set(list)
  }

  start() { this.connect() }

  private connect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    // combined stream: /market/stream?streams=a/b/c (2026 routing per skill)
    const seed = [...this.topics].slice(0, 40).join('/')
    const url = seed ? `${CONFIG.binanceWsBase}?streams=${seed}` : CONFIG.binanceWsBase
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (e) {
      log('error', 'WS', `cannot open websocket: ${e}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.state.connected = true
      this.handlers.onStatus?.(true)
      this.sendSubscribe()
      // keepalive: some middleboxes kill idle conns
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => {
        try { if (ws.readyState === 1) ws.send(JSON.stringify({ method: 'LIST_SUBSCRIPTIONS', id: Date.now() })) } catch {}
      }, 240_000)
      log('info', 'WS', `connected to fstream.binance.com (${this.topics.size} topics)`)
    }

    ws.onmessage = (ev) => {
      this.state.lastMsgTs = Date.now()
      let msg: any
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (!msg.stream || !msg.data) return
      const d = msg.data
      // aggregate topics (!ticker@arr, !markPrice@arr) deliver arrays
      const items = Array.isArray(d) ? d : [d]
      for (const it of items) this.dispatch(it)
    }

    ws.onerror = () => { /* onclose follows */ }

    ws.onclose = () => {
      this.state.connected = false
      this.handlers.onStatus?.(false)
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
      log('warn', 'WS', 'disconnected, reconnecting in 5s')
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 5_000)
  }

  private dispatch(d: any) {
    if (d.e === '24hrTicker') {
      this.handlers.onTicker?.({
        symbol: d.s,
        price: num(d.c),
        changePct: num(d.P) / 100,
        high: num(d.h),
        low: num(d.l),
        quoteVolume: num(d.q) || num(d.qv),
      })
    } else if (d.e === 'kline') {
      const k = d.k
      const interval = k.i as '5m' | '15m' | '1h'
      this.handlers.onKline?.(d.s, interval, {
        t: num(k.t), o: num(k.o), h: num(k.h), l: num(k.l), c: num(k.c),
        v: num(k.v), q: num(k.q), closed: !!k.x,
      })
    } else if (d.e === 'markPriceUpdate') {
      this.handlers.onMarkPrice?.({
        symbol: d.s,
        mark: num(d.p),
        fundingRate: num(d.r),
        nextFundingMs: num(d.T),
      })
    } else if (d.e === 'forceOrder') {
      // all-market liquidation stream (!forceOrder@arr)
      const o = d.o
      this.handlers.onLiquidation?.({
        symbol: o.s,
        side: o.S === 'SELL' ? 'LONG' : 'SHORT', // a forced SELL liquidates a long
        price: num(o.p) || num(o.ap),
        qty: num(o.q),
        notionalUsd: num(o.ap) * num(o.q) || num(o.p) * num(o.q),
        ts: num(o.T) || Date.now(),
      })
    }
  }
}
