// ─── CoinDCX public market data client (no keys required) ───────────────────
// Mirrors the endpoints CCXT's coindcx adapter uses under the hood:
//   • futures instruments list / candles  → api.coindcx.com/exchange/v1/derivatives/futures/data/*
//   • spot INR prices                     → public.coindcx.com/market_data/v3/current_prices/all
// Some networks (shared cloud egress IPs) sit behind a Cloudflare challenge for
// coindcx.com — the client reports health honestly and the app degrades to a
// clearly-labelled derived INR reference (Binance price × USDT/INR fx).

import { CONFIG } from './config'
import { fetchJson, num } from './util'
import { log } from './store'

export type CoinDcxHealth = 'ok' | 'blocked' | 'down'
let health: CoinDcxHealth = 'down'
let lastCheck = 0
const CHECK_INTERVAL = 5 * 60_000

export const coindcxStatus = () => health

export interface CoinDcxQuote {
  instrument: string      // e.g. "B-BTC_USDT" (futures) or "BTCINR" (spot)
  price: number
}

/** Binance symbol → CoinDCX futures instrument, e.g. BTCUSDT → B-BTC_USDT */
export function toCoindcxFuturesInstrument(symbol: string): string | null {
  if (!symbol.endsWith('USDT')) return null
  return `B-${symbol.slice(0, -4)}_USDT`
}

/** Binance symbol → CoinDCX spot INR market, e.g. BTCUSDT → BTCINR */
export function toCoindcxSpotMarket(symbol: string): string | null {
  if (!symbol.endsWith('USDT')) return null
  return `${symbol.slice(0, -4)}INR`
}

async function probe(): Promise<boolean> {
  // lightweight reachability probe
  try {
    await fetchJson(`${CONFIG.coindcxBases[0]}/exchange/v1/derivatives/futures/data/active_instruments`, {
      timeoutMs: 8_000, retries: 0,
    })
    return true
  } catch (e: any) {
    if (String(e?.message || e).includes('blocked')) health = 'blocked'
    else health = 'down'
    return false
  }
}

export async function ensureHealth(): Promise<boolean> {
  if (Date.now() - lastCheck < CHECK_INTERVAL) return health === 'ok'
  lastCheck = Date.now()
  const ok = await probe()
  if (ok && health !== 'ok') log('info', 'COINDCX', 'connection healthy — live spread scanning enabled')
  if (!ok && health !== 'blocked' && health !== 'down') log('warn', 'COINDCX', 'unreachable')
  health = ok ? 'ok' : health === 'ok' ? 'down' : health
  return ok
}

/** Fetch one futures candlestick batch and return the latest close. */
export async function futuresPrice(symbol: string): Promise<number | null> {
  if (!(await ensureHealth())) return null
  const inst = toCoindcxFuturesInstrument(symbol)
  if (!inst) return null
  try {
    const to = Math.floor(Date.now() / 1000)
    const from = to - 900
    const raw = await fetchJson<any[]>(
      `${CONFIG.coindcxBases[0]}/exchange/v1/derivatives/futures/data/candlesticks?pair=${inst}&from=${from}&to=${to}&resolution=1&tillDate=1`,
      { timeoutMs: 8_000, retries: 1 },
    )
    if (!Array.isArray(raw) || !raw.length) return null
    return num(raw[raw.length - 1]?.close ?? raw[raw.length - 1]?.c)
  } catch {
    return null
  }
}

/** Fetch spot INR prices for a list of Binance symbols. */
export async function spotInrPrices(symbols: string[]): Promise<Record<string, number>> {
  if (!(await ensureHealth())) return {}
  try {
    const all: any[] = await fetchJson(`${CONFIG.coindcxBases[1]}/market_data/v3/current_prices/all`, {
      timeoutMs: 8_000, retries: 1,
    })
    const map: Record<string, number> = {}
    for (const s of symbols) {
      const market = toCoindcxSpotMarket(s)
      const hit = all.find((x) => x.market === market || x.instrument === market)
      if (hit) {
        const p = num(hit.current_price ?? hit.price ?? hit.last_price)
        if (p > 0) map[s] = p
      }
    }
    return map
  } catch {
    return {}
  }
}

// ── USDT/INR fx fallback (CoinGecko public API) ─────────────────────────────
let usdtInr = 0
let usdtInrTs = 0
let usdtInrSource = 'coingecko'
export const fx = () => ({ usdtInr, usdtInrSource })

export async function refreshFx() {
  // If CoinDCX spot works, derive USDT/INR from USDTINR market later; else CoinGecko.
  try {
    const r = await fetchJson<any>(`${CONFIG.coingeckoSimple}?ids=tether&vs_currencies=inr`, {
      timeoutMs: 8_000, retries: 1,
    })
    const v = num(r?.tether?.inr)
    if (v > 0) { usdtInr = v; usdtInrTs = Date.now(); usdtInrSource = 'coingecko (USDT/INR)' }
  } catch { /* keep last value */ }
  if (usdtInr === 0) { usdtInr = 93.7; usdtInrSource = 'static-fallback' } // never leave zero
  return usdtInr
}
