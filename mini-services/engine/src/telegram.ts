// ─── Telegram notifier — built on @nemesis-oss/tg-format ────────────────────
// One FormattedMessage tree → native entities payload (text + entities[]),
// no parse_mode needed, no escaping bugs. Fire-and-forget; failures never
// throw into the engine. Persisted config lives in data/telegram.json so the
// dashboard can configure it without a restart.
//
// Env overrides (used as initial defaults only):
//   TELEGRAM_BOT_TOKEN  — bot token from @BotFather
//   TELEGRAM_CHAT_ID    — target chat id (negative for groups)
//   TELEGRAM_DISABLE     — "1" starts disabled even if a token is present
//
// Formatting reference: https://www.npmjs.com/package/@nemesis-oss/tg-format
//   message.text         plain UTF-16 string for sendMessage
//   message.entities    native MessageEntity[] with correct UTF-16 offsets
//   message.toHTML()    HTML parse-mode fallback (unused here)

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  fmt, bold, italic, code, pre, link, quote, expandableQuote,
  type FormattedMessage,
} from '@nemesis-oss/tg-format'
import { dataDir, log } from './store'

// ── Config model ────────────────────────────────────────────────────────────
export type TelegramEvent =
  | 'boot'          // engine up
  | 'agent'         // agent start/stop
  | 'entry'         // new position opened (auto or manual)
  | 'exit'          // position closed (TP / SL / EOD / manual / agent-exit)
  | 'risk_halt'     // daily-loss cutoff or other kill switch
  | 'scan_digest'   // periodic cycle summary (only when entries happened)

export interface TelegramConfig {
  enabled: boolean
  botToken: string
  chatId: string
  events: Record<TelegramEvent, boolean>
  minIntervalMs: number  // rate-limit floor between sends to the same chat
}

const DEFAULT_CONFIG: TelegramConfig = {
  enabled: false,
  botToken: '',
  chatId: '',
  events: { boot: true, agent: true, entry: true, exit: true, risk_halt: true, scan_digest: false },
  minIntervalMs: 1_500,
}

const CONFIG_FILE = join(dataDir, 'telegram.json')

function loadConfig(): TelegramConfig {
  const fromEnv: Partial<TelegramConfig> = {}
  if (process.env.TELEGRAM_BOT_TOKEN) fromEnv.botToken = process.env.TELEGRAM_BOT_TOKEN
  if (process.env.TELEGRAM_CHAT_ID) fromEnv.chatId = process.env.TELEGRAM_CHAT_ID
  if (process.env.TELEGRAM_DISABLE === '1') fromEnv.enabled = false
  if (fromEnv.botToken && fromEnv.chatId && process.env.TELEGRAM_DISABLE !== '1') {
    fromEnv.enabled = true
  }
  let fromFile: Partial<TelegramConfig> = {}
  try {
    if (existsSync(CONFIG_FILE)) fromFile = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch { /* ignore corrupt file */ }
  const merged: TelegramConfig = {
    ...DEFAULT_CONFIG,
    ...fromFile,
    ...fromEnv,                       // env wins on first boot
    events: { ...DEFAULT_CONFIG.events, ...(fromFile.events ?? {}), ...(fromEnv.events ?? {}) },
  }
  return merged
}

let config: TelegramConfig = loadConfig()

function persist() {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
  } catch (e) {
    log('warn', 'TG', `failed to persist telegram config: ${String(e).slice(0, 80)}`)
  }
}

// ── Rate-limited send queue (1 message at a time, spaced by minIntervalMs) ──
const queue: Array<{ text: string; entities: any[] }> = []
let sending = false
let lastSentAt = 0

function enqueue(text: string, entities: any[]) {
  queue.push({ text, entities })
  if (queue.length > 50) queue.splice(0, queue.length - 50)  // bound queue
  pump()
}

async function pump() {
  if (sending) return
  sending = true
  try {
    while (queue.length) {
      const now = Date.now()
      const wait = config.minIntervalMs - (now - lastSentAt)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      const job = queue.shift()!
      lastSentAt = Date.now()
      await sendOne(job.text, job.entities)
    }
  } finally {
    sending = false
  }
}

async function sendOne(text: string, entities: any[]) {
  if (!config.botToken || !config.chatId) {
    log('warn', 'TG', 'skipped send — bot token or chat id not configured')
    return
  }
  if (text.length > 4096) text = text.slice(0, 4090) + '…'
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, text, entities }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      log('warn', 'TG', `sendMessage HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
  } catch (e: any) {
    log('warn', 'TG', `send failed: ${String(e?.message || e).slice(0, 120)}`)
  }
}

/** Render a FormattedMessage into the queue. */
function dispatch(msg: FormattedMessage) {
  enqueue(msg.text, msg.entities as any)
}

// ── Public API ──────────────────────────────────────────────────────────────
export function getConfig(): TelegramConfig {
  return { ...config, events: { ...config.events } }
}

export function getSafeConfig() {
  return {
    enabled: config.enabled,
    hasToken: !!config.botToken,
    tokenMasked: config.botToken ? `${config.botToken.slice(0, 8)}…${config.botToken.slice(-4)}` : '',
    chatId: config.chatId,
    events: { ...config.events },
    minIntervalMs: config.minIntervalMs,
  }
}

export function updateConfig(patch: Partial<TelegramConfig>): TelegramConfig {
  const next: TelegramConfig = {
    ...config,
    ...patch,
    events: { ...config.events, ...(patch.events ?? {}) },
  }
  // empty-string token / chatId clears them (so users can paste a new value)
  if (patch.botToken !== undefined) next.botToken = patch.botToken ?? ''
  if (patch.chatId !== undefined) next.chatId = patch.chatId ?? ''
  config = next
  persist()
  log('info', 'TG', `config updated — enabled=${config.enabled}, chatId=${config.chatId || '(none)'}, events=[${Object.entries(config.events).filter(([, v]) => v).map(([k]) => k).join(',')}]`)
  return getConfig()
}

function enabled(evt: TelegramEvent): boolean {
  return config.enabled && !!config.botToken && !!config.chatId && config.events[evt]
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const ARROW_LONG = 'LONG'
const ARROW_SHORT = 'SHORT'

function sideLabel(side: 'LONG' | 'SHORT'): FormattedMessage {
  return side === 'LONG' ? bold(`▲ ${ARROW_LONG}`) : bold(`▼ ${ARROW_SHORT}`)
}

function pnlStr(pnl: number): FormattedMessage {
  const sign = pnl >= 0 ? '+' : ''
  return pnl >= 0
    ? bold(`${sign}${pnl.toFixed(2)} USDT`)
    : bold(`${sign}${pnl.toFixed(2)} USDT`)
}

function pctStr(n: number): string {
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`
}

function timeStr(ts: number): string {
  return new Date(ts).toLocaleString('en-GB', { hour12: false, timeZone: 'UTC' }) + ' UTC'
}

function reasonLabel(r: string): string {
  return ({
    'take-profit': '🎯 take-profit',
    'stop-loss': '🛑 stop-loss',
    'eod': '⏰ eod flatten',
    'manual': '✋ manual close',
    'agent-exit': '🤖 agent exit',
  } as Record<string, string>)[r] || r
}

// ── Event-specific message builders ─────────────────────────────────────────

export function notifyBoot(status: {
  cycle: number
  symbols: string[]
  scanIntervalSec: number
  equity: number
}) {
  if (!enabled('boot')) return
  dispatch(fmt`🟢 ${bold('Engine started')}
${bold('Mode')}: ${code('PAPER')} · ${bold('Equity')}: ${code(`${status.equity.toFixed(2)} USDT`)}
${bold('Universe')}: ${code(status.symbols.join(', '))}
${bold('Agent cadence')}: every ${code(`${status.scanIntervalSec}s`)}`)
}

export function notifyAgentStart() {
  if (!enabled('agent')) return
  dispatch(fmt`▶️ ${bold('Agent loop started')}
Full-auto paper trading within risk limits (2% risk/trade, -3% daily cutoff, max 3 positions).`)
}

export function notifyAgentStop() {
  if (!enabled('agent')) return
  dispatch(fmt`⏸ ${bold('Agent loop stopped')}
Open positions keep their TP/SL brackets.`)
}

export function notifyEntry(p: {
  symbol: string
  side: 'LONG' | 'SHORT'
  qty: number
  entry: number
  stop: number
  takeProfit: number
  confidence: number
  rationale: string
  strategy: string
  riskUsd: number
}) {
  if (!enabled('entry')) return
  const r = Math.abs(p.entry - p.stop) > 0 ? (Math.abs(p.takeProfit - p.entry) / Math.abs(p.entry - p.stop)) : 0
  dispatch(fmt`🟢 ${bold('Position opened')} · ${code(p.symbol)}
${bold('Side')}: ${sideLabel(p.side)}   ${bold('Qty')}: ${code(p.qty.toFixed(6))}
${bold('Entry')}: ${code(p.entry.toFixed(4))}   ${bold('Stop')}: ${code(p.stop.toFixed(4))}   ${bold('TP')}: ${code(p.takeProfit.toFixed(4))}
${bold('Risk')}: ${code(`${p.riskUsd.toFixed(2)} USDT`)}   ${bold('R:R')}: ${code(r.toFixed(2))}   ${bold('Conf')}: ${code(`${(p.confidence * 100).toFixed(0)}%`)}
${bold('Strategy')}: ${code(p.strategy)}
${italic('Thesis')}: ${p.rationale}`)
}

export function notifyExit(t: {
  symbol: string
  side: 'LONG' | 'SHORT'
  entry: number
  exit: number
  qty: number
  pnl: number
  fees: number
  closeReason: string
  strategy: string
  openedAt: number
  closedAt: number
  rationale: string
}) {
  if (!enabled('exit')) return
  const holdMin = Math.max(1, Math.round((t.closedAt - t.openedAt) / 60_000))
  const pnlPct = (t.pnl / (t.entry * t.qty)) * 100
  dispatch(fmt`🔴 ${bold('Position closed')} · ${code(t.symbol)}
${bold('Side')}: ${sideLabel(t.side)}   ${bold('Reason')}: ${code(reasonLabel(t.closeReason))}
${bold('Entry')}: ${code(t.entry.toFixed(4))} → ${bold('Exit')}: ${code(t.exit.toFixed(4))}
${bold('PnL')}: ${pnlStr(t.pnl)} (${code(pctStr(pnlPct / 100))})   ${bold('Fees')}: ${code(t.fees.toFixed(3))}
${bold('Hold')}: ${code(`${holdMin}m`)}   ${bold('Strategy')}: ${code(t.strategy)}
${italic('Thesis was')}: ${t.rationale}`)
}

export function notifyRiskHalt(reason: string, dailyPnl: number, dailyStart: number) {
  if (!enabled('risk_halt')) return
  const dailyPct = dailyStart ? (dailyPnl / dailyStart) * 100 : 0
  dispatch(fmt`⚠️ ${bold('TRADING HALTED')}
${reason}
${bold('Daily PnL')}: ${pnlStr(dailyPnl)} (${code(pctStr(dailyPct / 100))}) of ${code(`${dailyStart.toFixed(2)} USDT`)}
New entries blocked until UTC midnight or recovery.`)
}

export function notifyScanDigest(info: {
  cycle: number
  source: 'llm' | 'llm-debate' | 'rules-fallback'
  candidates: number
  executed: string[]
  skipped: string[]
  summary: string
}) {
  if (!enabled('scan_digest')) return
  const head = fmt`📊 ${bold(`Scan cycle #${info.cycle}`)} · ${code(info.source === 'llm' ? 'LLM' : info.source === 'llm-debate' ? 'LLM-DEBATE' : 'RULES')}
${bold('Candidates')}: ${code(String(info.candidates))}   ${bold('Executed')}: ${code(info.executed.join(', ') || 'none')}`
  const summary = info.summary && info.summary !== 'no actionable setups'
    ? quote(info.summary)
    : quote('no actionable setups')
  dispatch(fmt`${head}
${summary}`)
}

export async function notifyTest(customText?: string): Promise<{ ok: boolean; detail: string }> {
  if (!config.botToken || !config.chatId) {
    return { ok: false, detail: 'bot token or chat id not configured' }
  }
  const msg = customText
    ? fmt`🧪 ${bold('Telegram test')} · ${code(new Date().toISOString())}
${customText}`
    : fmt`🧪 ${bold('Telegram test message')}
${bold('From')}: ${code('crypto-intraday-agent')}
${bold('At')}: ${code(timeStr(Date.now()))}
${italic('If you can read this, your bot token + chat id are correct.')}
${link('Powered by @nemesis-oss/tg-format', 'https://www.npmjs.com/package/@nemesis-oss/tg-format')}`
  // bypass the enabled gate so the user can always verify connectivity
  const wasEnabled = config.enabled
  try {
    config.enabled = true
    // bypass event-level gate too: send immediately
    const text = msg.text
    const entities = msg.entities as any[]
    if (text.length > 4096) throw new Error('message too long')
    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, text, entities }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, detail: `telegram HTTP ${res.status}: ${body.slice(0, 200)}` }
    }
    const json = await res.json() as any
    if (!json.ok) return { ok: false, detail: `telegram error: ${json.description || 'unknown'}` }
    return { ok: true, detail: `test message delivered (msg id ${json.result?.message_id ?? '?'})` }
  } catch (e: any) {
    return { ok: false, detail: `send failed: ${String(e?.message || e).slice(0, 160)}` }
  } finally {
    config.enabled = wasEnabled
  }
}
