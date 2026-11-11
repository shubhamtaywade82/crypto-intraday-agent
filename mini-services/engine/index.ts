// ─── Engine service entry — HTTP API (:3001) + socket.io realtime (:3002) ──
// socket.io must use path '/' (gateway requirement), which makes it own every
// request on its listener — so REST and WS live on two ports in one process.
// Next.js dashboard:  fetch('/engine/…?XTransformPort=3001')  +  io('/?XTransformPort=3002')
// CLI / MCP server:   http://localhost:3001/engine/…

import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { CONFIG } from './src/config'
import { TradingEngine } from './src/engine'
import { log, bus, clearPersisted } from './src/store'
import * as tg from './src/telegram'

const engine = new TradingEngine()
const WS_PORT = 3002

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const p = url.pathname
  const json = (code: number, body: unknown) => {
    res.writeHead(code, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'OPTIONS') return json(204, {})
  if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'method not allowed' })

  const readBody = () =>
    new Promise<any>((resolve) => {
      let buf = ''
      req.on('data', (c) => (buf += c))
      req.on('end', () => {
        try { resolve(buf ? JSON.parse(buf) : {}) } catch { resolve({}) }
      })
    })

  try {
    if (p === '/engine/health') return json(200, { ok: true, ts: Date.now() })
    if (p === '/engine/status') return json(200, engine.status)
    if (p === '/engine/snapshot') return json(200, engine.snapshot())

    if (p === '/engine/klines') {
      const symbol = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase()
      const tf = (url.searchParams.get('tf') === '5m' ? '5m' : '15m')
      const limit = Math.min(500, Math.max(50, parseInt(url.searchParams.get('limit') || '200', 10)))
      const store = engine.candles.get(symbol)
      if (!store || !store[tf].length) return json(404, { error: `no history for ${symbol} ${tf}` })
      return json(200, { symbol, tf, candles: store[tf].slice(-limit) })
    }

    if (p === '/engine/scan' && req.method === 'POST') {
      const r = await engine.agentCycle()
      return json(200, r)
    }

    if (p === '/engine/agent/start' && req.method === 'POST') {
      if (!engine.status.running) {
        ;(engine as any).scanTimer = setInterval(() => engine.agentCycle(), CONFIG.scanIntervalSec * 1_000)
        engine.status.running = true
        engine.status.nextScanTs = Date.now() + 1_000
        log('info', 'ENGINE', 'agent loop started by user')
        bus.emit('status', engine.status)
        tg.notifyAgentStart()
      }
      return json(200, { ok: true, running: true })
    }

    if (p === '/engine/agent/stop' && req.method === 'POST') {
      engine.stop()
      return json(200, { ok: true, running: false })
    }

    if (p === '/engine/order' && req.method === 'POST') {
      const body = await readBody()
      const r = engine.manualOrder({
        symbol: String(body.symbol || ''),
        side: body.side === 'SHORT' ? 'SHORT' : 'LONG',
        qty: body.qty ? Number(body.qty) : undefined,
        confidence: body.confidence ? Number(body.confidence) : undefined,
      })
      return json(r.ok ? 200 : 400, r)
    }

    if (p.startsWith('/engine/close/') && req.method === 'POST') {
      const sym = decodeURIComponent(p.split('/')[3] || '')
      const r = engine.closePosition(sym)
      return json(r.ok ? 200 : 400, r)
    }

    if (p === '/engine/reset' && req.method === 'POST') {
      clearPersisted()
      const r = engine.resetPaper()
      return json(200, r)
    }

    if (p === '/engine/history') {
      const trades = engine.paper.account.trades.slice(-100).reverse()
      return json(200, { trades, decisions: engine.snapshot().decisions })
    }

    if (p === '/engine/spreads') {
      const prices = engine.currentPrices()
      const rows = engine.symbols.map((s) => {
        const binance = prices[s] ?? null
        const dcx = engine.dcxPrices.get(s) ?? null
        const inr = engine.spotInr.get(s) ?? null
        return {
          symbol: s,
          binancePerp: binance,
          coindcxPerp: dcx,
          spreadPct: dcx && binance ? Number((((dcx - binance) / binance) * 100).toFixed(3)) : null,
          coindcxSpotInr: inr,
          fundingRate: engine.marks.get(s)?.fundingRate ?? null,
        }
      })
      return json(200, { source: engine.status.coindcx, rows })
    }

    // ── Telegram notifier config + test ──────────────────────────────────────
    if (p === '/engine/telegram/config' && req.method === 'GET') {
      return json(200, tg.getSafeConfig())
    }
    if (p === '/engine/telegram/config' && req.method === 'POST') {
      const body = await readBody()
      const patch: any = {}
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
      if (typeof body.botToken === 'string') patch.botToken = body.botToken.trim()
      if (typeof body.chatId === 'string') patch.chatId = String(body.chatId).trim()
      if (typeof body.minIntervalMs === 'number' && body.minIntervalMs >= 500 && body.minIntervalMs <= 60_000) patch.minIntervalMs = body.minIntervalMs
      if (body.events && typeof body.events === 'object') {
        const current = tg.getConfig().events
        const next: Record<string, boolean> = { ...current }
        for (const k of Object.keys(current)) {
          if (typeof body.events[k] === 'boolean') next[k] = body.events[k]
        }
        patch.events = next as any
      }
      const cfg = tg.updateConfig(patch)
      bus.emit('status', engine.status) // nudge clients to refresh snapshot
      return json(200, { ok: true, config: { ...cfg, botToken: undefined } })
    }
    if (p === '/engine/telegram/test' && req.method === 'POST') {
      const body = await readBody().catch(() => ({}))
      const r = await tg.notifyTest(typeof body?.message === 'string' ? body.message : undefined)
      return json(r.ok ? 200 : 400, r)
    }

    return json(404, { error: `unknown route ${p}` })
  } catch (e: any) {
    log('error', 'HTTP', `${req.method} ${p} → ${String(e?.message || e).slice(0, 140)}`)
    return json(500, { error: String(e?.message || e) })
  }
})

// ── socket.io (path MUST be '/' per gateway rules) on its own listener ──────
const wsServer = createServer()
const io = new Server(wsServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60_000,
  pingInterval: 25_000,
})

io.on('connection', (socket) => {
  socket.emit('snapshot', engine.snapshot())
  socket.on('subscribe:chart', (payload: { symbol?: string; tf?: string }) => {
    socket.data.chart = payload?.symbol && payload?.tf ? `${payload.symbol.toUpperCase()}:${payload.tf === '5m' ? '5m' : '15m'}` : null
  })
})

for (const evt of ['tickers', 'account', 'log', 'status'] as const) {
  bus.on(evt, (payload) => io.emit(evt, payload))
}
bus.on('kline', (k) => {
  // forward kline only to clients viewing that symbol+tf
  for (const [, sock] of io.sockets.sockets) {
    if (sock.data.chart === `${k.symbol}:${k.interval}`) sock.emit('kline', k)
  }
})

httpServer.listen(CONFIG.port, () => {
  log('info', 'HTTP', `engine REST API listening on :${CONFIG.port}`)
})
wsServer.listen(WS_PORT, () => {
  log('info', 'WS', `engine socket.io listening on :${WS_PORT}`)
})

engine.start().catch((e) => {
  log('error', 'ENGINE', `fatal: ${e}`)
  setTimeout(() => process.exit(1), 1_000)
})

process.on('SIGTERM', () => { httpServer.close(() => process.exit(0)) })
process.on('SIGINT', () => { httpServer.close(() => process.exit(0)) })
