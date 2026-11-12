// ─── Persistence + in-process event bus ─────────────────────────────────────
// Paper account state is kept in memory (per binance-futures-paper-trading skill)
// and mirrored to JSON files so a restart can restore context.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountState, LlmDecision, LogEntry } from './types'

// The engine runs with cwd = mini-services/engine, so data lives next to it.
export const dataDir = (() => {
  const d = join(process.cwd(), 'data')
  mkdirSync(d, { recursive: true })
  return d
})()

function readJson<T>(file: string, fallback: T): T {
  try {
    const p = join(dataDir, file)
    if (!existsSync(p)) return fallback
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown) {
  try {
    writeFileSync(join(dataDir, file), JSON.stringify(data))
  } catch {
    /* persistence is best-effort */
  }
}

// ── Event bus ────────────────────────────────────────────────────────────────
type Handler = (payload: any) => void
const handlers = new Map<string, Set<Handler>>()

export const bus = {
  on(event: string, fn: Handler) {
    if (!handlers.has(event)) handlers.set(event, new Set())
    handlers.get(event)!.add(fn)
    return () => handlers.get(event)?.delete(fn)
  },
  emit(event: string, payload?: any) {
    handlers.get(event)?.forEach((fn) => {
      try {
        fn(payload)
      } catch (e) {
        console.error('[bus] handler error', event, e)
      }
    })
  },
}

// ── Log ring buffer ─────────────────────────────────────────────────────────
const MAX_LOG = 500
const logs: LogEntry[] = readJson<LogEntry[]>('logs.json', [])

export function log(level: LogEntry['level'], tag: string, msg: string) {
  const entry: LogEntry = { ts: Date.now(), level, tag, msg }
  logs.push(entry)
  if (logs.length > MAX_LOG) logs.splice(0, logs.length - MAX_LOG)
  if (level === 'error') console.error(`[${tag}] ${msg}`)
  else console.log(`[${tag}] ${msg}`)
  bus.emit('log', entry)
  writeJson('logs.json', logs.slice(-200)) // persist a trimmed tail
}

export const recentLogs = (n = 120) => logs.slice(-n)

// ── LLM decision journal ────────────────────────────────────────────────────
const decisions: LlmDecision[] = readJson<LlmDecision[]>('decisions.json', [])
export function recordDecision(d: LlmDecision) {
  decisions.push(d)
  if (decisions.length > 200) decisions.splice(0, decisions.length - 200)
  bus.emit('decision', d)
  writeJson('decisions.json', decisions.slice(-80))
}
export const recentDecisions = (n = 30) => decisions.slice(-n)

// ── Account persistence ─────────────────────────────────────────────────────
export function persistAccount(acc: AccountState) {
  writeJson('account.json', {
    balance: acc.balance,
    initialEquity: acc.initialEquity,
    positions: acc.positions,
    trades: acc.trades.slice(-200),
    equityCurve: acc.equityCurve.slice(-600),
  })
}

export function loadAccountPatch(): Partial<AccountState> | null {
  const p = join(dataDir, 'account.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

export function loadDailyStart(): { day: string; equity: number } | null {
  return readJson<{ day: string; equity: number } | null>('daily.json', null)
}

export function saveDailyStart(day: string, equity: number) {
  writeJson('daily.json', { day, equity })
}

export function clearPersisted() {
  for (const f of ['account.json', 'decisions.json', 'logs.json']) {
    try {
      writeFileSync(join(dataDir, f), '[]')
    } catch { /* ignore */ }
  }
}
