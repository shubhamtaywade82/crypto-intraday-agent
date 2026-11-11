// Verify dashboard screenshot with vision model (z-ai-web-dev-sdk createVision, backend)
import ZAI from 'z-ai-web-dev-sdk'
import { readFileSync } from 'node:fs'

const file = process.argv[2] || '/tmp/render/dashboard-1.png'
const extra = process.argv[3] || ''
const b64 = readFileSync(file).toString('base64')

const zai = await ZAI.create()
const completion = await zai.chat.completions.createVision({
  model: 'glm-4.6v',
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `This is a screenshot of a crypto trading dashboard web app. ${extra}
Verify and answer concisely:
1. Is the page fully rendered (no blank areas, no error overlay)?
2. Does the market watch table show multiple crypto symbols with prices?
3. Is there a candlestick chart with EMA line overlays visible?
4. Is there an agent activity log feed with colored entries?
5. Are KPI stat cards visible at top (Equity, Daily PnL, etc.)?
6. Any visible UI defects (overlapping text, cut-off elements, placeholder text like NaN/undefined)?
Answer as a short numbered list, then final verdict line: PASS or FAIL.`,
        },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    },
  ],
  thinking: { type: 'disabled' },
})

console.log(completion.choices?.[0]?.message?.content || 'NO RESPONSE')
