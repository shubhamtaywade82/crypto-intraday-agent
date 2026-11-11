#!/usr/bin/env bun
// ─── Headless CLI for the crypto intraday trading engine ────────────────────
// Shares the exact same engine as the web dashboard (via its REST API).
//
//   bun cli/agent-cli.ts status
//   bun cli/agent-cli.ts scan                 # one agent cycle now
//   bun cli/agent-cli.ts start | stop         # autonomous loop on/off
//   bun cli/agent-cli.ts positions | history | decisions | spreads
//   bun cli/agent-cli.ts open BTCUSDT LONG [qty]
//   bun cli/agent-cli.ts close BTCUSDT
//   bun cli/agent-cli.ts reset
//   bun cli/agent-cli.ts tg-status | tg-on | tg-off
//   bun cli/agent-cli.ts tg-set <chatId> <botToken>
//   bun cli/agent-cli.ts tg-test [message]

const BASE = process.env.ENGINE_URL || 'http://localhost:3005'

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m', DIM = '\x1b[2m', RESET = '\x1b[0m'
const c = (code: string, s: string | number) => `${code}${s}${RESET}`
const pct = (n: number) => `${n >= 0 ? GREEN : RED}${(n * 100).toFixed(2)}%${RESET}`
const usd = (n: number) => `${n >= 0 ? '' : RED}${n.toFixed(2)}${RESET}`

async function api(path: string, method = 'GET'): Promise<any> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(90_000),
    })
    return await res.json()
  } catch (e: any) {
    console.error(`${c(RED, 'engine unreachable')} — is it running? (bun run dev in mini-services/engine)\n${e?.message || e}`)
    process.exit(1)
  }
}

async function apiPost(path: string, body?: unknown): Promise<any> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    return await res.json()
  } catch (e: any) {
    console.error(`${c(RED, 'engine unreachable')} — ${e?.message || e}`)
    process.exit(1)
  }
}

function box(title: string, lines: string[]) {
  console.log(`\n${c(CYAN, '─'.repeat(72))}`)
  console.log(`${c(CYAN, `  ${title}`)}`)
  console.log(c(CYAN, '─'.repeat(72)))
  for (const l of lines) console.log(`  ${l}`)
}

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false })

const cmd = process.argv[2] || 'status'
const arg1 = process.argv[3]
const arg2 = process.argv[4]

switch (cmd) {
  case 'status': {
    const s = await api('/engine/status')
    box('ENGINE STATUS', [
      `agent loop    : ${s.running ? c(GREEN, 'RUNNING') : c(YELLOW, 'STOPPED')} (cycle #${s.cycle}, every ${s.scanIntervalSec}s)`,
      `mode          : ${s.mode.toUpperCase()} (simulated fills at live Binance prices)`,
      `binance ws    : ${s.wsConnected ? c(GREEN, 'connected') : c(RED, 'down')}`,
      `binance rest  : ${s.binanceRest === 'ok' ? c(GREEN, s.binanceRest) : c(YELLOW, s.binanceRest)}`,
      `coindcx       : ${s.coindcx === 'ok' ? c(GREEN, 'live spreads') : c(YELLOW, s.coindcx + ' → derived INR reference')}`,
      `usdt/inr      : ${s.usdtInr} (${s.usdtInrSource})`,
      `universe      : ${s.symbols?.join(', ')}`,
      `last scan     : ${s.lastScanTs ? fmtTime(s.lastScanTs) : '—'}   next: ${s.nextScanTs ? fmtTime(s.nextScanTs) : '—'}`,
    ])
    break
  }

  case 'snapshot': {
    const s = await api('/engine/snapshot')
    const a = s.account
    box('ACCOUNT (PAPER)', [
      `equity        : ${usd(a.equity)} USDT (start ${a.initialEquity})`,
      `total PnL     : ${usd(a.totalPnl)} USDT   daily: ${usd(a.dailyPnl)} USDT`,
      `balance       : ${usd(a.balance)} USDT`,
      `positions     : ${a.positions.length} open   trades: ${a.tradeCount} (W ${a.winCount} / L ${a.lossCount})`,
    ])
    box('MARKET', s.tickers.map((t: any) =>
      `${t.symbol.padEnd(12)} ${String(t.price).padEnd(12)} 24h ${String((t.changePct * 100).toFixed(2) + '%').padStart(8)}  fund ${(t.fundingRate * 100).toFixed(4)}%  OI ${t.oiChangePct === null ? '  n/a' : t.oiChangePct.toFixed(2) + '%'}  ${t.signals ? 'composite ' + t.signals.composite : ''}`,
    ))
    break
  }

  case 'scan': {
    console.log(`${c(DIM, 'running one agent cycle…')}`)
    const r = await api('/engine/scan', 'POST')
    box(`CYCLE #${r.cycle} — source: ${r.source}`, r.verdicts.length
      ? r.verdicts.map((v: any) => `${v.symbol.padEnd(12)} ${v.action === 'BUY' ? c(GREEN, 'BUY ') : v.action === 'SELL' ? c(RED, 'SELL') : c(DIM, 'HOLD')}  conf ${(v.confidence * 100).toFixed(0)}%  ${v.reason}`)
      : ['no candidates passed the pre-filter this cycle'])
    break
  }

  case 'start': {
    const r = await api('/engine/agent/start', 'POST')
    console.log(c(GREEN, `agent loop started — full-auto paper trading within risk limits`))
    break
  }

  case 'stop': {
    const r = await api('/engine/agent/stop', 'POST')
    console.log(c(YELLOW, 'agent loop stopped (open positions keep their TP/SL brackets)'))
    break
  }

  case 'positions': {
    const s = await api('/engine/snapshot')
    const ps = s.account.positions
    box('OPEN POSITIONS', ps.length
      ? ps.map((p: any) =>
          `${p.symbol.padEnd(12)} ${p.side === 'LONG' ? c(GREEN, 'LONG ') : c(RED, 'SHORT')} qty ${String(p.qty).padEnd(10)} entry ${String(p.entry).padEnd(12)} mark ${String(p.mark).padEnd(12)} PnL ${usd(p.unrealized)} (${p.pnlPct}%)  SL ${p.stop} TP ${p.takeProfit}\n              ${c(DIM, p.rationale)}`)
      : ['flat — no open positions'])
    break
  }

  case 'history': {
    const h = await api('/engine/history')
    const ts = h.trades ?? []
    box('TRADE HISTORY (last 100)', ts.length
      ? ts.map((t: any) =>
          `${fmtTime(t.closedAt)} ${t.symbol.padEnd(12)} ${t.side === 'LONG' ? c(GREEN, 'LONG ') : c(RED, 'SHORT')} in ${t.entry} → out ${t.exit}  ${t.closeReason.padEnd(12)} PnL ${usd(t.pnl)} (${t.strategy})`)
      : ['no closed trades yet'])
    break
  }

  case 'decisions': {
    const h = await api('/engine/history')
    const ds = h.decisions ?? []
    box('AGENT DECISION JOURNAL', ds.length
      ? ds.slice(-15).reverse().map((d: any) =>
          `${fmtTime(d.ts)} cycle ${String(d.cycle).padEnd(4)} [${d.source}]\n              ${d.summary}`)
      : ['no decisions yet — run a scan'])
    break
  }

  case 'spreads': {
    const r = await api('/engine/spreads')
    box(`CROSS-EXCHANGE SPREADS (coindcx: ${r.source})`, r.rows.map((row: any) =>
      `${row.symbol.padEnd(12)} binance ${String(row.binancePerp).padEnd(12)} coindcx ${String(row.coindcxPerp ?? 'n/a').padEnd(12)} spread ${row.spreadPct === null ? c(DIM, 'n/a') : (row.spreadPct >= 0 ? c(GREEN, '+') : c(RED, '')) + row.spreadPct + '%'}  funding ${row.fundingRate === null ? 'n/a' : (row.fundingRate * 100).toFixed(4) + '%'}`,
    ))
    break
  }

  case 'open': {
    if (!arg1 || !arg2) { console.error('usage: open <SYMBOL> <LONG|SHORT> [qty]'); process.exit(1) }
    const res = await fetch(`${BASE}/engine/order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: arg1.toUpperCase(), side: arg2.toUpperCase(), qty: process.argv[5] ? Number(process.argv[5]) : undefined }),
    })
    const j = await res.json() as any
    console.log(j.ok ? c(GREEN, `✓ ${j.detail}`) : c(RED, `✗ ${j.detail}`))
    break
  }

  case 'close': {
    if (!arg1) { console.error('usage: close <SYMBOL>'); process.exit(1) }
    const r = await api(`/engine/close/${encodeURIComponent(arg1.toUpperCase())}`, 'POST')
    console.log(r.ok ? c(GREEN, `✓ ${r.detail}`) : c(RED, `✗ ${r.detail}`))
    break
  }

  case 'reset': {
    const r = await api('/engine/reset', 'POST')
    console.log(c(GREEN, `✓ ${r.detail}`))
    break
  }

  // ── Telegram notifier ────────────────────────────────────────────────────
  case 'tg-status': {
    const t = await api('/engine/telegram/config')
    box('TELEGRAM NOTIFIER', [
      `enabled     : ${t.enabled ? c(GREEN, 'ON') : c(YELLOW, 'OFF')}`,
      `bot token   : ${t.hasToken ? c(GREEN, t.tokenMasked) : c(DIM, '(not set)')}`,
      `chat id     : ${t.chatId || c(DIM, '(not set)')}`,
      `min interval: ${t.minIntervalMs}ms`,
      `events      : ${Object.entries(t.events as Record<string, boolean>).filter(([, v]) => v).map(([k]) => k).join(', ') || c(DIM, 'none')}`,
    ])
    break
  }
  case 'tg-set': {
    if (!arg1 || !arg2) { console.error('usage: tg-set <chatId> <botToken>'); process.exit(1) }
    const r = await apiPost('/engine/telegram/config', { chatId: arg1, botToken: arg2, enabled: true })
    console.log(r.ok ? c(GREEN, `✓ telegram configured — chat ${arg1}`) : c(RED, `✗ ${r.error || 'failed'}`))
    break
  }
  case 'tg-on': {
    const r = await apiPost('/engine/telegram/config', { enabled: true })
    console.log(r.ok ? c(GREEN, '✓ telegram notifications enabled') : c(RED, `✗ ${r.error || 'failed'}`))
    break
  }
  case 'tg-off': {
    const r = await apiPost('/engine/telegram/config', { enabled: false })
    console.log(r.ok ? c(YELLOW, '⏸ telegram notifications disabled') : c(RED, `✗ ${r.error || 'failed'}`))
    break
  }
  case 'tg-test': {
    const msg = arg1 || undefined
    const r = await apiPost('/engine/telegram/test', msg ? { message: msg } : {})
    console.log(r.ok ? c(GREEN, `✓ ${r.detail}`) : c(RED, `✗ ${r.detail || r.error || 'failed'}`))
    break
  }

  default:
    console.log(`crypto intraday agent CLI — engine at ${BASE}

commands:
  status        engine health, universe, agent loop state
  snapshot      account + market overview
  scan          run one agent cycle now (signals → LLM → risk-gated fills)
  start | stop  autonomous loop on/off
  positions     open positions with live PnL
  history       closed trades
  decisions     agentic-AI decision journal
  spreads       Binance vs CoinDCX spread scanner
  open SYM LONG|SHORT [qty]   manual paper order
  close SYM     close a position
  reset         reset paper account to 10,000 USDT

telegram notifier (powered by @nemesis-oss/tg-format):
  tg-status                show current telegram config (token masked)
  tg-set <chatId> <token>  configure chat + bot token, enable notifications
  tg-on | tg-off           toggle the notifier
  tg-test [message]        send a test message (verifies bot token + chat id)`)
}
