#!/usr/bin/env bun
// ─── MCP server for the crypto intraday trading engine ─────────────────────
// Exposes the engine (Binance + CoinDCX paper trading agent) as MCP tools so
// any MCP host (Claude Desktop, Cursor, Claude Code, …) can drive it.
//
// Run:            bun mcp-server/index.ts
// Engine URL:     ENGINE_URL env var (default http://localhost:3001)
//
// Claude Desktop config example (~/claude_desktop_config.json):
//   {
//     "mcpServers": {
//       "crypto-intraday-agent": {
//         "command": "bun",
//         "args": ["/absolute/path/to/mcp-server/index.ts"],
//         "env": { "ENGINE_URL": "http://localhost:3001" }
//       }
//     }
//   }

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:3005'

async function engineFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { error: text.slice(0, 400) }
  }
}

const server = new McpServer({
  name: 'crypto-intraday-agent',
  version: '1.0.0',
})

// ── read tools ───────────────────────────────────────────────────────────────
server.tool(
  'engine_status',
  'Health & configuration of the intraday trading engine: WS connection, Binance REST state, CoinDCX reachability, symbol universe, agent loop state',
  {},
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(await engineFetch('/engine/status'), null, 2) }],
  }),
)

server.tool(
  'market_snapshot',
  'Full dashboard snapshot: live tickers (price, 24h change, funding, OI change, spread, INR reference), paper account equity/positions, recent logs and LLM decisions',
  {},
  async () => {
    const snap = await engineFetch('/engine/snapshot')
    const slim = {
      status: snap.status,
      tickers: snap.tickers?.map((t: any) => ({
        symbol: t.symbol, price: t.price, changePct24h: t.changePct, fundingRate: t.fundingRate,
        oiChangePct: t.oiChangePct, coindcxSpreadPct: t.spreadPct, inrPrice: t.inrPrice,
        composite: t.signals?.composite ?? null,
      })),
      account: snap.account,
      risk: snap.risk,
    }
    return { content: [{ type: 'text', text: JSON.stringify(slim, null, 2) }] }
  },
)

server.tool(
  'spread_scan',
  'Cross-exchange arbitrage scanner: Binance USDⓈ-M perp price vs CoinDCX perp/spot-INR, plus funding rates',
  {},
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(await engineFetch('/engine/spreads'), null, 2) }],
  }),
)

server.tool(
  'open_positions',
  'Currently open paper positions with live mark price, unrealized PnL and bracket (SL/TP)',
  {},
  async () => {
    const snap = await engineFetch('/engine/snapshot')
    return { content: [{ type: 'text', text: JSON.stringify(snap.account?.positions ?? [], null, 2) }] }
  },
)

server.tool(
  'trade_history',
  'Closed paper trades (most recent first) with PnL, fees and exit reason',
  {},
  async () => {
    const h = await engineFetch('/engine/history')
    return { content: [{ type: 'text', text: JSON.stringify(h.trades ?? [], null, 2) }] }
  },
)

server.tool(
  'agent_decisions',
  'Recent agentic-AI decision journal: candidates, LLM verdicts, executed and skipped trades',
  {},
  async () => {
    const h = await engineFetch('/engine/history')
    return { content: [{ type: 'text', text: JSON.stringify(h.decisions ?? [], null, 2) }] }
  },
)

// ── action tools ─────────────────────────────────────────────────────────────
server.tool(
  'run_scan',
  'Trigger one agent cycle immediately: refresh data → compute quant signals → LLM confluence → risk-gated paper execution. Returns the cycle verdicts.',
  {},
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(await engineFetch('/engine/scan', { method: 'POST' }), null, 2) }],
  }),
)

server.tool(
  'agent_start',
  'Start the autonomous agent loop (full-auto paper trading within risk limits: 2% risk/trade, -3% daily cutoff, max 3 positions)',
  {},
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(await engineFetch('/engine/agent/start', { method: 'POST' }), null, 2) }],
  }),
)

server.tool(
  'agent_stop',
  'Stop the autonomous agent loop (kill switch — open positions keep their TP/SL brackets)',
  {},
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(await engineFetch('/engine/agent/stop', { method: 'POST' }), null, 2) }],
  }),
)

server.tool(
  'place_paper_order',
  'Open a manual paper position (market order at live price, ATR-based SL/TP bracket)',
  {
    symbol: z.string().describe('Binance USDⓈ-M symbol, e.g. BTCUSDT'),
    side: z.enum(['LONG', 'SHORT']),
    qty: z.number().optional().describe('Quantity in base units; omit to auto-size by the 2% risk rule'),
  },
  async ({ symbol, side, qty }) => ({
    content: [{
      type: 'text',
      text: JSON.stringify(await engineFetch('/engine/order', {
        method: 'POST',
        body: JSON.stringify({ symbol, side, qty }),
      }), null, 2),
    }],
  }),
)

server.tool(
  'close_position',
  'Close an open paper position at live price (whole position)',
  { symbol: z.string().describe('Symbol to close, e.g. BTCUSDT') },
  async ({ symbol }) => ({
    content: [{
      type: 'text',
      text: JSON.stringify(await engineFetch(`/engine/close/${encodeURIComponent(symbol)}`, { method: 'POST' }), null, 2),
    }],
  }),
)

server.tool(
  'reset_paper_account',
  'Reset the paper account to 10,000 USDT and clear trade history',
  {},
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(await engineFetch('/engine/reset', { method: 'POST' }), null, 2) }],
  }),
)

// ── Telegram notifier tools ─────────────────────────────────────────────────
server.tool(
  'telegram_status',
  'Show current Telegram notifier status (bot token masked). Notifications are powered by @nemesis-oss/tg-format and send native message entities (no parse_mode needed).',
  {},
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(await engineFetch('/engine/telegram/config'), null, 2) }],
  }),
)

server.tool(
  'telegram_configure',
  'Configure or toggle the Telegram notifier. Pass botToken + chatId (from @BotFather and @userinfobot) to set up, or just enabled=true/false to toggle. The token is persisted in engine/data/telegram.json and never returned in plaintext.',
  {
    botToken: z.string().optional().describe('Bot token from @BotFather, e.g. "123456789:ABCdef…"'),
    chatId: z.string().optional().describe('Target chat id (negative for groups, from @userinfobot)'),
    enabled: z.boolean().optional().describe('Enable or disable all notifications'),
    events: z.object({
      boot: z.boolean().optional(),
      agent: z.boolean().optional(),
      entry: z.boolean().optional(),
      exit: z.boolean().optional(),
      risk_halt: z.boolean().optional(),
      scan_digest: z.boolean().optional(),
    }).optional().describe('Per-event enable flags'),
  },
  async ({ botToken, chatId, enabled, events }) => {
    const body: any = {}
    if (typeof botToken === 'string') body.botToken = botToken
    if (typeof chatId === 'string') body.chatId = chatId
    if (typeof enabled === 'boolean') body.enabled = enabled
    if (events && typeof events === 'object') body.events = events
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(await engineFetch('/engine/telegram/config', {
          method: 'POST',
          body: JSON.stringify(body),
        }), null, 2),
      }],
    }
  },
)

server.tool(
  'telegram_test',
  'Send a Telegram test message to verify the bot token + chat id work. Returns ok=true on success or a description of the failure.',
  {
    message: z.string().optional().describe('Optional custom message body to append to the test message'),
  },
  async ({ message }) => ({
    content: [{
      type: 'text',
      text: JSON.stringify(await engineFetch('/engine/telegram/test', {
        method: 'POST',
        body: JSON.stringify(message ? { message } : {}),
      }), null, 2),
    }],
  }),
)

// ── run ──────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[mcp] crypto-intraday-agent MCP server on stdio → ${ENGINE_URL}`)
}

main().catch((e) => {
  console.error('[mcp] fatal:', e)
  process.exit(1)
})
