// Probe: SUBSCRIBE !ticker@arr on combined stream endpoint, inspect payload fields
const url = 'wss://fstream.binance.com/market/stream'
const ws = new WebSocket(url)
let count = 0
const seen = new Set<string>()
let btcTicker: any = null
const timer = setTimeout(() => {
  console.log(`messages=${count} uniqueSymbols=${seen.size}`)
  console.log('BTCUSDT ticker keys:', btcTicker ? Object.keys(btcTicker).join(',') : 'NOT SEEN')
  if (btcTicker) console.log('BTCUSDT q=', btcTicker.q, 'c=', btcTicker.c, 'P=', btcTicker.P, 'v=', btcTicker.v)
  process.exit(0)
}, 8000)
ws.onopen = () => {
  console.log('OPEN')
  ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: ['!ticker@arr'], id: 1 }))
}
ws.onmessage = (ev) => {
  const raw = String(ev.data)
  let msg: any
  try { msg = JSON.parse(raw) } catch { return }
  if (msg.result !== undefined && msg.id) { console.log('SUBACK:', raw.slice(0, 120)); return }
  if (!msg.stream || !msg.data) return
  count++
  const arr = msg.data
  if (Array.isArray(arr)) {
    for (const t of arr) {
      seen.add(t.s)
      if (t.s === 'BTCUSDT' && !btcTicker) btcTicker = t
    }
  }
}
ws.onerror = () => { console.log('ERR'); clearTimeout(timer); process.exit(1) }
