# Crypto Intraday Agent — Binance + CoinDCX · MCP · Agentic AI

A full-auto **intraday crypto futures paper-trading system** built from skills discovered via `npx skills find` (the vercel-labs **find-skills** flow):

- **Binance USDⓈ-M futures** market data + trading semantics — from the official `binance/binance-skills-hub` skill family (`derivatives-trading-usds-futures`, market-data, paper-trading, algo-trading, `binance-usdm-futures-tools` for the MCP/tool layer)
- **CoinDCX** public market data — per the `ccxt/ccxt@ccxt-python` skill (same public endpoints CCXT's coindcx adapter wraps; implemented natively in TypeScript here)
- **Agentic AI** — a crypto-trading-agent decision core powered by local Ollama (`minicpm5:2b`) with ZAI fallback (LLM confluence + position supervision)
- **Telegram alerts** — `@nemesis-oss/tg-format` for type-safe message entities (entries, exits, risk halts, agent start/stop, scan digests)
- **MCP server** — the engine is exposed as 15 MCP tools for any MCP host (Claude Desktop, Cursor, Claude Code)
- **Web + CLI** — one shared engine, two frontends

> ⚠️ **Paper mode only.** All fills are simulated at live Binance prices (0.05% taker fee + 0.02% slippage). No API keys are needed or used.

---

## Architecture

```
                        ┌────────────────────────────────────────────────┐
                        │   ENGINE  (mini-services/engine, bun :3151)    │
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
              REST :3151 /engine/*     socket.io :3152 (path /)        │
                        │                    │                          │
        ┌───────────────┴─────────┐   ┌──────┴───────────┐              │
        │  CLI  cli/agent-cli.ts  │   │  Next.js 16 UI   │              │
        │  status/scan/open/close │   │  (:3150 direct   │              │
        └─────────────────────────┘   │  or via Caddy)   │              │
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
3. **Reason** — candidates with |composite| ≥ 0.25 go to one **LLM confluence** call (local Ollama `minicpm5:2b` by default, or ZAI) that weighs all families and must answer strict JSON (`BUY/SELL/HOLD` + confidence + reason). LLM outage → rule-based fallback, never a stall
4. **Act (risk-gated)** — hard guardrails before any fill:
   - max **2% equity risk per trade** (qty sized off ATR stop distance)
   - **-3% daily loss cutoff** halts new entries
   - max **3 concurrent positions**, ≤ **5× leverage**, **30-min cooldown** after a stop-out
   - every position carries an **ATR bracket** (SL = 1.5×ATR, TP = 2R) checked every 5 s; 4h max hold (intraday)
5. **Supervise** — every 3rd cycle the LLM re-reviews open positions and can exit early when the thesis breaks
6. **Journal** — every decision lands in the feed + decision journal (UI/CLI/MCP all read it)

## Run it

```bash
# 1) engine (REST :3151 + socket.io :3152)
cd mini-services/engine && bun run dev
# or from root:
bun run dev:engine

# 2) web dashboard (Next.js :3150 — the preview panel)
bun run dev

# 3) CLI
bun cli/agent-cli.ts status
bun cli/agent-cli.ts scan            # one agent cycle now
bun cli/agent-cli.ts open BTCUSDT LONG 0.01
bun cli/agent-cli.ts close BTCUSDT
bun cli/agent-cli.ts spreads         # cross-exchange scanner

# 3b) Telegram notifier (powered by @nemesis-oss/tg-format)
bun cli/agent-cli.ts tg-set <chatId> <botToken>   # configure + enable
bun cli/agent-cli.ts tg-test                       # send a test message
bun cli/agent-cli.ts tg-on | tg-off                # toggle
bun cli/agent-cli.ts tg-status                    # show config (token masked)

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
      "env": { "ENGINE_URL": "http://localhost:3151" }
    }
  }
}
```

MCP tools: `engine_status`, `market_snapshot`, `spread_scan`, `open_positions`, `trade_history`, `agent_decisions`, `run_scan`, `agent_start`, `agent_stop`, `place_paper_order`, `close_position`, `reset_paper_account`, **`telegram_status`**, **`telegram_configure`**, **`telegram_test`**.

## Telegram notifications

Realtime alerts on your phone / chat powered by [`@nemesis-oss/tg-format`](https://www.npmjs.com/package/@nemesis-oss/tg-format) — a type-safe formatter that emits **native `MessageEntity[]`** (no `parse_mode`, no escaping bugs, correct UTF-16 offsets even with emoji and ZWJ sequences). One `FormattedMessage` tree → native entities for `sendMessage`.

### Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) → copy the bot token
2. Get your chat id from [@userinfobot](https://t.me/userinfobot) (or invite the bot to a group and use the group's negative id)
3. Configure the engine (any of these is equivalent):
   ```bash
   # CLI
   bun cli/agent-cli.ts tg-set 123456789 "123456789:ABCdefGhiJklMnoPqrStu"
   # …or via env on first boot
   TELEGRAM_BOT_TOKEN="123456789:ABCdef…" TELEGRAM_CHAT_ID=123456789 bun run dev
   # …or in the dashboard → “Telegram alerts” card
   ```
4. Verify with `bun cli/agent-cli.ts tg-test` (or the dashboard "Send test message" button)

### Events you can subscribe to

| Event | Default | What triggers it |
|---|---|---|
| `boot` | on | Engine startup with universe + equity snapshot |
| `agent` | on | Agent loop started / stopped |
| `entry` | on | New position opened (auto or manual) with side, qty, entry, SL, TP, R:R, confidence, strategy, LLM thesis |
| `exit` | on | Position closed with PnL %, fees, hold time, exit reason (🎯 TP / 🛑 SL / ⏰ EOD / ✋ manual / 🤖 agent-exit) |
| `risk_halt` | on | Daily-loss cutoff (-3%) hit — new entries blocked until UTC midnight or recovery |
| `scan_digest` | **off** | Each cycle that executes a trade (chatty — opt-in only) |

All events use a 1.5-second-per-chat rate limit (Telegram's hard limit is 1/sec/chat). Failures never throw into the engine — they log to the agent feed and continue.

### Configure at runtime

The config persists to `mini-services/engine/data/telegram.json` (gitignored). Read it back with:

```bash
bun cli/agent-cli.ts tg-status
```

or in the dashboard (token is always masked when read back).

```bash
# MCP
{ "tool": "telegram_configure", "arguments": { "botToken": "…", "chatId": "…", "enabled": true, "events": { "scan_digest": true } } }
{ "tool": "telegram_test", "arguments": { "message": "hello from claude" } }
```

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
                          strategies.ts, paper.ts, risk.ts, agent.ts, telegram.ts, engine.ts, index.ts
mcp-server/               stdio MCP server → engine REST
cli/agent-cli.ts          headless CLI
src/app/page.tsx          dashboard (single / route)
src/components/dashboard/ price-chart, market-table, agent-feed, positions-panel, risk-panel, telegram-panel
src/lib/engine-types.ts   shared client types
```

## Skills used (find-skills flow)

`npx skills find "crypto trading" | "binance" | "futures trading" | "trading agent" | "mcp"` surfaced:
`binance/binance-skills-hub@derivatives-trading-usds-futures` (2.3K installs, official), `ccxt/ccxt@ccxt-python` (2.3K installs, official — installed via `npx skills add`), plus the locally-available Binance skills-hub family and the Anthropic MCP patterns. The `crypto-com/crypto-agent-trading@crypto-agent-trading` skill listed on skills.sh no longer exists in its repo (renamed) — its agentic role is covered by the LLM confluence core.

**Disclaimer:** educational paper-trading system; not financial advice. Do not wire real keys into it without independent review, kill-switch testing and a full audit of the risk layer.
