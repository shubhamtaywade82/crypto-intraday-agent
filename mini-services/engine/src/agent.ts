// ─── Agentic AI confluence layer — the "crypto-trading-agent" brain ─────────
// Every agent cycle: quant signals per symbol → pre-filter by |composite| →
// one structured LLM call (local Ollama minicpm5:2b) weighing all four
// strategy families → strict-JSON decision → risk-gated execution.
// LLM outages degrade gracefully to the rule-based composite score.

import { CONFIG } from './config'
import { log, recordDecision } from './store'
import type { LlmDecision, SignalSet, TickerRow } from './types'

export interface Candidate {
  symbol: string
  price: number
  composite: number
  signals: SignalSet
  fundingRate: number
  oiChangePct: number | null
  spreadPct: number | null
  inrPrice: number | null
  changePct: number
}

export interface AgentVerdict {
  symbol: string
  action: 'BUY' | 'SELL' | 'HOLD'
  confidence: number
  reason: string
}

const SYSTEM_PROMPT = `You are the decision core of an intraday crypto futures trading agent (paper-trading mode).
You receive quantified signals from four strategy families for candidate perpetual contracts on Binance USDⓈ-M:
1. MOMENTUM (15m EMA9/21 cross + volume expansion + open-interest drift)
2. MEANREV (5m RSI(2) extremes + Bollinger band pierce)
3. SPREAD (funding-rate crowding + Binance-vs-CoinDCX cross-exchange premium)
4. COMPOSITE (weighted blend, -1 bearish … +1 bullish)

Your job: pick high-conviction intraday entries ONLY when evidence across families agrees.
Rules you must respect:
- Only BUY when momentum is not strongly against you AND composite or mean-reversion supports longs.
- Only SELL when momentum is not strongly against you AND composite or mean-reversion supports shorts.
- When signals conflict or are weak, HOLD — capital preservation first.
- Confidence ∈ [0.55, 0.95]; be modest. 0.80+ only for multi-family confluence.
- Intraday horizon: reasons should reference the next few hours, not days.

Respond with STRICT JSON only, no markdown, no commentary:
{"decisions":[{"symbol":"BTCUSDT","action":"BUY|SELL|HOLD","confidence":0.0,"reason":"one concise sentence"}]}
Every candidate symbol MUST appear exactly once in decisions.`

function buildUserPrompt(candidates: Candidate[], context: {
  equity: number
  balance: number
  openPositions: Array<{ symbol: string; side: string; entry: number; pnlPct: number }>
  dailyPnlPct: number
}): string {
  const lines = candidates.map((c) => {
    const s = c.signals
    return [
      `${c.symbol}: price=${c.price} 24hChg=${(c.changePct * 100).toFixed(2)}%`,
      `composite=${c.composite}`,
      `momentum[score=${s.momentum.score} note="${s.momentum.note}"]`,
      `meanRev[score=${s.meanRev.score} note="${s.meanRev.note}"]`,
      `spread[score=${s.spread.score} note="${s.spread.note}"]`,
      `funding=${(c.fundingRate * 100).toFixed(4)}% OI15m=${c.oiChangePct === null ? 'n/a' : c.oiChangePct.toFixed(2) + '%'}`,
      `coindcxSpread=${c.spreadPct === null ? 'n/a' : c.spreadPct.toFixed(2) + '%'} inrRef=${c.inrPrice === null ? 'n/a' : c.inrPrice.toFixed(0)}`,
    ].join(' | ')
  })
  return [
    `ACCOUNT: equity=${context.equity.toFixed(2)} USDT, dailyPnl=${(context.dailyPnlPct * 100).toFixed(2)}%,`,
    `open positions=${context.openPositions.map((p) => `${p.symbol} ${p.side} @${p.entry} (${(p.pnlPct * 100).toFixed(2)}%)`).join('; ') || 'none'}`,
    `CANDIDATES (${candidates.length}):`,
    ...lines,
    'Decide now. STRICT JSON.',
  ].join('\n')
}

interface RawDecision { symbol?: string; action?: string; confidence?: number; reason?: string }

function parseVerdicts(text: string, candidates: Candidate[]): AgentVerdict[] {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('no JSON object in LLM response')
  const obj = JSON.parse(cleaned.slice(start, end + 1)) as { decisions?: RawDecision[] }
  const bySymbol = new Map(candidates.map((c) => [c.symbol, c]))
  const verdicts: AgentVerdict[] = []
  for (const d of obj.decisions ?? []) {
    const sym = String(d.symbol || '').toUpperCase()
    if (!bySymbol.has(sym)) continue
    const action = String(d.action || 'HOLD').toUpperCase()
    if (action !== 'BUY' && action !== 'SELL' && action !== 'HOLD') continue
    const conf = Number(d.confidence)
    verdicts.push({
      symbol: sym,
      action,
      confidence: Number.isFinite(conf) ? Math.min(0.95, Math.max(0, conf)) : 0,
      reason: String(d.reason || '').slice(0, 240),
    })
  }
  // ensure every candidate present
  for (const c of candidates) {
    if (!verdicts.some((v) => v.symbol === c.symbol)) {
      verdicts.push({ symbol: c.symbol, action: 'HOLD', confidence: 0, reason: 'not covered by model output — defaulting to HOLD' })
    }
  }
  return verdicts
}

/** Rule-based fallback when the LLM is unavailable. */
export function rulesFallbackVerdicts(candidates: Candidate[]): AgentVerdict[] {
  return candidates.map((c) => {
    const comp = c.signals.composite
    const action = comp >= CONFIG.compositeThreshold ? 'BUY' : comp <= -CONFIG.compositeThreshold ? 'SELL' : 'HOLD'
    const strength = Math.min(0.85, Math.abs(comp) + 0.25)
    return {
      symbol: c.symbol,
      action,
      confidence: action === 'HOLD' ? 0 : Number(strength.toFixed(2)),
      reason: `rule fallback: composite ${comp} (momentum ${c.signals.momentum.score}, meanRev ${c.signals.meanRev.score}, spread ${c.signals.spread.score})`,
    }
  })
}

/** Call Ollama or fallback to ZAI for structured LLM completions */
async function callOllama(messages: Array<{ role: string; content: string }>): Promise<string> {
  const res = await fetch(`${CONFIG.ollamaBase}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: CONFIG.ollamaModel,
      messages,
      format: 'json',
      stream: false,
      options: { temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`)
  const data = (await res.json()) as { message?: { content?: string } }
  const text = data.message?.content?.trim()
  if (!text) throw new Error('empty content from Ollama')
  return text
}

async function callLlm(messages: Array<{ role: string; content: string }>): Promise<string> {
  return await callOllama(messages)
}

export async function weighCandidates(
  candidates: Candidate[],
  context: Parameters<typeof buildUserPrompt>[1],
): Promise<{ verdicts: AgentVerdict[]; source: 'llm' | 'rules-fallback'; summary: string }> {
  if (!candidates.length) {
    return { verdicts: [], source: 'rules-fallback', summary: 'no candidates passed the pre-filter' }
  }
  try {
    const text = await callLlm([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(candidates, context) },
    ])
    const verdicts = parseVerdicts(text, candidates)
    log('llm', 'AGENT', `LLM confluence done: ${verdicts.filter((v) => v.action !== 'HOLD').map((v) => `${v.symbol}:${v.action}@${(v.confidence * 100).toFixed(0)}%`).join(' ') || 'all HOLD'}`)
    const summary = verdicts
      .filter((v) => v.action !== 'HOLD')
      .map((v) => `${v.symbol} ${v.action} (${(v.confidence * 100).toFixed(0)}%) — ${v.reason}`)
      .join(' | ') || 'no actionable setups'
    return { verdicts, source: 'llm', summary }
  } catch (e: any) {
    log('warn', 'AGENT', `Ollama ${CONFIG.ollamaModel} unavailable (${String(e?.message || e).slice(0, 80)}) — falling back to rule-based composite`)
    const verdicts = rulesFallbackVerdicts(candidates)
    const summary = verdicts
      .filter((v) => v.action !== 'HOLD')
      .map((v) => `${v.symbol} ${v.action}`)
      .join(' | ') || 'no actionable setups'
    return { verdicts, source: 'rules-fallback', summary }
  }
}

export function journal(decision: Omit<LlmDecision, 'ts' | 'cycle'> & { cycle: number }): void {
  recordDecision({ ...decision, ts: Date.now() })
}

/** Periodic position review: should we exit early? */
export async function reviewPosition(
  pos: { symbol: string; side: 'LONG' | 'SHORT'; entry: number; qty: number; rationale: string },
  ticker: TickerRow,
): Promise<{ exit: boolean; reason: string }> {
  const pnlPct = (ticker.price - pos.entry) / pos.entry * (pos.side === 'LONG' ? 1 : -1)
  try {
    const text = await callLlm([
      {
        role: 'system',
        content: `You supervise open intraday futures positions (paper mode). Decide whether to EXIT EARLY or HOLD.
Reply STRICT JSON: {"exit": true|false, "reason":"one sentence"}
Exit only when the original thesis is clearly invalidated (opposite momentum shift, funding squeeze against the side). Small adverse moves are noise.`,
      },
      {
        role: 'user',
        content: `Position: ${pos.side} ${pos.symbol} qty=${pos.qty} entry=${pos.entry} opened because: ${pos.rationale}
Now: price=${ticker.price} pnl=${(pnlPct * 100).toFixed(2)}% funding=${(ticker.fundingRate * 100).toFixed(4)}% OI15m=${ticker.oiChangePct ?? 'n/a'}
Signals: momentum=${ticker.signals?.momentum.score} (${ticker.signals?.momentum.note}) meanRev=${ticker.signals?.meanRev.score} spread=${ticker.signals?.spread.score}`,
      },
    ])
    const m = text.match(/\{[\s\S]*\}/)
    if (m) {
      const obj = JSON.parse(m[0])
      return { exit: !!obj.exit, reason: String(obj.reason || 'supervisor decision').slice(0, 200) }
    }
    return { exit: false, reason: 'parse-fallback: hold' }
  } catch {
    return { exit: false, reason: 'supervisor unavailable — hold' }
  }
}
