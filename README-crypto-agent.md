# Crypto Intraday Agent — Binance + CoinDCX · MCP · Agentic AI

A full-auto **intraday crypto futures paper-trading system** built from skills discovered via `npx skills find` (the vercel-labs **find-skills** flow):

- **Binance USDⓈ-M futures** market data + trading semantics — from the official `binance/binance-skills-hub` skill family (`derivatives-trading-usds-futures`, market-data, paper-trading, algo-trading, `binance-usdm-futures-tools` for the MCP/tool layer)
- **CoinDCX** public market data — per the `ccxt/ccxt@ccxt-python` skill (same public endpoints CCXT's coindcx adapter wraps; implemented natively in TypeScript here)
- **Agentic AI** — a crypto-trading-agent decision core powered by `z-ai-web-dev-sdk` (LLM confluence + position supervision)
- **MCP server** — the engine is exposed as 12 MCP tools for any MCP host (Claude Desktop, Cursor, Claude Code)
- **Web + CLI** — one shared engine, two frontends

> ⚠️ **Paper mode only.** All fills are simulated at live Binance prices (0.05% taker fee + 0.02% slippage). No API keys are needed or used.

---

## Architecture

```
                        ┌────────────────────────────────────────────────┐
                        │   ENGINE  (mini-services/engine, bun :3001)    │
                        │                                                │
  wss://fstream.binance.com/market/stream                ┌──────────┐   │
   ├─ !ticker@arr (universe ranking)          ┌─────────▶│ Paper    │   │
   ├─ @kline_5m / @kline_15m (candles)        │          │ account  │   │
   ├─ @markPrice@1s (funding)                 │   ┌──────│ 10k USDT │   │
   │                                          │   │      └──────────┘   │
  REST fapi.binance.com ──(banned?──▶ spot    │   │      ┌──────────┐   │
  mirror data-api.binance.vision)             └───┼─────▶│ Risk     │   │
                                                  │      │ manager  │   │
  api.coindcx.com / public.coindcx.com           │      └──────────┘   │
   ├─ futures candlesticks, spot INR  ──────────┘      ┌──────────┐   │
   └─ (Cloudflare-blocked here → derived               │ Agentic  │   │
      INR ref via CoinGecko USDT/INR)       ┌─────────▶│ AI loop  │   │
                                            │          └──────────┘   │
  z-ai-web-dev-sdk (LLM confluence) ────────┘                          │
                        │                    │                          │
              REST :3001 /engine/*     socket.io :3002 (path /)        │
                        │                    │                          │
        ┌───────────────┴─────────┐   ┌──────┴───────────┐              │
        │  CLI  cli/agent-cli.ts  │   │  Next.js 16 UI   │              │
        │  status/scan/open/close │   │  (via Caddy      │              │
        └─────────────────────────┘   │  XTransformPort) │              │
                                        └─────────────────┘              │
        ┌─────────────────────────┐                                     │
        │  MCP  mcp-server/       │  stdio → any MCP host               │
        │  12 tools → engine REST │                                     │
        └─────────────────────────┘                                     │
```

**One engine, three clients** — the dashboard, the CLI and the MCP server all drive the same process.

## The agent loop (every 60 s)

1. **Perceive** — refresh top-10 USDT-M perps by 24h volume (BTC/ETH always included), candles, funding, 15m open-interest change, CoinDCX prices when reachable
2. **Quantify** — three strategy families score each symbol:
   - *Momentum breakout* (15m): EMA(9/21) cross + volume expansion + OI drift
   - *Mean reversion* (5m): RSI(2) < 10 / > 90 + Bollinger pierce
   - *Cross-exchange*: funding crowding + Binance-vs-CoinDCX premium
3. **Reason** — candidates with |composite| ≥ 0.25 go to one **LLM confluence** call that weighs all families and must answer strict JSON (`BUY/SELL/HOLD` + confidence + reason). LLM outage → rule-based fallback, never a stall
4. **Act (risk-gated)** — hard guardrails before any fill:
   - max **2% equity risk per trade** (qty sized off ATR stop distance)
   - **-3% daily loss cutoff** halts new entries
   - max **3 concurrent positions**, ≤ **5× leverage**, **30-min cooldown** after a stop-out
   - every position carries an **ATR bracket** (SL = 1.5×ATR, TP = 2R) checked every 5 s; 4h max hold (intraday)
5. **Supervise** — every 3rd cycle the LLM re-reviews open positions and can exit early when the thesis breaks
6. **Journal** — every decision lands in the feed + decision journal (UI/CLI/MCP all read it)

## Run it

```bash
# 1) engine (REST :3001 + socket.io :3002)
cd mini-services/engine && bun run dev

# 2) web dashboard (Next.js :3000 — the preview panel)
bun run dev          # already running in this workspace

# 3) CLI
bun cli/agent-cli.ts status
bun cli/agent-cli.ts scan            # one agent cycle now
bun cli/agent-cli.ts open BTCUSDT LONG 0.01
bun cli/agent-cli.ts close BTCUSDT
bun cli/agent-cli.ts spreads         # cross-exchange scanner

# 4) MCP server (stdio — for Claude Desktop / Cursor / Claude Code)
bun mcp-server/index.ts
```

Claude Desktop registration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "crypto-intraday-agent": {
      "command": "bun",
      "args": ["/absolute/path/to/mcp-server/index.ts"],
      "env": { "ENGINE_URL": "http://localhost:3001" }
    }
  }
}
```

MCP tools: `engine_status`, `market_snapshot`, `spread_scan`, `open_positions`, `trade_history`, `agent_decisions`, `run_scan`, `agent_start`, `agent_stop`, `place_paper_order`, `close_position`, `reset_paper_account`.

## Data-source behaviour (be aware)

| Source | Behaviour |
|---|---|
| Binance WS (`fstream.binance.com`) | **Primary.** Tickers, klines, mark price/funding — unaffected by REST bans |
| Binance REST | Shared egress IPs get `-1003`/`418` rate bans; kline bootstrap falls back to the public **spot mirror** `data-api.binance.vision` (perp ≈ spot within bps; the WS perp stream replaces the tail live). Futures-only symbols with no spot listing are dropped from the universe |
| `futures/data/*` endpoints (OI history) | Work reliably |
| CoinDCX | Full client implemented (futures candles, spot INR). **Cloudflare challenges this sandbox's egress IP**, so from here the spread column degrades to a clearly-labelled *derived* INR reference (Binance × CoinGecko USDT/INR). From residential/Indian networks the live spread scanner activates automatically |
| LLM | `z-ai-web-dev-sdk`, backend-only; graceful rule-based fallback |

## Project layout

```
mini-services/engine/     trading engine (bun): binance.ts, coindcx.ts, indicators.ts,
                          strategies.ts, paper.ts, risk.ts, agent.ts, engine.ts, index.ts
mcp-server/               stdio MCP server → engine REST
cli/agent-cli.ts          headless CLI
src/app/page.tsx          dashboard (single / route)
src/components/dashboard/ price-chart, market-table, agent-feed, positions-panel, risk-panel
src/lib/engine-types.ts   shared client types
```

## Skills used (find-skills flow)

`npx skills find "crypto trading" | "binance" | "futures trading" | "trading agent" | "mcp"` surfaced:
`binance/binance-skills-hub@derivatives-trading-usds-futures` (2.3K installs, official), `ccxt/ccxt@ccxt-python` (2.3K installs, official — installed via `npx skills add`), plus the locally-available Binance skills-hub family and the Anthropic MCP patterns. The `crypto-com/crypto-agent-trading@crypto-agent-trading` skill listed on skills.sh no longer exists in its repo (renamed) — its agentic role is covered by the LLM confluence core.

**Disclaimer:** educational paper-trading system; not financial advice. Do not wire real keys into it without independent review, kill-switch testing and a full audit of the risk layer.
