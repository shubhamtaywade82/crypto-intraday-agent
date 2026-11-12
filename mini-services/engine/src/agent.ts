// ─── Agentic AI confluence layer — the "crypto-trading-agent" brain ─────────
// Every agent cycle: quant signals per symbol → pre-filter by |composite| →
// structured LLM call weighing all ten strategy families + the confluence
// engine (five stacks + regime + setup library) → strict-JSON decision →
// risk-gated execution.
//
// Agent modes (CONFIG.agentMode):
//   single — one structured LLM call (default; works with small local models)
//   debate — three-call adversarial pipeline: BULL analyst argues the long
//            case, BEAR analyst argues the short case, JUDGE weighs both and
//            emits the verdicts. Reduces single-call bias/hallucination.
//
// LLM outages degrade gracefully to the rule-based composite score.

import { CONFIG } from './config'
import { log, recordDecision } from './store'
import type { ConfluenceResult } from './confluence'
import type { DerivativesContext } from './derivatives'
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
  // ── v2 extended context ──
  regime?: string
  regimeNote?: string
  confluence?: ConfluenceResult
  derivatives?: DerivativesContext
  structureTrend?: string
  activeSetups?: string[]
  liqNote?: string
}

export interface AgentVerdict {
  symbol: string
  action: 'BUY' | 'SELL' | 'HOLD'
  confidence: number
  reason: string
}

const SYSTEM_PROMPT = `You are the decision core of an intraday crypto futures trading agent (paper-trading mode).
You receive quantified signals from ten strategy families plus a confluence engine for candidate perpetual contracts on Binance USDⓈ-M:
1. MOMENTUM (15m EMA9/21 cross + volume expansion + open-interest drift)
2. MEANREV (5m RSI(2) extremes + Bollinger band pierce)
3. SPREAD (funding-rate crowding + Binance-vs-CoinDCX cross-exchange premium)
4. LIQSWEEP (SMC liquidity sweep of equal highs/lows + CHoCH confirmation)
5. SQUEEZE (TTM squeeze: Bollinger collapse inside Keltner, fires with volume)
6. ORDERBLOCK (price taps displacement order block in premium/discount zone)
7. SESSION (Asia range breakout during London/NY expansion + OI confirm)
8. FUNDINGFLIP (healthy trend while funding resets to neutral — not crowded)
9. CASCADE (liquidation cascade exhaustion + structural reclaim snapback)
10. VWAPREV (2-sigma stretch from rolling VWAP fades back to VWAP)
Plus: REGIME (trend-up/trend-down/range/volatile/quiet from ADX + BB-width percentile),
CONFLUENCE (five stacks: trend/momentum/volume/derivatives/structure, agreement count, regime gate),
SETUPS (named playbook entries currently firing, e.g. london-sweep-reversal, squeeze-breakout, cascade-snapback),
DERIVATIVES (funding regime z-score, OI/price quadrant, crowd long/short ratio, liquidation cascade, basis).

Your job: pick high-conviction intraday entries ONLY when evidence across families and stacks agrees.
Rules you must respect:
- Only BUY when momentum is not strongly against you AND (composite or confluence or a named setup) supports longs.
- Only SELL when momentum is not strongly against you AND (composite or confluence or a named setup) supports shorts.
- A fresh named SETUP (strength ≥ 0.7) aligned with the regime is the strongest entry evidence.
- Contrarian signals (funding extremes, crowd positioning, cascades) are powerful but only trade them WITH structure confirmation, never naked.
- When signals conflict or are weak, HOLD — capital preservation first.
- Confidence ∈ [0.55, 0.95]; be modest. 0.80+ only for multi-family confluence (≥3 stacks agreeing).
- Intraday horizon: reasons should reference the next few hours, not days.

Respond with STRICT JSON only, no markdown, no commentary:
{"decisions":[{"symbol":"BTCUSDT","action":"BUY|SELL|HOLD","confidence":0.0,"reason":"one concise sentence"}]}
Every candidate symbol MUST appear exactly once in decisions.`

const BULL_PROMPT = `You are the BULL analyst of a crypto futures trading desk (paper mode). Argue the strongest honest LONG case for each candidate using ONLY the data provided. Do not invent numbers. If a symbol has no honest bull case, say so. Reply STRICT JSON: {"arguments":[{"symbol":"...","case":"one sentence bull thesis","strength":0.0}]}`

const BEAR_PROMPT = `You are the BEAR analyst of a crypto futures trading desk (paper mode). Argue the strongest honest SHORT case for each candidate using ONLY the data provided. Do not invent numbers. If a symbol has no honest bear case, say so. Reply STRICT JSON: {"arguments":[{"symbol":"...","case":"one sentence bear thesis","strength":0.0}]}`

const JUDGE_PROMPT = `You are the JUDGE of a crypto futures trading desk (paper mode). You receive the quantified signals, the BULL analyst's arguments and the BEAR analyst's arguments. Weigh all evidence — signals and setups are primary, analyst arguments are colour. Verdicts must follow these rules:
- BUY only when momentum is not strongly bearish AND composite/confluence/named-setup supports longs
- SELL only when momentum is not strongly bullish AND composite/confluence/named-setup supports shorts
- HOLD when evidence conflicts or is weak
- Confidence ∈ [0.55, 0.95]; 0.80+ requires ≥3 confluence stacks agreeing
Reply STRICT JSON: {"decisions":[{"symbol":"...","action":"BUY|SELL|HOLD","confidence":0.0,"reason":"one concise sentence citing the decisive evidence"}]}`

function buildUserPrompt(candidates: Candidate[], context: {
  equity: number
  balance: number
  openPositions: Array<{ symbol: string; side: string; entry: number; pnlPct: number }>
  dailyPnlPct: number
}): string {
  const lines = candidates.map((c) => {
    const s = c.signals
    const parts = [
      `${c.symbol}: price=${c.price} 24hChg=${(c.changePct * 100).toFixed(2)}%`,
      `composite=${s.composite}`,
      `momentum[score=${s.momentum.score} note="${s.momentum.note}"]`,
      `meanRev[score=${s.meanRev.score} note="${s.meanRev.note}"]`,
      `spread[score=${s.spread.score} note="${s.spread.note}"]`,
    ]
    if (s.liquiditySweep) parts.push(`liqSweep[score=${s.liquiditySweep.score} note="${s.liquiditySweep.note}"]`)
    if (s.squeezeBreakout) parts.push(`squeeze[score=${s.squeezeBreakout.score} note="${s.squeezeBreakout.note}"]`)
    if (s.orderBlock) parts.push(`orderBlock[score=${s.orderBlock.score} note="${s.orderBlock.note}"]`)
    if (s.sessionBreakout) parts.push(`session[score=${s.sessionBreakout.score} note="${s.sessionBreakout.note}"]`)
    if (s.fundingFlip) parts.push(`fundingFlip[score=${s.fundingFlip.score} note="${s.fundingFlip.note}"]`)
    if (s.cascadeSnapback) parts.push(`cascade[score=${s.cascadeSnapback.score} note="${s.cascadeSnapback.note}"]`)
    if (s.vwapReversion) parts.push(`vwapRev[score=${s.vwapReversion.score} note="${s.vwapReversion.note}"]`)
    if (s.regime) parts.push(`regime=${s.regime.label}`)
    if (s.confluence) parts.push(`confluence[score=${s.confluence.score} agreement=${s.confluence.agreement}/5 regimeAligned=${s.confluence.regimeAligned} stacks={${s.confluence.stacks.map((x) => `${x.name}:${x.dir > 0 ? '+' : ''}${x.score}`).join(' ')}}]`)
    if (s.confluence?.setups.length) parts.push(`setups=[${s.confluence.setups.filter((x) => x.dir !== 0).map((x) => `${x.name}(dir=${x.dir},str=${x.strength})`).join(', ')}]`)
    if (c.derivatives) parts.push(`derivatives[funding=${c.derivatives.funding.label}(z=${c.derivatives.funding.z}) oi=${c.derivatives.oi.label} crowd=${c.derivatives.ls.crowd} ${c.liqNote ?? ''}]`)
    if (c.structureTrend) parts.push(`structure=${c.structureTrend}`)
    parts.push(`funding=${(c.fundingRate * 100).toFixed(4)}% OI15m=${c.oiChangePct === null ? 'n/a' : c.oiChangePct.toFixed(2) + '%'}`)
    parts.push(`coindcxSpread=${c.spreadPct === null ? 'n/a' : c.spreadPct.toFixed(2) + '%'} inrRef=${c.inrPrice === null ? 'n/a' : c.inrPrice.toFixed(0)}`)
    return parts.join(' | ')
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
    const conf = c.signals.confluence
    // v2: prefer confluence score when available, boosted by setup agreement
    let eff = comp
    let reason = `rule fallback: composite ${comp}`
    if (conf) {
      eff = comp * 0.5 + conf.score * 0.5
      const active = conf.setups.filter((s) => s.dir !== 0 && s.strength >= 0.6)
      if (active.length) {
        const top = active.reduce((a, b) => (b.strength > a.strength ? b : a))
        if (Math.sign(top.dir) === Math.sign(eff) || eff === 0) eff += top.dir * top.strength * 0.15
        reason += `, confluence ${conf.score} (${conf.agreement}/5 stacks), setup ${top.name}`
      } else {
        reason += `, confluence ${conf.score} (${conf.agreement}/5 stacks)`
      }
    }
    eff = Math.max(-1, Math.min(1, eff))
    const action = eff >= CONFIG.compositeThreshold ? 'BUY' : eff <= -CONFIG.compositeThreshold ? 'SELL' : 'HOLD'
    const strength = Math.min(0.85, Math.abs(eff) + 0.25)
    return {
      symbol: c.symbol,
      action,
      confidence: action === 'HOLD' ? 0 : Number(strength.toFixed(2)),
      reason,
    }
  })
}

/** Call Ollama for structured LLM completions */
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

/**
 * Adversarial debate pipeline: BULL case → BEAR case → JUDGE verdict.
 * Three cheap calls; falls back to the single-call flow on any failure.
 */
async function debateVerdicts(
  candidates: Candidate[],
  context: Parameters<typeof buildUserPrompt>[1],
): Promise<AgentVerdict[]> {
  const user = buildUserPrompt(candidates, context)
  const budget = AbortSignal.timeout(CONFIG.debateTimeoutMs)

  const bullText = await callOllama([
    { role: 'system', content: BULL_PROMPT },
    { role: 'user', content: user },
  ])
  if (budget.aborted) throw new Error('debate budget exhausted (bull)')
  const bearText = await callOllama([
    { role: 'system', content: BEAR_PROMPT },
    { role: 'user', content: user },
  ])
  if (budget.aborted) throw new Error('debate budget exhausted (bear)')

  const judgeUser = [
    user,
    '',
    'BULL ANALYST ARGUMENTS:',
    bullText.replace(/```json|```/g, '').slice(0, 2000),
    '',
    'BEAR ANALYST ARGUMENTS:',
    bearText.replace(/```json|```/g, '').slice(0, 2000),
    '',
    'Weigh the evidence and decide. STRICT JSON.',
  ].join('\n')
  const judgeText = await callOllama([
    { role: 'system', content: JUDGE_PROMPT },
    { role: 'user', content: judgeUser },
  ])
  const verdicts = parseVerdicts(judgeText, candidates)
  log('llm', 'AGENT', `debate pipeline complete — bull/bear cases weighed for ${candidates.length} candidate(s)`)
  return verdicts
}

export async function weighCandidates(
  candidates: Candidate[],
  context: Parameters<typeof buildUserPrompt>[1],
): Promise<{ verdicts: AgentVerdict[]; source: 'llm' | 'llm-debate' | 'rules-fallback'; summary: string }> {
  if (!candidates.length) {
    return { verdicts: [], source: 'rules-fallback', summary: 'no candidates passed the pre-filter' }
  }

  // ── debate mode (opt-in): bull vs bear vs judge ──
  if (CONFIG.agentMode === 'debate') {
    try {
      const verdicts = await debateVerdicts(candidates, context)
      const summary = verdicts
        .filter((v) => v.action !== 'HOLD')
        .map((v) => `${v.symbol} ${v.action} (${(v.confidence * 100).toFixed(0)}%) — ${v.reason}`)
        .join(' | ') || 'no actionable setups'
      return { verdicts, source: 'llm-debate', summary }
    } catch (e: any) {
      log('warn', 'AGENT', `debate pipeline failed (${String(e?.message || e).slice(0, 80)}) — falling back to single call`)
    }
  }

  // ── single-call mode (default) ──
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
  const s = ticker.signals
  const ctx: string[] = [
    `Position: ${pos.side} ${pos.symbol} qty=${pos.qty} entry=${pos.entry} opened because: ${pos.rationale}`,
    `Now: price=${ticker.price} pnl=${(pnlPct * 100).toFixed(2)}% funding=${(ticker.fundingRate * 100).toFixed(4)}% OI15m=${ticker.oiChangePct ?? 'n/a'}`,
    `Signals: momentum=${s?.momentum.score} (${s?.momentum.note}) meanRev=${s?.meanRev.score} spread=${s?.spread.score}`,
  ]
  if (s?.confluence) ctx.push(`Confluence: score=${s.confluence.score} agreement=${s.confluence.agreement}/5 stacks={${s.confluence.stacks.map((x) => `${x.name}:${x.score}`).join(' ')}}`)
  if (s?.confluence?.setups.length) ctx.push(`Active setups against the position: ${s.confluence.setups.filter((x) => x.dir === (pos.side === 'LONG' ? -1 : 1) && x.strength >= 0.6).map((x) => x.name).join(', ') || 'none'}`)
  try {
    const text = await callLlm([
      {
        role: 'system',
        content: `You supervise open intraday futures positions (paper mode). Decide whether to EXIT EARLY or HOLD.
Reply STRICT JSON: {"exit": true|false, "reason":"one sentence"}
Exit only when the original thesis is clearly invalidated (opposite momentum shift, funding squeeze against the side, opposing named setup with strength ≥0.7, or confluence stacks flipped hard against the position). Small adverse moves are noise.`,
      },
      { role: 'user', content: ctx.join('\n') },
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
