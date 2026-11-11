// Verify the agentic LLM confluence layer works (z-ai-web-dev-sdk in mini-service context)
import { weighCandidates, type Candidate } from '../mini-services/engine/src/agent'

const cand: Candidate = {
  symbol: 'BTCUSDT',
  price: 73726.1,
  composite: 0.62,
  signals: {
    momentum: { score: 0.7, dir: 1, note: 'EMA gap +0.15%, vol×2.1, OI+0.8%' },
    meanRev: { score: 0.1, dir: 1, note: 'RSI2 46 neutral' },
    spread: { score: 0.5, dir: 1, note: 'funding -0.012% crowded short' },
    composite: 0.62,
  },
  fundingRate: -0.00012,
  oiChangePct: 0.8,
  spreadPct: null,
  inrPrice: 6910000,
  changePct: -0.0125,
}

const t0 = Date.now()
const r = await weighCandidates([cand], {
  equity: 10_000,
  balance: 10_000,
  openPositions: [],
  dailyPnlPct: 0,
})
console.log(`source=${r.source} took=${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log('verdicts:', JSON.stringify(r.verdicts, null, 2))
console.log('summary:', r.summary)
